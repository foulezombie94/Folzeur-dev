/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import { hash } from '../../../../../../base/common/hash.js';
import { dirname } from '../../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';

interface FileSnapshot {
	readonly uri: URI;
	readonly existed: boolean;
	readonly content?: string;
	applied: boolean;
	lastAgentHash?: string;
	lastAgentExisted?: boolean;
	readonly operationId?: string;
	readonly groupId?: string;
	readonly stepId?: string;
	readonly checkpointId?: string;
	readonly blob?: string;
}

interface DirectorySnapshot { readonly uri: URI; applied: boolean; readonly operationId?: string; readonly groupId?: string; readonly stepId?: string; readonly checkpointId?: string }

export interface SnapshotScope {
	readonly operationId?: string;
	readonly groupId?: string;
	readonly stepId?: string;
	readonly checkpointId?: string;
}

export type RollbackSelection =
	| { readonly scope: 'entire_run' }
	| { readonly scope: 'operation'; readonly operationId: string }
	| { readonly scope: 'atomic_group'; readonly groupId: string }
	| { readonly scope: 'plan_step'; readonly stepId: string }
	| { readonly scope: 'checkpoint'; readonly checkpointId: string }
	| { readonly scope: 'files'; readonly files: readonly string[] };

export interface AgentFileSnapshot {
	readonly uri: URI;
	readonly existed: boolean;
	readonly content?: string;
}

/** Per-task, non-Git rollback that never commits or stages unrelated user work. */
export class TaskSnapshotManager {
	private static readonly SCHEMA_VERSION = 1;
	private static readonly MAX_DURABLE_FILES = 2_000;
	private static readonly MAX_DURABLE_BYTES = 256 * 1024 * 1024;
	private static readonly MAX_RETAINED_RUNS = 20;
	private static readonly MAX_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
	private readonly snapshots = new Map<string, FileSnapshot>();
	private readonly scopedSnapshots = new Map<string, FileSnapshot>();
	private readonly directories = new Map<string, DirectorySnapshot>();
	private activeScope: SnapshotScope = {};
	private durableFolder: URI | undefined;
	private durableManifest: URI | undefined;
	private durableTemporaryManifest: URI | undefined;
	private durableBytes = 0;

	constructor(private readonly textFileService: ITextFileService, private readonly fileService: IFileService) { }

	public reset(): void { this.snapshots.clear(); this.scopedSnapshots.clear(); this.directories.clear(); this.activeScope = {}; this.durableFolder = undefined; this.durableManifest = undefined; this.durableTemporaryManifest = undefined; this.durableBytes = 0; }

	/** Opens a run-scoped durable snapshot store and restores it after an interrupted process. */
	public async initialize(workspace: URI, runId: string, recover: boolean): Promise<void> {
		const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-160) || generateUuid();
		this.durableFolder = URI.joinPath(workspace, '.folzeur', 'agent-state', 'snapshots', safeRunId);
		this.durableManifest = URI.joinPath(this.durableFolder, 'manifest.json');
		this.durableTemporaryManifest = URI.joinPath(this.durableFolder, 'manifest.json.tmp');
		await this.fileService.createFolder(this.durableFolder);
		if (recover) {await this.restoreDurableState();}
		else {await this.persistDurableState();}
		await this.garbageCollectDurableRuns();
	}
	public setScope(scope: SnapshotScope): void { this.activeScope = { ...scope }; }
	public clearScope(): void { this.activeScope = {}; }

	/** Captures every missing ancestor that createFolder may create. */
	public async captureDirectory(filePath: string): Promise<void> {
		let current = URI.file(filePath);
		let changed = false;
		while (!await this.fileService.exists(current)) {
			const key = current.toString();
			if (!this.directories.has(key)) { this.directories.set(key, { uri: current, applied: false, ...this.activeScope }); changed = true; }
			const parent = dirname(current);
			if (parent.toString() === current.toString()) {break;}
			current = parent;
		}
		if (changed) {await this.persistDurableState();}
	}

	public async markDirectoryApplied(filePath: string): Promise<number> {
		const target = normalizeFsPath(URI.file(filePath).fsPath);
		let applied = 0;
		for (const snapshot of this.directories.values()) {
			const directory = normalizeFsPath(snapshot.uri.fsPath);
			if ((target === directory || target.startsWith(`${directory}/`)) && await this.fileService.exists(snapshot.uri)) {
				snapshot.applied = true;
				applied++;
			}
		}
		if (applied) {await this.persistDurableState();}
		return applied;
	}

	public async capture(filePath: string): Promise<void> {
		const uri = URI.file(filePath);
		const key = uri.toString();
		const existed = await this.fileService.exists(uri);
		const content = existed ? (await this.textFileService.read(uri)).value : undefined;
		let blob = this.snapshots.get(key)?.blob;
		if (!this.snapshots.has(key)) {
			blob = content === undefined ? undefined : await this.writeBlob(content);
			this.snapshots.set(key, { uri, existed, content, applied: false, blob });
		}
		const scopeKey = snapshotScopeKey(this.activeScope);
		if (scopeKey && !this.scopedSnapshots.has(`${scopeKey}:${key}`)) {this.scopedSnapshots.set(`${scopeKey}:${key}`, { uri, existed, content, applied: false, blob, ...this.activeScope });}
		await this.persistDurableState();
	}

	public get(filePath: string): AgentFileSnapshot | undefined {
		const snapshot = this.snapshots.get(URI.file(filePath).toString());
		return snapshot && { uri: snapshot.uri, existed: snapshot.existed, content: snapshot.content };
	}

	public async markApplied(filePath: string): Promise<void> {
		const uri = URI.file(filePath);
		const snapshots = [this.snapshots.get(uri.toString()), ...[...this.scopedSnapshots.values()].filter(snapshot => snapshot.uri.toString() === uri.toString() && scopeMatches(snapshot, this.activeScope))].filter((snapshot): snapshot is FileSnapshot => snapshot !== undefined);
		for (const snapshot of snapshots) {
			snapshot.applied = true;
			snapshot.lastAgentExisted = await this.fileService.exists(uri);
			snapshot.lastAgentHash = snapshot.lastAgentExisted ? hash((await this.textFileService.read(uri)).value).toString(16) : undefined;
		}
		await this.persistDurableState();
	}

	public async restoreAll(): Promise<number> {
		return this.restore({ scope: 'entire_run' });
	}

	public async restore(selection: RollbackSelection): Promise<number> {
		const snapshots = this.selectSnapshots(selection).filter(snapshot => snapshot.applied).reverse();
		const directories = [...this.directories.values()].filter(snapshot => snapshot.applied && directorySelected(snapshot, selection)).sort((a, b) => b.uri.path.length - a.uri.path.length);
		const removableChildren = new Set([
			...snapshots.filter(snapshot => !snapshot.existed).map(snapshot => snapshot.uri.toString()),
			...directories.map(directory => directory.uri.toString()),
		]);
		// Validate every target before writing anything so rollback cannot partially clobber newer work.
		for (const snapshot of snapshots) {
			const exists = await this.fileService.exists(snapshot.uri);
			if (exists !== snapshot.lastAgentExisted) {
				throw new Error(`Rollback conflict: ${snapshot.uri.fsPath} changed after the agent operation.`);
			}
			if (exists) {
				const currentHash = hash((await this.textFileService.read(snapshot.uri)).value).toString(16);
				if (currentHash !== snapshot.lastAgentHash) {throw new Error(`Rollback conflict: ${snapshot.uri.fsPath} has newer changes.`);}
			}
		}
		for (const directory of directories) {
			if (!await this.fileService.exists(directory.uri)) {continue;}
			const stat = await this.fileService.resolve(directory.uri);
			const unexpectedChild = stat.children?.find(child => !removableChildren.has(child.resource.toString()));
			if (!stat.isDirectory || unexpectedChild) {throw new Error(`Rollback conflict: created directory ${directory.uri.fsPath} contains newer user content.`);}
		}
		for (const snapshot of snapshots) {
			if (snapshot.existed) {
				await this.textFileService.write(snapshot.uri, snapshot.content ?? '');
			} else if (await this.fileService.exists(snapshot.uri)) {
				await this.fileService.del(snapshot.uri, { recursive: false });
			}
		}
		for (const directory of directories) {
			if (await this.fileService.exists(directory.uri)) {await this.fileService.del(directory.uri, { recursive: false });}
		}
		if (selection.scope === 'entire_run') {
			this.snapshots.clear();
			this.scopedSnapshots.clear();
			this.directories.clear();
		} else {
			for (const snapshot of snapshots) {
				for (const [key, candidate] of this.scopedSnapshots) {if (candidate === snapshot) {this.scopedSnapshots.delete(key);}}
				const initial = this.snapshots.get(snapshot.uri.toString());
				if (initial?.applied) {
					initial.lastAgentExisted = await this.fileService.exists(initial.uri);
					initial.lastAgentHash = initial.lastAgentExisted ? hash((await this.textFileService.read(initial.uri)).value).toString(16) : undefined;
				}
			}
			for (const directory of directories) {this.directories.delete(directory.uri.toString());}
		}
		await this.persistDurableState();
		return snapshots.length + directories.length;
	}

	private async writeBlob(content: string): Promise<string> {
		if (!this.durableFolder) {throw new Error('Durable snapshot storage is not initialized.');}
		if (this.snapshots.size >= TaskSnapshotManager.MAX_DURABLE_FILES) {throw new Error('Durable snapshot file limit reached for this run.');}
		const encoded = VSBuffer.fromString(content);
		if (this.durableBytes + encoded.byteLength > TaskSnapshotManager.MAX_DURABLE_BYTES) {throw new Error('Durable snapshot byte limit reached for this run.');}
		const blob = `${generateUuid()}.snapshot`;
		const temporary = URI.joinPath(this.durableFolder, `${blob}.tmp`);
		const target = URI.joinPath(this.durableFolder, blob);
		await this.fileService.writeFile(temporary, encoded);
		await this.fileService.move(temporary, target, true);
		this.durableBytes += encoded.byteLength;
		return blob;
	}

	private async garbageCollectDurableRuns(): Promise<void> {
		if (!this.durableFolder) {return;}
		const root = dirname(this.durableFolder);
		try {
			const stat = await this.fileService.resolve(root);
			const candidates = (stat.children ?? [])
				.filter(child => child.isDirectory && child.resource.toString() !== this.durableFolder?.toString())
				.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
			for (let index = 0; index < candidates.length; index++) {
				const candidate = candidates[index];
				if (index < TaskSnapshotManager.MAX_RETAINED_RUNS - 1 && Date.now() - (candidate.mtime ?? 0) <= TaskSnapshotManager.MAX_RETENTION_MS) {continue;}
				await this.fileService.del(candidate.resource, { recursive: true });
			}
		} catch {
			// Retention cleanup is best effort and never blocks recovery or a mutation.
		}
	}

	private async persistDurableState(): Promise<void> {
		if (!this.durableFolder || !this.durableManifest || !this.durableTemporaryManifest) {return;}
		const serializeFile = (snapshot: FileSnapshot) => ({
			uri: snapshot.uri.toString(), existed: snapshot.existed, applied: snapshot.applied,
			lastAgentHash: snapshot.lastAgentHash, lastAgentExisted: snapshot.lastAgentExisted,
			operationId: snapshot.operationId, groupId: snapshot.groupId, stepId: snapshot.stepId,
			checkpointId: snapshot.checkpointId, blob: snapshot.blob,
		});
		const payload = JSON.stringify({
			version: TaskSnapshotManager.SCHEMA_VERSION,
			updatedAt: Date.now(),
			snapshots: [...this.snapshots.values()].map(serializeFile),
			scopedSnapshots: [...this.scopedSnapshots.entries()].map(([key, snapshot]) => ({ key, snapshot: serializeFile(snapshot) })),
			directories: [...this.directories.values()].map(directory => ({ ...directory, uri: directory.uri.toString() })),
		}, undefined, 2);
		await this.fileService.writeFile(this.durableTemporaryManifest, VSBuffer.fromString(payload));
		await this.fileService.move(this.durableTemporaryManifest, this.durableManifest, true);
	}

	private async restoreDurableState(): Promise<void> {
		if (!this.durableFolder || !this.durableManifest) {return;}
		try {
			const raw = JSON.parse((await this.fileService.readFile(this.durableManifest)).value.toString()) as {
				version?: number;
				snapshots?: PersistedFileSnapshot[];
				scopedSnapshots?: Array<{ key: string; snapshot: PersistedFileSnapshot }>;
				directories?: PersistedDirectorySnapshot[];
			};
			if (raw.version !== TaskSnapshotManager.SCHEMA_VERSION) {return;}
			const restoredBlobs = new Set<string>();
			for (const persisted of raw.snapshots ?? []) {
				const snapshot = await this.deserializeSnapshot(persisted);
				if (snapshot) {
					this.snapshots.set(snapshot.uri.toString(), snapshot);
					if (snapshot.blob) {restoredBlobs.add(snapshot.blob);}
				}
			}
			for (const persisted of raw.scopedSnapshots ?? []) {
				const snapshot = await this.deserializeSnapshot(persisted.snapshot);
				if (snapshot && typeof persisted.key === 'string') {this.scopedSnapshots.set(persisted.key, snapshot);}
			}
			for (const directory of raw.directories ?? []) {
				if (typeof directory.uri !== 'string') {continue;}
				const snapshot: DirectorySnapshot = { ...directory, uri: URI.parse(directory.uri), applied: directory.applied === true };
				this.directories.set(snapshot.uri.toString(), snapshot);
			}
			for (const blob of restoredBlobs) {this.durableBytes += (await this.fileService.readFile(URI.joinPath(this.durableFolder, blob))).value.byteLength;}
		} catch {
			// Missing or interrupted state cannot authorize rollback. New captures remain durable.
		}
	}

	private async deserializeSnapshot(persisted: PersistedFileSnapshot): Promise<FileSnapshot | undefined> {
		if (!this.durableFolder || typeof persisted.uri !== 'string' || typeof persisted.existed !== 'boolean') {return undefined;}
		let content: string | undefined;
		if (persisted.existed) {
			if (typeof persisted.blob !== 'string' || !/^[a-zA-Z0-9-]+\.snapshot$/.test(persisted.blob)) {return undefined;}
			content = (await this.fileService.readFile(URI.joinPath(this.durableFolder, persisted.blob))).value.toString();
		}
		return { ...persisted, uri: URI.parse(persisted.uri), content, applied: persisted.applied === true };
	}

	private selectSnapshots(selection: RollbackSelection): FileSnapshot[] {
		if (selection.scope === 'entire_run') {return [...this.snapshots.values()];}
		if (selection.scope === 'files') {
			const selected = new Set(selection.files.map(file => URI.file(file).toString()));
			return [...this.snapshots.values()].filter(snapshot => selected.has(snapshot.uri.toString()));
		}
		return [...this.scopedSnapshots.values()].filter(snapshot => selection.scope === 'operation' ? snapshot.operationId === selection.operationId
			: selection.scope === 'atomic_group' ? snapshot.groupId === selection.groupId
				: selection.scope === 'plan_step' ? snapshot.stepId === selection.stepId
					: snapshot.checkpointId === selection.checkpointId);
	}
}

interface PersistedFileSnapshot extends SnapshotScope {
	readonly uri: string;
	readonly existed: boolean;
	readonly applied?: boolean;
	readonly lastAgentHash?: string;
	readonly lastAgentExisted?: boolean;
	readonly blob?: string;
}

interface PersistedDirectorySnapshot extends SnapshotScope {
	readonly uri: string;
	readonly applied?: boolean;
}

function snapshotScopeKey(scope: SnapshotScope): string {
	return scope.operationId ? `operation:${scope.operationId}` : scope.groupId ? `group:${scope.groupId}` : scope.stepId ? `step:${scope.stepId}` : scope.checkpointId ? `checkpoint:${scope.checkpointId}` : '';
}

function scopeMatches(snapshot: SnapshotScope, scope: SnapshotScope): boolean {
	return (!scope.operationId || snapshot.operationId === scope.operationId) && (!scope.groupId || snapshot.groupId === scope.groupId) && (!scope.stepId || snapshot.stepId === scope.stepId) && (!scope.checkpointId || snapshot.checkpointId === scope.checkpointId);
}

function directorySelected(snapshot: DirectorySnapshot, selection: RollbackSelection): boolean {
	if (selection.scope === 'entire_run') {return true;}
	if (selection.scope === 'files') {return selection.files.some(file => normalizeFsPath(file).startsWith(`${normalizeFsPath(snapshot.uri.fsPath)}/`));}
	if (selection.scope === 'operation') {return snapshot.operationId === selection.operationId;}
	if (selection.scope === 'atomic_group') {return snapshot.groupId === selection.groupId;}
	if (selection.scope === 'plan_step') {return snapshot.stepId === selection.stepId;}
	return snapshot.checkpointId === selection.checkpointId;
}

function normalizeFsPath(value: string): string {
	return value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}
