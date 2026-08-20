/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * NAPI-RS / WebAssembly Rust engine bindings.
 * This bridges the TypeScript code to the high-performance Cursor-like Rust backend.
 */

export interface HybridSearchResult {
	filePath: string;
	lineStart: number;
	lineEnd: number;
	score: number;
	snippet: string;
}

export interface DiffResult {
	success: boolean;
	content?: string;
	error?: string;
}

// Define the shape of our native module
interface NativeEngine {
	applySearchReplaceBlocks(originalContent: string, diffContent: string, filePath?: string): DiffResult;
	setWorkspaceFiles(cwd: string, files: string[]): void;
	deleteWorkspaceFiles(cwd: string): void;
	fuzzySearch(query: string, cwd: string): { file: string; score: number }[];
	hybridSearch(query: string, cwd: string): string[];
	updateWorkspaceCache?(cwd: string, added: string[], removed: string[]): void;
}

interface NativeRagEngine {
	indexProject(cwd: string, excluded?: string[]): Promise<number>;
	indexFile?(cwd: string, filePath: string, excluded?: string[]): Promise<number>;
	deleteFile?(cwd: string, filePath: string): Promise<number>;
	renameFile?(cwd: string, oldPath: string, newPath: string, excluded?: string[]): Promise<number>;
	applyFileEvents?(cwd: string, upsertPaths: string[], deletedPaths: string[], excluded?: string[]): Promise<number>;
	cancelIndexProject?(cwd: string): void;
	hybridSearch(cwd: string, query: string, config?: { topK?: number; similarityThreshold?: number }): Promise<string>;
	getIndexStats?(cwd: string): string;
	validateIndex?(cwd: string, autoRebuild?: boolean): Promise<string>;
	listIndexedFiles?(cwd: string): string;
	setModelDownloadAllowed?(allowed: boolean): void;
	getModelStatus?(): string;
	installModel?(allowDownload?: boolean): Promise<void>;
}

interface NativeRagResult {
	file_path?: unknown;
	filePath?: unknown;
	line_start?: unknown;
	lineStart?: unknown;
	line_end?: unknown;
	lineEnd?: unknown;
	rrf_score?: unknown;
	score?: unknown;
	content?: unknown;
	snippet?: unknown;
}

interface WorkspaceIndexState {
	dirty: boolean;
	inFlight?: Promise<void>;
}

export class RustEngine {
	private nativeModule: NativeEngine | null = null;
	private ragModule: NativeRagEngine | null = null;
	private loadAttempted = false;
	private readonly workspaceIndices = new Map<string, WorkspaceIndexState>();
	private readonly ragPolicy = new Map<string, boolean>();
	private readonly workspaceExclusions = new Map<string, readonly string[]>();

	constructor() {
		this.tryLoadNativeModule();
	}

	private tryLoadNativeModule() {
		if (this.loadAttempted) {
			return;
		}
		this.loadAttempted = true;
		const moduleBuiltin = typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
			? process.getBuiltinModule('module')
			: undefined;
		const nodeRequire = moduleBuiltin?.createRequire?.(import.meta.url) ?? (typeof require === 'function' ? require : undefined);
		if (!nodeRequire) {
			console.warn('Native Rust engines are unavailable because this runtime does not expose a Node module loader.');
			return;
		}
		try {
			const modulePath = '../native-backend/index.js';
			this.nativeModule = nodeRequire(modulePath);
			console.log('Successfully loaded Native Rust Engine (fuzzy/diff).');
		} catch (e) {
			console.warn('Could not load Native Rust Engine. Falling back to stubs.', e);
		}

		try {
			// The native package ships beside the source tree and beside the compiled `out` tree.
			this.ragModule = nodeRequire('../../../../../../../../folzeur-rag-native');
			console.log('Successfully loaded Native RAG Engine.');
		} catch (e) {
			console.warn('Could not load Native RAG Engine.', e);
		}
	}

	/**
	 * Safe diff application using Native engine.
	 */
	public applySearchReplaceBlocks(originalContent: string, diffContent: string, filePath?: string): DiffResult {
		if (this.nativeModule) {
			return this.nativeModule.applySearchReplaceBlocks(originalContent, diffContent, filePath);
		}
		return applyExactSearchReplaceFallback(originalContent, diffContent);
	}

	/**
	 * Set Workspace files for native cache to prevent FFI bottleneck
	 */
	public setWorkspaceFiles(cwd: string, files: string[]) {
		if (this.nativeModule) {
			this.nativeModule.setWorkspaceFiles(cwd, files);
		}
	}

	/**
	 * Delete Workspace files from native cache to free memory
	 */
	public deleteWorkspaceFiles(cwd: string) {
		if (this.nativeModule) {
			this.nativeModule.deleteWorkspaceFiles(cwd);
		}
	}

	public updateWorkspaceCache(cwd: string, added: string[], removed: string[]) {
		if (this.nativeModule && this.nativeModule.updateWorkspaceCache) {
			this.nativeModule.updateWorkspaceCache(cwd, added, removed);
		}
	}

	/** Marks the persistent RAG index stale after a workspace file event. */
	public markWorkspaceDirty(cwd: string): void {
		const state = this.workspaceIndices.get(cwd);
		if (state) {
			state.dirty = true;
		} else {
			this.workspaceIndices.set(cwd, { dirty: true });
		}
	}

	public setWorkspaceExclusions(cwd: string, patterns: readonly string[]): void {
		this.workspaceExclusions.set(cwd, [...new Set(patterns)]);
	}

	public async applyWorkspaceFileEvents(cwd: string, upsertPaths: readonly string[], deletedPaths: readonly string[]): Promise<void> {
		if (!this.ragModule || this.ragPolicy.get(cwd) === false || (!upsertPaths.length && !deletedPaths.length)) {
			return;
		}
		await this.ensureWorkspaceIndexed(cwd);
		const excluded = [...(this.workspaceExclusions.get(cwd) ?? [])];
		if (this.ragModule.applyFileEvents) {
			await this.ragModule.applyFileEvents(cwd, [...upsertPaths], [...deletedPaths], excluded);
			return;
		}
		for (const path of deletedPaths) {
			await this.ragModule.deleteFile?.(cwd, path);
		}
		for (const path of upsertPaths) {
			await this.ragModule.indexFile?.(cwd, path, excluded);
		}
	}

	public cancelWorkspaceIndexing(cwd: string): void {
		const state = this.workspaceIndices.get(cwd);
		if (state) {state.dirty = true;}
		this.ragModule?.cancelIndexProject?.(cwd);
	}

	public setWorkspaceRagEnabled(cwd: string, enabled: boolean): void {
		this.ragPolicy.set(cwd, enabled);
		if (!enabled) {this.cancelWorkspaceIndexing(cwd);}
	}

	public setModelDownloadAllowed(allowed: boolean): void {this.ragModule?.setModelDownloadAllowed?.(allowed);}

	public async awaitWorkspaceIndex(cwd: string): Promise<void> {await this.ensureWorkspaceIndexed(cwd);}

	public async getIndexPrivacyReport(cwd: string): Promise<{ health: unknown; files: string[]; model: unknown }> {
		if (!this.ragModule) {return { health: { status: 'native_module_unavailable' }, files: [], model: { state: 'unavailable' } };}
		const health = this.ragModule.validateIndex ? JSON.parse(await this.ragModule.validateIndex(cwd, false)) : { status: 'validation_unavailable' };
		const fileState = this.ragModule.listIndexedFiles ? JSON.parse(this.ragModule.listIndexedFiles(cwd)) as { files?: string[] } : {};
		const model = this.ragModule.getModelStatus ? JSON.parse(this.ragModule.getModelStatus()) : { state: 'unknown' };
		return { health, files: fileState.files ?? [], model };
	}

	public async rebuildWorkspaceIndex(cwd: string): Promise<void> {
		if (!this.ragModule) {throw new Error('Native RAG module is unavailable.');}
		this.markWorkspaceDirty(cwd);
		await this.ensureWorkspaceIndexed(cwd);
	}

	public async installEmbeddingModel(): Promise<void> {
		if (!this.ragModule?.installModel) {throw new Error('Native model manager is unavailable.');}
		await this.ragModule.installModel(true);
	}

	public warmWorkspaceIndex(cwd: string): void {
		if (this.ragPolicy.get(cwd) === false) {return;}
		void this.ensureWorkspaceIndexed(cwd).catch(error => {
			console.warn('Background RAG warmup failed; search will use the local fallback', error);
		});
	}

	private async ensureWorkspaceIndexed(cwd: string): Promise<void> {
		if (this.ragPolicy.get(cwd) === false) {return;}
		if (!this.ragModule) {
			return;
		}
		const state = this.workspaceIndices.get(cwd) ?? { dirty: true };
		this.workspaceIndices.set(cwd, state);
		if (state.inFlight) {
			await state.inFlight;
			return;
		}
		if (!state.dirty) {
			return;
		}
		state.inFlight = (async () => {
			do {
				state.dirty = false;
				await this.ragModule!.indexProject(cwd, [...(this.workspaceExclusions.get(cwd) ?? [])]);
			} while (state.dirty);
		})().finally(() => state.inFlight = undefined);
		await state.inFlight;
	}

	/**
	 * Subsequence Scoring (Fuzzy Matching) using native fuzzy-matcher on the stateful cache.
	 */
	public fuzzySearch(query: string, cwd: string): { file: string; score: number }[] {
		if (this.nativeModule) {
			return this.nativeModule.fuzzySearch(query, cwd);
		}
		
		return [];
	}

	/**
	 * Performs a hybrid search (BM25 + Semantic) across the codebase.
	 */
	public async hybridSearch(query: string, cwd: string, topK = 10): Promise<HybridSearchResult[]> {
		if (this.ragModule && this.ragPolicy.get(cwd) !== false) {
			try {
				await this.ensureWorkspaceIndexed(cwd);
				const raw: unknown = await this.ragModule.hybridSearch(cwd, query, { topK });
				const results: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
				if (!Array.isArray(results)) {
					throw new TypeError('Native RAG returned a non-array result');
				}
				return results.map(parseRagResult).filter((result): result is HybridSearchResult => result !== undefined);
			} catch (e) {
				console.warn('RAG search unavailable; using TypeScript fallback', e);
				throw e;
			}
		}
		
		return [];
	}
}

/** Conservative browser-safe fallback used when the N-API module loader is unavailable. */
function applyExactSearchReplaceFallback(originalContent: string, diffContent: string): DiffResult {
	const pattern = /<<<<<<< SEARCH\r?\n(?:(?::(?:start_line|end_line):[^\r\n]*\r?\n)*)(?:-------\r?\n)?([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
	const lineEnding = originalContent.includes('\r\n') ? '\r\n' : '\n';
	const blocks: Array<{ start: number; end: number; replacement: string }> = [];
	let match: RegExpExecArray | null;
	let parsedUntil = 0;
	while ((match = pattern.exec(diffContent))) {
		if (diffContent.slice(parsedUntil, match.index).trim()) {return { success: false, error: 'Malformed text outside SEARCH/REPLACE blocks.' };}
		parsedUntil = pattern.lastIndex;
		const search = match[1].replace(/\r?\n/g, lineEnding);
		const replacement = match[2].replace(/\r?\n/g, lineEnding);
		if (!search) {return { success: false, error: 'Empty SEARCH content is not allowed.' };}
		const occurrences: number[] = [];
		let offset = 0;
		while ((offset = originalContent.indexOf(search, offset)) >= 0) { occurrences.push(offset); offset += Math.max(1, search.length); }
		if (occurrences.length !== 1) {return { success: false, error: occurrences.length ? `Ambiguous SEARCH block (${occurrences.length} matches).` : `Could not find exact SEARCH block:\n${search}` };}
		const block = { start: occurrences[0], end: occurrences[0] + search.length, replacement };
		if (blocks.some(existing => block.start < existing.end && block.end > existing.start)) {return { success: false, error: 'Overlapping SEARCH blocks detected.' };}
		blocks.push(block);
	}
	if (!blocks.length || diffContent.slice(parsedUntil).trim()) {return { success: false, error: 'No valid SEARCH/REPLACE blocks found.' };}
	let content = originalContent;
	for (const block of blocks.sort((a, b) => b.start - a.start)) {content = content.slice(0, block.start) + block.replacement + content.slice(block.end);}
	return { success: true, content };
}

function parseRagResult(value: unknown): HybridSearchResult | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const result = value as NativeRagResult;
	const filePath = typeof (result.file_path ?? result.filePath) === 'string' ? String(result.file_path ?? result.filePath) : '';
	const lineStart = Number(result.line_start ?? result.lineStart);
	const lineEnd = Number(result.line_end ?? result.lineEnd ?? lineStart);
	const score = Number(result.rrf_score ?? result.score ?? 0);
	const snippetValue = result.content ?? result.snippet;
	if (!filePath || !Number.isInteger(lineStart) || lineStart < 1 || !Number.isInteger(lineEnd) || lineEnd < lineStart || typeof snippetValue !== 'string') {
		return undefined;
	}
	return { filePath, lineStart, lineEnd, score: Number.isFinite(score) ? score : 0, snippet: snippetValue };
}

export const rustEngine = new RustEngine();
