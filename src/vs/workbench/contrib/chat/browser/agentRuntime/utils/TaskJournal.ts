/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { redactSecrets } from './SecretProtection.js';
import { AgentStateCrypto } from './AgentStateCrypto.js';

export interface JournalEntry {
	readonly timestamp: number;
	readonly kind: string;
	readonly detail: string;
	readonly runId?: string;
	readonly traceId?: string;
	readonly stepId?: string;
	readonly toolCallId?: string;
	readonly transactionId?: string;
	readonly operationId?: string;
	readonly tool?: string;
	readonly target?: string;
	readonly state?: string;
	readonly beforeHash?: string;
	readonly afterHash?: string;
}

export interface TaskCheckpoint {
	readonly status: 'running' | 'completed' | 'cancelled' | 'incomplete';
	readonly state: Readonly<Record<string, unknown>>;
	readonly updatedAt: number;
}

/** Crash-readable, bounded task journal. It stores metadata only, never file contents or secrets. */
export class TaskJournal {
	private static readonly SCHEMA_VERSION = 3;
	private static readonly MAX_ENTRIES = 500;
	private static readonly MAX_BYTES = 1_000_000;
	private static readonly MAX_FILES = 50;
	private static readonly RETENTION_MS = 14 * 24 * 60 * 60_000;
	private readonly entries: JournalEntry[] = [];
	private readonly folder: URI;
	private readonly resource: URI;
	private readonly temporaryResource: URI;
	private writeChain = Promise.resolve();
	private checkpointState: TaskCheckpoint | undefined;

	constructor(private readonly fileService: IFileService, workspace: URI, private readonly stateCrypto: AgentStateCrypto, taskId = generateUuid()) {
		this.folder = URI.joinPath(workspace, '.folzeur', 'agent-state');
		const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-160) || generateUuid();
		this.resource = URI.joinPath(this.folder, `${safeTaskId}.json`);
		this.temporaryResource = URI.joinPath(this.folder, `${safeTaskId}.json.tmp`);
	}

	/** Loads the last bounded checkpoint for this chat session, if the prior process stopped unexpectedly. */
	public async initialize(): Promise<TaskCheckpoint | undefined> {
		if (!await this.fileService.exists(this.resource)) {
			void this.garbageCollect();
			return undefined;
		}
		try {
			const raw = (await this.fileService.readFile(this.resource)).value.toString();
			const envelope = JSON.parse(raw) as { payload?: string; mac?: string };
			if (typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string' || !await this.stateCrypto.verify(envelope.payload, envelope.mac)) {
				throw new Error('Task journal authentication failed.');
			}
			const parsed = JSON.parse(envelope.payload) as { version?: number; entries?: JournalEntry[]; checkpoint?: TaskCheckpoint };
			if (typeof parsed.version === 'number' && parsed.version > TaskJournal.SCHEMA_VERSION) {return undefined;}
			if (Array.isArray(parsed.entries)) {
				this.entries.push(...parsed.entries.slice(-TaskJournal.MAX_ENTRIES).filter(entry => entry && Number.isFinite(entry.timestamp) && typeof entry.kind === 'string' && typeof entry.detail === 'string'));
			}
			if (parsed.checkpoint && typeof parsed.checkpoint === 'object' && typeof parsed.checkpoint.status === 'string' && parsed.checkpoint.state && typeof parsed.checkpoint.state === 'object') {
				this.checkpointState = parsed.checkpoint;
			}
		} catch (error) {
			this.entries.length = 0;
			this.checkpointState = undefined;
			throw new Error(`Existing task journal is corrupt or unauthenticated; recovery was refused: ${error instanceof Error ? error.message : String(error)}`);
		}
		void this.garbageCollect();
		return this.checkpointState;
	}

	public record(kind: string, detail: string): Promise<void> {
		this.entries.push({ timestamp: Date.now(), kind: kind.slice(0, 80), detail: redactSecrets(detail).slice(0, 4000) });
		this.boundEntries();
		this.writeChain = this.writeChain.then(() => this.flush(), () => this.flush());
		return this.writeChain;
	}

	public recordOperation(entry: Omit<JournalEntry, 'timestamp' | 'detail' | 'kind'> & { readonly kind: string; readonly detail?: string }): Promise<void> {
		const sanitized: JournalEntry = {
			...entry,
			timestamp: Date.now(),
			kind: entry.kind.slice(0, 80),
			detail: redactSecrets(entry.detail ?? '').slice(0, 4000),
			target: entry.target ? redactSecrets(entry.target).slice(0, 2_000) : undefined,
		};
		this.entries.push(sanitized);
		this.boundEntries();
		this.writeChain = this.writeChain.then(() => this.flush(), () => this.flush());
		return this.writeChain;
	}

	public checkpoint(status: TaskCheckpoint['status'], state: Readonly<Record<string, unknown>>): Promise<void> {
		let safeState: Readonly<Record<string, unknown>> = {};
		try {
			safeState = JSON.parse(redactSecrets(JSON.stringify(state))) as Readonly<Record<string, unknown>>;
		} catch (error) {
			throw new Error(`Task checkpoint is not serializable: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.checkpointState = { status, state: safeState, updatedAt: Date.now() };
		this.writeChain = this.writeChain.then(() => this.flush(), () => this.flush());
		return this.writeChain;
	}

	private async flush(): Promise<void> {
		await this.fileService.createFolder(this.folder);
		let serialized = JSON.stringify({ version: TaskJournal.SCHEMA_VERSION, updatedAt: Date.now(), checkpoint: this.checkpointState, entries: this.entries }, undefined, 2);
		while (serialized.length > TaskJournal.MAX_BYTES && this.entries.length > 20) {
			this.entries.splice(0, Math.min(25, this.entries.length - 20));
			serialized = JSON.stringify({ version: TaskJournal.SCHEMA_VERSION, updatedAt: Date.now(), checkpoint: this.checkpointState, entries: this.entries }, undefined, 2);
		}
		const envelope = JSON.stringify({ payload: serialized, mac: await this.stateCrypto.sign(serialized) });
		const payload = VSBuffer.fromString(envelope);
		await this.fileService.writeFile(this.temporaryResource, payload);
		await this.fileService.move(this.temporaryResource, this.resource, true);
	}

	private boundEntries(): void {
		if (this.entries.length > TaskJournal.MAX_ENTRIES) {this.entries.splice(0, this.entries.length - TaskJournal.MAX_ENTRIES);}
	}

	private async garbageCollect(): Promise<void> {
		try {
			const stat = await this.fileService.resolve(this.folder, { resolveMetadata: true });
			const files = (stat.children ?? []).filter(child => child.isFile && child.resource.toString() !== this.resource.toString()).sort((a, b) => Number(b.mtime ?? 0) - Number(a.mtime ?? 0));
			const cutoff = Date.now() - TaskJournal.RETENTION_MS;
			for (let index = 0; index < files.length; index++) {
				const file = files[index];
				if (index >= TaskJournal.MAX_FILES - 1 || Number(file.mtime ?? 0) < cutoff) {await this.fileService.del(file.resource, { recursive: false });}
			}
		} catch {
			// Missing folder and cleanup failures are non-fatal.
		}
	}
}
