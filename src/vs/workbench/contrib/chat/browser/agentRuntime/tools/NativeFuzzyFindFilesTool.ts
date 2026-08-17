/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService, FileChangesEvent } from '../../../../../../platform/files/common/files.js';
import { INativeTool } from './INativeTool.js';
import { rustEngine } from '../native/rustEngine.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';

export class NativeFuzzyFindFilesTool extends Disposable implements INativeTool {
	public readonly name = 'fuzzy_find_files';
	public readonly description = 'Search for files by name using Subsequence Scoring (like Cmd+P), powered by the native Rust engine.';
	public readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			query: { type: 'string', minLength: 1, maxLength: 2_000, description: 'The fuzzy text to search for.' },
			cwd: { type: 'string', minLength: 1, maxLength: 32_768, description: 'The absolute path to the directory to search in.' }
		},
		required: ['query', 'cwd']
	};

	private cachedWorkspaces = new Set<string>();
	private readonly workspaceFiles = new Map<string, readonly string[]>();
	private ignoreGuard?: WorkspaceIgnoreGuard;

	constructor(
		@IFileService private readonly fileService: IFileService
	) {
		super();
		this._register(this.fileService.onDidFilesChange((e: FileChangesEvent) => {
			if (this.cachedWorkspaces.size === 0) {return;}
			
			const workspaceGroupings = new Map<string, { added: string[]; removed: string[] }>();
			for (const workspace of this.cachedWorkspaces) {
				workspaceGroupings.set(workspace, { added: [], removed: [] });
			}

			for (const uri of e.rawAdded) {
				const fsPath = uri.fsPath;
				if (this.ignoreGuard && this.ignoreGuard.isIgnored(fsPath)) {continue;}
				for (const workspace of this.cachedWorkspaces) {
					if (fsPath.startsWith(workspace)) {
						workspaceGroupings.get(workspace)!.added.push(fsPath);
					}
				}
			}

			for (const uri of e.rawDeleted) {
				const fsPath = uri.fsPath;
				for (const workspace of this.cachedWorkspaces) {
					if (fsPath.startsWith(workspace)) {
						workspaceGroupings.get(workspace)!.removed.push(fsPath);
					}
				}
			}

			for (const [workspace, { added, removed }] of workspaceGroupings) {
				if (added.length > 0 || removed.length > 0) {
					if (rustEngine.updateWorkspaceCache) {
						rustEngine.updateWorkspaceCache(workspace, added, removed);
					}
				}
			}
		}));
	}

	public setIgnoreGuard(guard: WorkspaceIgnoreGuard) {
		this.ignoreGuard = guard;
	}

	private async getAllFiles(dir: URI, depth = 0, budget = { remaining: 20_000 }): Promise<string[]> {
		const result: string[] = [];
		if (depth > 16 || budget.remaining <= 0) {return result;}
		try {
			const stat = await this.fileService.resolve(dir, { resolveMetadata: false });
			if (stat.children) {
				for (const child of stat.children) {
					const childPath = child.resource.fsPath;
					if (this.ignoreGuard && this.ignoreGuard.isIgnored(childPath)) {
						continue;
					}
					if (child.isDirectory && !child.name.includes('node_modules') && !child.name.startsWith('.')) {
						result.push(...await this.getAllFiles(child.resource, depth + 1, budget));
					} else if (!child.isDirectory) {
						result.push(childPath);
						budget.remaining--;
					}
				}
			}
		} catch (e) {
			// ignore access errors
		}
		return result;
	}

	public async execute(parameters: { query?: string; cwd?: string }, cwd: string): Promise<string> {
		const query = parameters.query;
		const searchCwd = parameters.cwd || cwd;
		if (!query) {
			throw new Error('query is required');
		}

		try {
			const searchRoot = this.ignoreGuard ? await this.ignoreGuard.assertAllowed(searchCwd) : URI.file(searchCwd);
			const canonicalSearchCwd = searchRoot.fsPath;
			if (!this.cachedWorkspaces.has(canonicalSearchCwd)) {
				// Fetch the real workspace file tree once
				const workspaceFiles = await this.getAllFiles(searchRoot);
				rustEngine.setWorkspaceFiles(canonicalSearchCwd, workspaceFiles);
				this.workspaceFiles.set(canonicalSearchCwd, workspaceFiles);
				this.cachedWorkspaces.add(canonicalSearchCwd);
			}

			// Perform search on the Rust cache directly (no array transfer penalty)
			let scoredFiles = await rustEngine.fuzzySearch(query, canonicalSearchCwd);
			if (!scoredFiles.length) {scoredFiles = (this.workspaceFiles.get(canonicalSearchCwd) ?? []).map(file => ({ file, score: fuzzyScore(query, file) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);}

			// Strict truncation to prevent Context Window Explosion (top 20 max)
			const bestMatches = scoredFiles
				.filter(f => f.score > 0)
				.slice(0, 20);

			if (bestMatches.length === 0) {
				return 'No matches found.';
			}

			return `Found ${bestMatches.length} matches:\n` + bestMatches.map(m => `- ${m.file} (Score: ${m.score})`).join('\n');
		} catch (error) {
			return `Error during fuzzy search: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	public override dispose(): void {
		for (const workspace of this.cachedWorkspaces) {rustEngine.deleteWorkspaceFiles(workspace);}
		this.cachedWorkspaces.clear();
		this.workspaceFiles.clear();
		super.dispose();
	}
}

function fuzzyScore(query: string, candidate: string): number {
	const needle = query.toLowerCase();
	const haystack = candidate.replace(/\\/g, '/').toLowerCase();
	let position = 0;
	let score = 0;
	let previous = -2;
	for (const character of needle) {
		const found = haystack.indexOf(character, position);
		if (found < 0) {return 0;}
		score += found === previous + 1 ? 8 : found === 0 || '/_-'.includes(haystack[found - 1]) ? 5 : 1;
		previous = found;
		position = found + 1;
	}
	return score + Math.max(0, 20 - Math.floor(haystack.length / 20));
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
