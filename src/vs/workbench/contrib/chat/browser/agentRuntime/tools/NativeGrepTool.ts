/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { ITextSearchMatch, ITextQuery, ISearchService, QueryType, resultIsMatch } from '../../../../../services/search/common/search.js';
import { INativeTool } from './INativeTool.js';
import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';
import { isAbsolute } from '../../../../../../base/common/path.js';

export class NativeGrepTool implements INativeTool {
	public readonly name = 'grep';
	public readonly description = 'Search exact text or a regular expression through Code-OSS native search.';
	public readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			query: { type: 'string', minLength: 1, maxLength: 2_000, description: 'Search term or regular expression.' },
			path: { type: 'string', maxLength: 32_768, description: 'Workspace-relative or absolute folder path.' },
			isRegex: { type: 'boolean', description: 'Treat query as a regular expression.' },
			caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching.' },
			includes: { type: 'string', maxLength: 2_000, description: 'Optional glob filter, for example *.ts or src/**.' }
		},
		required: ['query']
	};

	private ignoreGuard?: WorkspaceIgnoreGuard;
	constructor(@ISearchService private readonly searchService: ISearchService) { }
	public setIgnoreGuard(guard: WorkspaceIgnoreGuard): void { this.ignoreGuard = guard; }

	public async execute(parameters: { query?: string; path?: string; isRegex?: boolean; caseSensitive?: boolean; includes?: string }, cwd: string): Promise<string> {
		const queryText = parameters.query?.trim();
		if (!queryText) {throw new Error('query parameter is required');}

		const root = URI.file(cwd);
		const requested = parameters.path ? (isAbsolute(parameters.path) ? parameters.path : URI.joinPath(root, parameters.path).fsPath) : cwd;
		const target = this.ignoreGuard ? await this.ignoreGuard.assertAllowed(requested) : URI.file(requested);

		try {
			// ISearchService delegates to Code-OSS' native search provider/ripgrep
			// without importing Node-only modules into the Workbench bundle.
			const searchQuery: ITextQuery = {
				type: QueryType.Text,
				folderQueries: [{ folder: target }],
				contentPattern: {
					pattern: queryText,
					isRegExp: parameters.isRegex === true,
					isCaseSensitive: parameters.caseSensitive === true,
				},
				includePattern: parameters.includes?.trim() ? { [parameters.includes.trim()]: true } : undefined,
				excludePattern: { '**/.env': true, '**/.env.*': true, '**/*.pem': true, '**/*.key': true, '**/*.p12': true, '**/*.pfx': true, '**/credentials.json': true, '**/secrets.json': true, '**/id_rsa': true, '**/id_ed25519': true, '**/.npmrc': true, '**/.pypirc': true },
				maxResults: 5000,
				previewOptions: { matchLines: 1, charsPerLine: 300 },
			};
			const complete = await this.searchService.textSearch(searchQuery);
			const matches: Array<{ file: string; line: number; column: number; preview: string }> = [];
			for (const fileMatch of complete.results) {
				if (this.ignoreGuard) {
					try { await this.ignoreGuard.assertAllowed(fileMatch.resource.fsPath); } catch { continue; }
				}
				for (const result of fileMatch.results ?? []) {
					if (!resultIsMatch(result)) {continue;}
					const match = result as ITextSearchMatch<URI>;
					const range = match.rangeLocations[0];
					matches.push({ file: fileMatch.resource.fsPath, line: (range?.source.startLineNumber ?? 0) + 1, column: (range?.source.startColumn ?? 0) + 1, preview: match.previewText });
				}
			}
			if (!matches.length) {return 'No matches found.';}

			const totalLabel = complete.limitHit ? `at least ${matches.length}` : String(matches.length);
			const visible = matches.slice(0, 100).map(match => `[Match] ${relativePath(match.file, cwd)}:${match.line}:${match.column}: ${match.preview}`);
			let output = `Found ${totalLabel} match${matches.length === 1 ? '' : 'es'} for "${queryText}":\nShowing first ${visible.length} matches:\n${visible.join('\n')}`;
			if (complete.limitHit || matches.length > 100) {
				output += `\n\n[TRUNCATED]: Too many results (${totalLabel}). Showing first 100.\nTo get better results, call grep again with a more specific 'path', 'includes' or regex.`;
			}
			return output;
		} catch (error) {
			return `Error executing grep: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}

function relativePath(filePath: string, cwd: string): string {
	const file = filePath.replace(/\\/g, '/');
	const root = cwd.replace(/\\/g, '/').replace(/\/$/, '');
	return file.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? file.slice(root.length + 1) : file;
}
