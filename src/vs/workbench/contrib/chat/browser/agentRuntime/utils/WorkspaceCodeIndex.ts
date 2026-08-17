/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { rustEngine } from '../native/rustEngine.js';
import { isSensitivePath } from './SecretProtection.js';

export type CodeSymbolType = 'function' | 'class' | 'method' | 'variable';
export interface CodeSearchResult { readonly filePath: string; readonly lineStart: number; readonly lineEnd: number; readonly snippet: string; readonly score: number; readonly symbol?: string; readonly symbolType?: CodeSymbolType }
export interface IndexStats { readonly filesDiscovered: number; readonly filesIndexed: number; readonly filesDeferredToNativeIndex: number; readonly chunksCreated: number; readonly chunksDeleted: number; readonly queueSize: number; readonly durationMs: number; readonly errors: number }

interface CodeChunk { readonly id: string; readonly filePath: string; readonly startLine: number; readonly endLine: number; readonly content: string; readonly symbol?: string; readonly symbolType?: CodeSymbolType; readonly terms: Map<string, number>; readonly length: number }
interface ManifestEntry { hash: string; chunkIds: string[] }
interface DeferredDocument { readonly hash: string; readonly terms: readonly string[] }
interface PersistedIndex { version: 1 | 2; manifest: Record<string, { hash: string; chunkIds: string[] }>; chunks: Array<Omit<CodeChunk, 'terms'> & { terms: Record<string, number> }>; deferred?: Record<string, DeferredDocument> }

const CHUNK_SIZE = 100;
const OVERLAP = 20;
const MAX_FILE_BYTES = 2_000_000;
const MAX_PERSISTED_INDEX_BYTES = 128_000_000;
const INDEX_FILE = '.folzeur/workspace-index.json';

/** Incremental local BM25 index. Mutations replace one file atomically and never rebuild the workspace on save. */
export class WorkspaceCodeIndex extends Disposable {
	private readonly chunks = new Map<string, CodeChunk>();
	private readonly fileChunks = new Map<string, Set<string>>();
	private readonly inverted = new Map<string, Set<string>>();
	private readonly documentFrequency = new Map<string, number>();
	private readonly manifest = new Map<string, ManifestEntry>();
	private readonly catalog = new Set<string>();
	private readonly deferredToNativeIndex = new Set<string>();
	private readonly deferredDocuments = new Map<string, DeferredDocument>();
	private readonly deferredInverted = new Map<string, Set<string>>();
	private readonly queue = new Set<string>();
	private processing = false;
	private debounceHandle: ReturnType<typeof setTimeout> | undefined;
	private activeController: AbortController | undefined;
	private readyPromise: Promise<void>;
	private ignoredPatterns: string[] = [];
	private totalLength = 0;
	private errors = 0;
	private chunksCreated = 0;
	private chunksDeleted = 0;
	private lastDurationMs = 0;
	private cancelled = false;
	private workCancelled = false;
	private readonly hotCacheCharacterBudget = computeHotCacheCharacterBudget();

	constructor(private readonly fileService: IFileService, private readonly workspace: URI) {
		super();
		this.readyPromise = this.restore();
		this._register(fileService.onDidFilesChange(event => {
			for (const resource of event.rawAdded) {this.enqueue(resource);}
			for (const resource of event.rawUpdated) {this.enqueue(resource);}
			for (const resource of event.rawDeleted) {this.enqueue(resource, true);}
		}));
	}

	async ready(): Promise<void> { await this.readyPromise; }
	public cancelCurrentWork(): void {
		this.workCancelled = true;
		if (this.debounceHandle) {clearTimeout(this.debounceHandle);}
		this.debounceHandle = undefined;
		this.activeController?.abort();
		this.queue.clear();
		try { rustEngine.cancelWorkspaceIndexing(this.workspace.fsPath); } catch { /* native cancellation is best effort during disposal */ }
	}
	public resumeCurrentWork(): void {
		if (this.cancelled || !this.workCancelled) {return;}
		this.workCancelled = false;
		void this.rescan();
	}

	public override dispose(): void {
		this.cancelled = true;
		this.cancelCurrentWork();
		super.dispose();
	}

	getStats(): IndexStats { return { filesDiscovered: this.catalog.size, filesIndexed: this.manifest.size, filesDeferredToNativeIndex: this.deferredToNativeIndex.size, chunksCreated: this.chunksCreated, chunksDeleted: this.chunksDeleted, queueSize: this.queue.size, durationMs: this.lastDurationMs, errors: this.errors }; }

	search(query: string, limit = 8): readonly CodeSearchResult[] {
		const terms = tokenize(query);
		if (!terms.length || !this.chunks.size) {return [];}
		const candidates = new Set<string>();
		for (const term of new Set(terms)) {for (const id of this.inverted.get(term) ?? []) {candidates.add(id);}}
		const averageLength = this.chunks.size ? this.totalLength / this.chunks.size : 1;
		const scored = [...candidates].map(id => {
			const chunk = this.chunks.get(id)!;
			let score = 0;
			for (const term of terms) {
				const frequency = chunk.terms.get(term) ?? 0;
				if (!frequency) {continue;}
				const df = this.documentFrequency.get(term) ?? 0;
				const idf = Math.log(1 + (this.chunks.size - df + 0.5) / (df + 0.5));
				score += idf * (frequency * 2.2) / (frequency + 1.2 * (0.7 + 0.3 * chunk.length / averageLength));
			}
			const lowerQuery = query.toLowerCase();
			if (chunk.filePath.toLowerCase().includes(lowerQuery)) {score *= 1.8;}
			if (chunk.symbol?.toLowerCase() === lowerQuery) {score *= 3;}
			else if (chunk.symbol?.toLowerCase().includes(lowerQuery)) {score *= 1.6;}
			return { chunk, score };
		}).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
		return scored.map(({ chunk, score }) => ({ filePath: chunk.filePath, lineStart: chunk.startLine, lineEnd: chunk.endLine, snippet: chunk.content, score, symbol: chunk.symbol, symbolType: chunk.symbolType }));
	}

	/** Searches the hot BM25 cache and materializes only the best cold candidates. */
	async searchAll(query: string, limit = 8): Promise<readonly CodeSearchResult[]> {
		const hot = [...this.search(query, limit * 2)];
		const terms = [...new Set(tokenize(query))];
		if (!terms.length || !this.deferredDocuments.size) {return hot.slice(0, limit);}
		const candidateScores = new Map<string, number>();
		for (const term of terms) {
			for (const file of this.deferredInverted.get(term) ?? []) {candidateScores.set(file, (candidateScores.get(file) ?? 0) + 1);}
		}
		const candidates = [...candidateScores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.max(24, limit * 12));
		const cold: CodeSearchResult[] = [];
		for (let offset = 0; offset < candidates.length; offset += 8) {
			await Promise.all(candidates.slice(offset, offset + 8).map(async ([file, termScore]) => {
				try {
					const content = (await this.fileService.readFile(URI.joinPath(this.workspace, file))).value.toString();
					const chunks = makeChunks(file, content);
					for (const result of scoreColdChunks(query, chunks, Math.max(2, Math.ceil(limit / 2)))) {cold.push({ ...result, score: result.score + termScore });}
				} catch { this.errors++; }
			}));
		}
		return [...hot, ...cold].sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath)).filter((result, index, all) => all.findIndex(candidate => candidate.filePath === result.filePath && candidate.lineStart === result.lineStart && candidate.lineEnd === result.lineEnd) === index).slice(0, limit);
	}

	async verifyIndex(): Promise<{ valid: boolean; errors: string[] }> {
		const errors: string[] = [];
		for (const [file, entry] of this.manifest) {
			const ids = this.fileChunks.get(file);
			if (!ids || ids.size !== entry.chunkIds.length) {errors.push(`Manifest mismatch: ${file}`);}
			for (const id of entry.chunkIds) {if (!this.chunks.has(id)) {errors.push(`Missing chunk: ${id}`);}}
		}
		for (const [term, ids] of this.inverted) {for (const id of ids) {if (!this.chunks.get(id)?.terms.has(term)) {errors.push(`Inverted index mismatch: ${term}/${id}`);}}}
		return { valid: errors.length === 0, errors };
	}

	private enqueue(resource: URI, deleted = false): void {
		if (this.cancelled || this.workCancelled) {return;}
		if (!resource.path.startsWith(this.workspace.path) || isIgnored(resource.path, this.workspace.path, this.ignoredPatterns)) {
			return;
		}
		rustEngine.markWorkspaceDirty(this.workspace.fsPath);
		const key = resource.toString();
		this.queue.add(deleted ? `!${key}` : key);
		this.activeController?.abort();
		if (this.debounceHandle) {clearTimeout(this.debounceHandle);}
		this.debounceHandle = setTimeout(() => void this.processQueue(), 180);
	}

	private async processQueue(): Promise<void> {
		if (this.cancelled || this.workCancelled || this.processing) {return;}
		this.processing = true;
		const started = Date.now();
		this.activeController = new AbortController();
		try {
			while (this.queue.size && !this.workCancelled) {
				const batch = [...this.queue].splice(0, 16);
				batch.forEach(key => this.queue.delete(key));
				for (let offset = 0; offset < batch.length; offset += 8) {
					if (this.activeController.signal.aborted || this.workCancelled) {return;}
					await Promise.all(batch.slice(offset, offset + 8).map(key => {
						const deleted = key.startsWith('!');
						return this.updateFile(URI.parse(deleted ? key.slice(1) : key), deleted, this.activeController!.signal);
					}));
				}
			}
			await this.persist();
		} finally {
			this.lastDurationMs = Date.now() - started;
			this.activeController = undefined;
			this.processing = false;
			if (this.queue.size && !this.workCancelled) {void this.processQueue();}
		}
	}

	private async updateFile(resource: URI, deleted: boolean, signal: AbortSignal): Promise<void> {
		const file = relativePath(resource, this.workspace);
		if (this.workCancelled) {return;}
		if (deleted) { this.catalog.delete(file); this.deferredToNativeIndex.delete(file); this.removeFile(file); return; }
		this.catalog.add(file);
		try {
			const raw = (await this.fileService.readFile(resource)).value;
			if (signal.aborted || this.workCancelled) {return;}
			const content = raw.toString();
			if (content.length > MAX_FILE_BYTES || isBinary(content) || isIgnored(file, this.workspace.path, this.ignoredPatterns)) { this.removeFile(file); return; }
			const hash = hashText(content);
			if (this.manifest.get(file)?.hash === hash || this.deferredDocuments.get(file)?.hash === hash) {return;}
			const next = makeChunks(file, content);
			this.replaceFile(file, hash, next);
		} catch { this.errors++; }
	}

	private replaceFile(file: string, hash: string, next: CodeChunk[]): void {
		this.removeFile(file);
		if (this.totalLength + next.reduce((total, chunk) => total + chunk.length, 0) > this.hotCacheCharacterBudget) {
			// The Rust Tantivy/LanceDB index is exhaustive and disk-backed. The TS
			// layer deliberately becomes a hot cache instead of silently stopping
			// after an arbitrary number of workspace files.
			this.deferredToNativeIndex.add(file);
			this.addDeferredDocument(file, { hash, terms: [...new Set(next.flatMap(chunk => [...chunk.terms.keys()]))] });
			return;
		}
		this.deferredToNativeIndex.delete(file);
		const ids: string[] = [];
		for (const chunk of deduplicate(next)) {
			this.chunks.set(chunk.id, chunk); ids.push(chunk.id); this.chunksCreated++; this.totalLength += chunk.length;
			for (const term of chunk.terms.keys()) { const idsForTerm = this.inverted.get(term) ?? new Set<string>(); idsForTerm.add(chunk.id); this.inverted.set(term, idsForTerm); this.documentFrequency.set(term, idsForTerm.size); }
		}
		this.fileChunks.set(file, new Set(ids));
		this.manifest.set(file, { hash, chunkIds: ids });
	}

	private removeFile(file: string): void {
		this.removeDeferredDocument(file);
		const ids = this.fileChunks.get(file);
		if (!ids) {return;}
		for (const id of ids) {
			const chunk = this.chunks.get(id); if (!chunk) {continue;}
			this.totalLength -= chunk.length; this.chunks.delete(id); this.chunksDeleted++;
			for (const term of chunk.terms.keys()) { const termIds = this.inverted.get(term); termIds?.delete(id); if (!termIds?.size) { this.inverted.delete(term); this.documentFrequency.delete(term); } else {this.documentFrequency.set(term, termIds.size);} }
		}
		this.fileChunks.delete(file); this.manifest.delete(file);
	}

	private addDeferredDocument(file: string, document: DeferredDocument): void {
		this.removeDeferredDocument(file);
		this.deferredDocuments.set(file, document);
		this.deferredToNativeIndex.add(file);
		for (const term of document.terms) {
			const files = this.deferredInverted.get(term) ?? new Set<string>();
			files.add(file);
			this.deferredInverted.set(term, files);
		}
	}

	private removeDeferredDocument(file: string): void {
		const document = this.deferredDocuments.get(file);
		if (!document) {return;}
		for (const term of document.terms) {
			const files = this.deferredInverted.get(term);
			files?.delete(file);
			if (!files?.size) {this.deferredInverted.delete(term);}
		}
		this.deferredDocuments.delete(file);
		this.deferredToNativeIndex.delete(file);
	}

	private async restore(): Promise<void> {
		for (const name of ['.gitignore', '.folzeurignore']) {
			try {
				const ignore = await this.fileService.readFile(URI.joinPath(this.workspace, name));
				this.ignoredPatterns.push(...ignore.value.toString().split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
			} catch { /* optional ignore file */ }
		}
		this.ignoredPatterns = [...new Set(this.ignoredPatterns)];
		try {
			const resource = URI.joinPath(this.workspace, INDEX_FILE);
			const stat = await this.fileService.resolve(resource, { resolveMetadata: true });
			if (Number(stat.size ?? 0) > MAX_PERSISTED_INDEX_BYTES) {throw new Error('Persisted fallback index exceeds its resource budget.');}
			const data = JSON.parse((await this.fileService.readFile(resource)).value.toString()) as PersistedIndex;
			if (data.version !== 1 && data.version !== 2) {return;}
			for (const raw of data.chunks) { if (this.totalLength >= this.hotCacheCharacterBudget || isIgnored(raw.filePath, this.workspace.path, this.ignoredPatterns)) {continue;} const chunk = { ...raw, terms: new Map(Object.entries(raw.terms)) }; this.chunks.set(chunk.id, chunk); this.totalLength += chunk.length; for (const term of chunk.terms.keys()) { const ids = this.inverted.get(term) ?? new Set<string>(); ids.add(chunk.id); this.inverted.set(term, ids); this.documentFrequency.set(term, ids.size); } }
			for (const [file, entry] of Object.entries(data.manifest)) { if (isIgnored(file, this.workspace.path, this.ignoredPatterns)) {continue;} this.catalog.add(file); const existingIds = entry.chunkIds.filter(id => this.chunks.has(id)); if (!existingIds.length) { this.deferredToNativeIndex.add(file); continue; } this.manifest.set(file, { ...entry, chunkIds: existingIds }); this.fileChunks.set(file, new Set(existingIds)); }
			for (const [file, document] of Object.entries(data.deferred ?? {})) {
				if (isIgnored(file, this.workspace.path, this.ignoredPatterns) || !document || typeof document.hash !== 'string' || !Array.isArray(document.terms)) {continue;}
				this.catalog.add(file);
				this.deferredToNativeIndex.add(file);
				this.addDeferredDocument(file, { hash: document.hash, terms: document.terms.filter(term => typeof term === 'string') });
			}
		} catch { /* first run or interrupted persistence */ }
		await this.rescan();
	}

	private async rescan(): Promise<void> {
		const files = new Set<string>();
		await this.collect(this.workspace, 0, resource => { files.add(relativePath(resource, this.workspace)); this.enqueue(resource); });
		if (this.cancelled || this.workCancelled) {return;}
		for (const file of this.catalog) {if (!files.has(file)) { this.catalog.delete(file); this.removeFile(file); }}
		if (this.queue.size) {await this.processQueue();}
	}

	private async persist(): Promise<void> {
		const persistedChunks: PersistedIndex['chunks'] = [];
		const persistedIds = new Set<string>();
		let estimatedBytes = 0;
		const payloadBudget = Math.floor(MAX_PERSISTED_INDEX_BYTES * 0.72);
		for (const chunk of this.chunks.values()) {
			const persisted = { ...chunk, terms: Object.fromEntries(chunk.terms) };
			const bytes = JSON.stringify(persisted).length + 1;
			if (estimatedBytes + bytes > payloadBudget) {break;}
			persistedChunks.push(persisted);
			persistedIds.add(chunk.id);
			estimatedBytes += bytes;
		}
		const manifest: PersistedIndex['manifest'] = {};
		for (const [file, entry] of this.manifest) {
			const chunkIds = entry.chunkIds.filter(id => persistedIds.has(id));
			if (chunkIds.length) {manifest[file] = { hash: entry.hash, chunkIds };}
		}
		const deferred: Record<string, DeferredDocument> = {};
		for (const [file, document] of this.deferredDocuments) {
			const bytes = JSON.stringify(document).length + file.length;
			if (estimatedBytes + bytes > payloadBudget) {break;}
			deferred[file] = document;
			estimatedBytes += bytes;
		}
		const snapshot: PersistedIndex = { version: 2, manifest, chunks: persistedChunks, deferred };
		const folder = URI.joinPath(this.workspace, '.folzeur');
		const resource = URI.joinPath(this.workspace, INDEX_FILE);
		const temporary = URI.joinPath(this.workspace, `${INDEX_FILE}.tmp`);
		await this.fileService.createFolder(folder);
		await this.fileService.writeFile(temporary, VSBuffer.fromString(JSON.stringify(snapshot)));
		await this.fileService.move(temporary, resource, true);
	}

	private async collect(resource: URI, depth: number, accept: (resource: URI) => void): Promise<void> {
		if (this.cancelled || this.workCancelled || depth > 64) {return;}
		try {
			const stat = await this.fileService.resolve(resource);
			if (stat.isDirectory) {
				const children = (stat.children ?? []).filter(child => !isIgnored(child.name, resource.path, this.ignoredPatterns));
				for (let offset = 0; offset < children.length; offset += 16) {
					if (this.cancelled || this.workCancelled) {return;}
					await Promise.all(children.slice(offset, offset + 16).map(child => this.collect(child.resource, depth + 1, accept)));
				}
			} else if (isIndexable(resource.path)) {accept(resource);}
		} catch { this.errors++; }
	}
}

function makeChunks(filePath: string, content: string): CodeChunk[] {
	const lines = content.split(/\r?\n/); const result: CodeChunk[] = [];
	for (let start = 0; start < lines.length; start += CHUNK_SIZE - OVERLAP) { const end = Math.min(lines.length, start + CHUNK_SIZE); const text = lines.slice(start, end).join('\n'); result.push(createChunk(filePath, start + 1, end, text)); if (end === lines.length) {break;} }
	for (const symbol of findSymbols(lines)) { const end = Math.min(lines.length, symbol.start + 1 + findBodyLength(lines.slice(symbol.start))); const text = lines.slice(symbol.start, end).join('\n'); if (text.length > 50) {result.push(createChunk(filePath, symbol.start + 1, end, text, symbol.name, symbol.type));} }
	return result;
}

function createChunk(filePath: string, startLine: number, endLine: number, content: string, symbol?: string, symbolType?: CodeSymbolType): CodeChunk { const id = hashText(`${filePath}:${startLine}:${endLine}:${content}`); const terms = termCounts(`${filePath} ${symbol ?? ''} ${content}`); return { id, filePath, startLine, endLine, content, symbol, symbolType, terms, length: content.length }; }
function findSymbols(lines: string[]): Array<{ start: number; name: string; type: CodeSymbolType }> { const out: Array<{ start: number; name: string; type: CodeSymbolType }> = []; const re = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|def|fn|struct|trait)\s+([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/; for (let i = 0; i < lines.length; i++) { const match = re.exec(lines[i]); if (!match) {continue;} const name = match[1] ?? match[2]; const type: CodeSymbolType = /\bclass\b/.test(lines[i]) ? 'class' : /\bfunction\b|\bdef\b|\bfn\b/.test(lines[i]) ? 'function' : 'method'; out.push({ start: i, name, type }); } return out; }
function findBodyLength(lines: string[]): number { let depth = 0; let seen = false; for (let i = 0; i < Math.min(lines.length, 500); i++) { depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length; if (lines[i].includes('{')) {seen = true;} if (seen && depth <= 0) {return i + 1;} } return Math.min(lines.length, 100); }
function tokenize(value: string): string[] { return value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9_$]+/).filter(term => term.length > 1); }
function termCounts(value: string): Map<string, number> { const result = new Map<string, number>(); for (const term of tokenize(value)) {result.set(term, (result.get(term) ?? 0) + 1);} return result; }
function relativePath(resource: URI, workspace: URI): string { return resource.path.startsWith(workspace.path) ? resource.path.slice(workspace.path.length + 1) : resource.path; }
function isIndexable(path: string): boolean { return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|cpp|h|hpp|md|json|yaml|yml|css|html|sql)$/i.test(path); }
function isBinary(content: string): boolean { return content.includes('\0'); }
function isIgnored(nameOrPath: string, basePath: string, patterns: readonly string[]): boolean {
	if (isSensitivePath(nameOrPath)) {return true;}
	const name = nameOrPath.split(/[\\/]/).pop() ?? nameOrPath;
	const relative = nameOrPath.startsWith(basePath) ? nameOrPath.slice(basePath.length + 1) : nameOrPath;
	const segments = relative.split(/[\\/]/);
	if (segments.some(segment => ['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', 'target', 'out', '.folzeur'].includes(segment))) {
		return true;
	}
	return patterns.some(pattern => {
		const normalized = pattern.replace(/^\//, '').replace(/\/$/, '');
		return relative === normalized || relative.startsWith(`${normalized}/`) || name === normalized;
	});
}
function hashText(value: string): string { let hash = 2166136261; for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16); }
function deduplicate(chunks: readonly CodeChunk[]): CodeChunk[] { const seen = new Set<string>(); return chunks.filter(chunk => !seen.has(chunk.id) && seen.add(chunk.id)); }
function scoreColdChunks(query: string, chunks: readonly CodeChunk[], limit: number): CodeSearchResult[] {
	const terms = tokenize(query);
	return chunks.map(chunk => {
		let score = 0;
		for (const term of terms) {score += chunk.terms.get(term) ?? 0;}
		if (chunk.symbol && terms.some(term => chunk.symbol!.toLowerCase().includes(term))) {score += 6;}
		return { filePath: chunk.filePath, lineStart: chunk.startLine, lineEnd: chunk.endLine, snippet: chunk.content, score, symbol: chunk.symbol, symbolType: chunk.symbolType };
	}).filter(result => result.score > 0).sort((a, b) => b.score - a.score || a.lineStart - b.lineStart).slice(0, limit);
}
function computeHotCacheCharacterBudget(): number {
	const deviceMemoryGb = typeof navigator !== 'undefined' && typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === 'number' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory! : 4;
	return Math.min(96_000_000, Math.max(24_000_000, Math.floor(deviceMemoryGb * 12_000_000)));
}
