/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { isSensitivePath } from './SecretProtection.js';

export interface OutlineSymbol {
	readonly filePath: string;
	readonly name: string;
	readonly kind: 'class' | 'interface' | 'type' | 'function' | 'method' | 'struct' | 'trait' | 'enum';
	readonly signature: string;
	readonly lineStart: number;
	readonly lineEnd: number;
}

export type SymbolRelationKind = 'imports' | 'exports' | 'extends' | 'implements' | 'calls' | 'references';

export interface SymbolRelation {
	readonly filePath: string;
	readonly line: number;
	readonly from: string;
	readonly to: string;
	readonly kind: SymbolRelationKind;
}

interface FileGraph {
	readonly symbols: OutlineSymbol[];
	readonly relations: SymbolRelation[];
}

const OUTLINE_READ_CONCURRENCY = 8;
const OUTLINE_SCAN_BATCH = 512;

/** Small, line-addressable outline index. Bodies are deliberately not retained. */
export class WorkspaceOutlineIndex extends Disposable {
	private readonly symbols = new Map<string, OutlineSymbol[]>();
	private readonly relations = new Map<string, SymbolRelation[]>();
	private readonly pending = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly workspace: URI;
	private ignoredPatterns: string[] = [];
	private readonly initialization: Promise<void>;
	private cancelled = false;
	private workGeneration = 0;
	private workCancelled = false;

	constructor(private readonly fileService: IFileService, workspace: URI) {
		super();
		this.workspace = workspace;
		this._register(this.fileService.onDidFilesChange(event => {
			for (const resource of event.rawDeleted) {this.remove(resource);}
			for (const resource of [...event.rawAdded, ...event.rawUpdated]) {this.enqueue(resource);}
		}));
		this.initialization = this.loadIgnorePatterns().then(() => this.rebuild());
	}

	public ready(): Promise<void> { return this.initialization; }
	public cancelCurrentWork(): void {
		this.workCancelled = true;
		this.workGeneration++;
		if (this.timer) {clearTimeout(this.timer);}
		this.timer = undefined;
		this.pending.clear();
	}
	public resumeCurrentWork(): void {
		if (this.cancelled || !this.workCancelled) {return;}
		this.workCancelled = false;
		void this.rebuild();
	}

	public search(query: string, limit = 20): OutlineSymbol[] {
		const terms = query.toLowerCase().split(/[^a-z0-9_$]+/).filter(Boolean);
		const ranked: Array<{ symbol: OutlineSymbol; score: number }> = [];
		for (const symbols of this.symbols.values()) {for (const symbol of symbols) {
			if (!terms.every(term => symbol.name.toLowerCase().includes(term) || symbol.signature.toLowerCase().includes(term) || symbol.filePath.toLowerCase().includes(term))) {continue;}
			insertBounded(ranked, { symbol, score: this.score(symbol, terms) }, limit, (a, b) => b.score - a.score || a.symbol.filePath.localeCompare(b.symbol.filePath));
		}}
		return ranked.map(item => item.symbol);
	}

	public related(query: string, kinds?: readonly SymbolRelationKind[], limit = 50): SymbolRelation[] {
		const needle = query.trim().toLowerCase();
		if (!needle) {return [];}
		const result: SymbolRelation[] = [];
		for (const relations of this.relations.values()) {for (const relation of relations) {
			if ((!kinds || kinds.includes(relation.kind)) && (relation.from.toLowerCase().includes(needle) || relation.to.toLowerCase().includes(needle))) {insertBounded(result, relation, limit, relationOrder);}
		}}
		return result;
	}

	public incoming(query: string, kinds?: readonly SymbolRelationKind[], limit = 50): SymbolRelation[] {
		return this.directionalRelations(query, 'to', kinds, limit);
	}

	public outgoing(query: string, kinds?: readonly SymbolRelationKind[], limit = 50): SymbolRelation[] {
		return this.directionalRelations(query, 'from', kinds, limit);
	}

	public repositoryMap(limit = 500): string {
		const files = [...this.symbols.entries()]
			.map(([key, symbols]) => ({ key, symbols }))
			.filter(entry => entry.symbols.length > 0)
			.sort((a, b) => a.symbols[0].filePath.localeCompare(b.symbols[0].filePath));
		let emitted = 0;
		const output: string[] = [];
		for (const entry of files) {
			if (emitted >= limit) {break;}
			output.push(entry.symbols[0].filePath);
			for (const symbol of entry.symbols) {
				if (emitted++ >= limit) {break;}
				const outgoing = (this.relations.get(entry.key) ?? []).filter(relation => relation.from === symbol.name && relation.kind !== 'references').slice(0, 8);
				output.push(`  ${symbol.kind} ${symbol.name}${outgoing.length ? ` -> ${outgoing.map(edge => `${edge.kind}:${edge.to}`).join(', ')}` : ''}`);
			}
		}
		return output.join('\n');
	}

	public override dispose(): void {
		this.cancelled = true;
		this.cancelCurrentWork();
		super.dispose();
	}

	private score(symbol: OutlineSymbol, terms: string[]): number {
		const name = symbol.name.toLowerCase();
		return terms.reduce((score, term) => score + (name === term ? 4 : name.includes(term) ? 2 : symbol.signature.toLowerCase().includes(term) ? 1 : 0), 0);
	}

	private directionalRelations(query: string, side: 'from' | 'to', kinds?: readonly SymbolRelationKind[], limit = 50): SymbolRelation[] {
		const needle = query.trim().toLowerCase();
		if (!needle) {return [];}
		const result: SymbolRelation[] = [];
		for (const relations of this.relations.values()) {for (const relation of relations) {
			if ((!kinds || kinds.includes(relation.kind)) && relation[side].toLowerCase().includes(needle)) {insertBounded(result, relation, limit, relationOrder);}
		}}
		return result;
	}

	private enqueue(resource: URI): void {
		if (this.cancelled || this.workCancelled || !this.isIndexable(resource.path) || this.isIgnored(resource)) {return;}
		this.pending.add(this.key(resource));
		// A leading debounce timer prevents a continuous stream of file events
		// from starving the index forever.
		if (!this.timer) {this.timer = setTimeout(() => void this.flush(), 180);}
	}

	private async flush(): Promise<void> {
		if (this.cancelled || this.workCancelled) {return;}
		const generation = this.workGeneration;
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		const resources = [...this.pending];
		this.pending.clear();
		for (let offset = 0; offset < resources.length; offset += OUTLINE_READ_CONCURRENCY) {
			if (this.cancelled || this.workCancelled || generation !== this.workGeneration) {return;}
			await Promise.all(resources.slice(offset, offset + OUTLINE_READ_CONCURRENCY).map(async value => {
				try {
					const resource = URI.file(value);
					const model = await this.fileService.readFile(resource);
					const graph = extractGraph(this.relativePath(resource), model.value.toString());
					this.symbols.set(this.key(resource), graph.symbols);
					this.relations.set(this.key(resource), graph.relations);
				} catch { this.symbols.delete(value); this.relations.delete(value); }
			}));
			if (offset && offset % (OUTLINE_READ_CONCURRENCY * 16) === 0) {await yieldToEventLoop();}
		}
		if (this.pending.size && !this.workCancelled && !this.timer) {this.timer = setTimeout(() => void this.flush(), 0);}
	}

	private remove(resource: URI): void { this.symbols.delete(this.key(resource)); this.relations.delete(this.key(resource)); }

	private async rebuild(): Promise<void> {
		if (this.cancelled || this.workCancelled) {return;}
		const generation = this.workGeneration;
		await this.collect(this.workspace, 0, generation);
		if (this.workCancelled || generation !== this.workGeneration) {return;}
		await this.flush();
	}

	private async collect(resource: URI, depth: number, generation = this.workGeneration): Promise<void> {
		if (this.cancelled || this.workCancelled || generation !== this.workGeneration || depth > 64) {return;}
		try {
			const stat = await this.fileService.resolve(resource);
			if (stat.isDirectory) {
				if (this.isIgnored(resource)) {return;}
				for (const child of stat.children ?? []) {await this.collect(child.resource, depth + 1, generation);}
			} else if (this.isIndexable(resource.path) && !this.isIgnored(resource)) {
				this.pending.add(this.key(resource));
				if (this.pending.size >= OUTLINE_SCAN_BATCH) {await this.flush();}
			}
		} catch { /* files can disappear during indexing */ }
	}

	private isIndexable(path: string): boolean { return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|cpp|h|hpp)$/i.test(path); }
	private key(resource: URI): string { return resource.fsPath.replace(/\\/g, '/').toLowerCase(); }
	private isIgnored(resource: URI): boolean {
		const normalized = resource.fsPath.replace(/\\/g, '/');
		if (isSensitivePath(normalized)) {return true;}
		const name = normalized.split('/').pop() ?? normalized;
		if (['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', 'target', 'out', '.folzeur'].includes(name)) {return true;}
		const workspacePath = this.workspace.fsPath.replace(/\\/g, '/').replace(/\/$/, '');
		const relative = normalized.startsWith(`${workspacePath}/`) ? normalized.slice(workspacePath.length + 1) : name;
		return this.ignoredPatterns.some(pattern => {
			const clean = pattern.replace(/^\//, '').replace(/\/$/, '').replace(/\*\*/g, '*');
			return clean && (relative === clean || relative.startsWith(`${clean}/`) || name === clean);
		});
	}
	private async loadIgnorePatterns(): Promise<void> {
		const patterns: string[] = [];
		for (const name of ['.gitignore', '.folzeurignore']) {
			try {
				const model = await this.fileService.readFile(URI.joinPath(this.workspace, name));
				patterns.push(...model.value.toString().split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
			} catch { /* optional ignore file */ }
		}
		this.ignoredPatterns = [...new Set(patterns)];
	}
	private relativePath(resource: URI): string { return resource.path.startsWith(this.workspace.path) ? resource.path.slice(this.workspace.path.length + 1) : resource.fsPath; }
}

function extractGraph(filePath: string, content: string): FileGraph {
	const lines = content.split(/\r?\n/);
	const result: OutlineSymbol[] = [];
	const relations: SymbolRelation[] = [];
	const pattern = /\b(?:export\s+)?(?:declare\s+)?(?:async\s+)?(class|interface|type|enum|function|struct|trait|fn|def)\s+([A-Za-z_$][\w$]*)/;
	for (let index = 0; index < lines.length; index++) {
		const match = pattern.exec(lines[index]);
		if (!match) {continue;}
		const kind = match[1] === 'fn' || match[1] === 'def' ? 'function' : match[1] as OutlineSymbol['kind'];
		const symbol = { filePath, name: match[2], kind, signature: lines[index].trim().slice(0, 300), lineStart: index + 1, lineEnd: findSymbolEnd(lines, index, lines[index]) } satisfies OutlineSymbol;
		result.push(symbol);
		for (const target of captureList(lines[index], /\bextends\s+([^\{]+)/)) {relations.push({ filePath, line: index + 1, from: symbol.name, to: target, kind: 'extends' });}
		for (const target of captureList(lines[index], /\bimplements\s+([^\{]+)/)) {relations.push({ filePath, line: index + 1, from: symbol.name, to: target, kind: 'implements' });}
		if (/\bexport\b/.test(lines[index])) {relations.push({ filePath, line: index + 1, from: symbol.name, to: filePath, kind: 'exports' });}
	}
	const containers = result.filter(symbol => ['class', 'interface', 'struct', 'trait'].includes(symbol.kind));
	const memberPattern = /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::[^={]+)?\s*(?:\{|=>)/;
	for (let index = 0; index < lines.length; index++) {
		if (result.some(symbol => symbol.lineStart === index + 1)) {continue;}
		const owner = containers.find(symbol => index + 1 > symbol.lineStart && index + 1 <= symbol.lineEnd);
		const match = owner ? memberPattern.exec(lines[index]) : undefined;
		if (!owner || !match || ['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) {continue;}
		result.push({ filePath, name: `${owner.name}.${match[1]}`, kind: 'method', signature: lines[index].trim().slice(0, 300), lineStart: index + 1, lineEnd: findSymbolEnd(lines, index, lines[index]) });
	}
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const owner = result.find(symbol => index + 1 >= symbol.lineStart && index + 1 <= symbol.lineEnd)?.name ?? filePath;
		const moduleMatch = /\bfrom\s+['"]([^'"]+)['"]|\b(?:import|use)\s+(?:[^'"]*?from\s+)?['"]?([\w@./:-]+)/.exec(line);
		const imported = moduleMatch?.[1] ?? moduleMatch?.[2];
		if (imported) {relations.push({ filePath, line: index + 1, from: owner, to: imported, kind: 'imports' });}
		const namedImports = /\b(?:import|export)\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/.exec(line)?.[1];
		for (const importedName of namedImports?.split(',') ?? []) {
			const target = importedName.trim().split(/\s+as\s+/i)[0];
			if (target) {relations.push({ filePath, line: index + 1, from: owner, to: target, kind: 'references' });}
		}
		const calls = line.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g);
		for (const call of calls) {
			const target = call[1];
			if (!['if', 'for', 'while', 'switch', 'catch', 'function', 'fn', 'def', 'return'].includes(target) && target !== owner) {
				relations.push({ filePath, line: index + 1, from: owner, to: target, kind: 'calls' });
			}
		}
		for (const reference of line.matchAll(/(?:\bnew\s+|\bas\s+|:\s*|->\s*|<\s*)([A-Z][A-Za-z0-9_$]*)/g)) {
			if (reference[1] !== owner && !['Array', 'Promise', 'Record', 'ReadonlyArray', 'String', 'Number', 'Boolean'].includes(reference[1])) {
				relations.push({ filePath, line: index + 1, from: owner, to: reference[1], kind: 'references' });
			}
		}
	}
	// Scale pathological generated files from their actual line count instead of
	// imposing a workspace-wide file ceiling. The native Rust index remains the
	// exhaustive text/vector layer; this outline is a bounded structural cache.
	const symbolBudget = adaptiveEntryBudget(lines.length, 240, 2_000);
	const relationBudget = adaptiveEntryBudget(lines.length, 600, 5_000);
	return { symbols: deduplicateSymbols(result).slice(0, symbolBudget), relations: deduplicateRelations(relations).slice(0, relationBudget) };
}

function adaptiveEntryBudget(lineCount: number, density: number, minimum: number): number {
	return Math.min(50_000, Math.max(minimum, Math.ceil(Math.sqrt(Math.max(1, lineCount)) * density)));
}

function yieldToEventLoop(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)); }

function relationOrder(a: SymbolRelation, b: SymbolRelation): number { return a.filePath.localeCompare(b.filePath) || a.line - b.line; }

function insertBounded<T>(result: T[], value: T, limit: number, compare: (a: T, b: T) => number): void {
	if (limit <= 0) {return;}
	result.push(value);
	result.sort(compare);
	if (result.length > limit) {result.pop();}
}

function captureList(line: string, pattern: RegExp): string[] {
	const value = pattern.exec(line)?.[1];
	return value ? value.split(',').map(item => item.trim().split(/\s+/)[0]).filter(Boolean) : [];
}

function deduplicateSymbols(symbols: readonly OutlineSymbol[]): OutlineSymbol[] {
	const seen = new Set<string>();
	return symbols.filter(symbol => {
		const key = `${symbol.kind}:${symbol.name}:${symbol.lineStart}`;
		if (seen.has(key)) {return false;}
		seen.add(key);
		return true;
	});
}

function deduplicateRelations(relations: readonly SymbolRelation[]): SymbolRelation[] {
	const seen = new Set<string>();
	return relations.filter(relation => {
		const key = `${relation.kind}:${relation.from}:${relation.to}:${relation.line}`;
		if (seen.has(key)) {return false;}
		seen.add(key);
		return true;
	});
}

function findSymbolEnd(lines: readonly string[], start: number, declaration: string): number {
	let depth = 0;
	let sawBrace = false;
	for (let line = start; line < Math.min(lines.length, start + 5000); line++) {
		const value = lines[line];
		const opens = (value.match(/\{/g) ?? []).length;
		const closes = (value.match(/\}/g) ?? []).length;
		if (opens) {sawBrace = true;}
		depth += opens - closes;
		if (sawBrace && depth <= 0) {return line + 1;}
	}
	if (!sawBrace) {
		const baseIndent = (declaration.match(/^\s*/) ?? [''])[0].length;
		let end = start;
		for (let line = start + 1; line < lines.length; line++) {
			if (lines[line].trim() && (lines[line].match(/^\s*/) ?? [''])[0].length <= baseIndent) {break;}
			end = line;
		}
		return end + 1;
	}
	return Math.min(lines.length, start + 5000);
}
