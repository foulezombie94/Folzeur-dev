/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';

interface StoredToolResult {
	readonly id: string;
	readonly runId: string;
	readonly resource: URI;
	readonly byteLength: number;
	readonly hash: string;
	readonly createdAt: number;
	lastAccessedAt: number;
}

/** Run-scoped, paginated disk storage for complete large tool results. */
export class ToolResultStore {
	private static readonly MAX_ITEMS = 100;
	private static readonly MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
	private static readonly MAX_ITEM_BYTES = 256 * 1024 * 1024;
	private static readonly TTL_MS = 60 * 60_000;
	private readonly entries = new Map<string, StoredToolResult>();
	private runId = '';
	private root: URI | undefined;
	private totalBytes = 0;

	constructor(private readonly fileService: IFileService) { }

	public async setRunScope(workspace: URI, runId: string): Promise<void> {
		await this.clear();
		this.runId = runId;
		const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-160) || generateUuid();
		this.root = URI.joinPath(workspace, '.folzeur', 'agent-state', 'tool-results', safeRunId);
		await this.fileService.createFolder(this.root);
	}

	public async put(value: string): Promise<{ id: string; length: number; hash: string }> {
		await this.prune();
		if (!this.root || !this.runId) {throw new Error('Large-result store has no active run scope.');}
		const bytes = VSBuffer.fromString(value);
		if (bytes.byteLength > ToolResultStore.MAX_ITEM_BYTES) {
			throw new Error(`Tool result is ${bytes.byteLength} bytes and exceeds the explicit ${ToolResultStore.MAX_ITEM_BYTES}-byte per-result quota; no data was silently truncated.`);
		}
		const id = generateUuid();
		const resource = URI.joinPath(this.root, `${id}.txt`);
		const hash = await sha256(bytes.buffer);
		await this.fileService.writeFile(resource, bytes);
		const entry: StoredToolResult = { id, runId: this.runId, resource, byteLength: bytes.byteLength, hash, createdAt: Date.now(), lastAccessedAt: Date.now() };
		this.entries.set(id, entry);
		this.totalBytes += entry.byteLength;
		await this.prune();
		if (!this.entries.has(id)) {throw new Error('Tool result could not be retained within the run storage quota.');}
		return { id, length: entry.byteLength, hash };
	}

	public async read(id: string, offset = 0, maxChars = 12_000): Promise<{ value: string; offset: number; end: number; length: number; hash: string } | undefined> {
		await this.prune();
		const entry = this.entries.get(id);
		if (!entry || entry.runId !== this.runId) {return undefined;}
		entry.lastAccessedAt = Date.now();
		this.entries.delete(id);
		this.entries.set(id, entry);
		let safeOffset = Math.min(entry.byteLength, Math.max(0, Math.floor(offset)));
		const safeMaxChars = Math.max(1, Math.min(Math.floor(maxChars), 20_000));
		if (safeOffset === entry.byteLength) {return { value: '', offset: safeOffset, end: safeOffset, length: entry.byteLength, hash: entry.hash };}
		let bytes = (await this.fileService.readFile(entry.resource, { position: safeOffset, length: Math.min(entry.byteLength - safeOffset, safeMaxChars * 4 + 4) })).value.buffer;
		while (bytes.byteLength && isUtf8Continuation(bytes[0])) {
			safeOffset++;
			bytes = bytes.slice(1);
		}
		let value = VSBuffer.wrap(bytes).toString().slice(0, safeMaxChars);
		if (value.length && isHighSurrogate(value.charCodeAt(value.length - 1))) {value = value.slice(0, -1);}
		const consumedBytes = VSBuffer.fromString(value).byteLength;
		const end = Math.min(entry.byteLength, safeOffset + consumedBytes);
		return { value, offset: safeOffset, end, length: entry.byteLength, hash: entry.hash };
	}

	public metadata(): readonly { id: string; length: number; hash: string; createdAt: number }[] {
		return [...this.entries.values()].map(entry => ({ id: entry.id, length: entry.byteLength, hash: entry.hash, createdAt: entry.createdAt }));
	}

	public async clear(): Promise<void> {
		const entries = [...this.entries.values()];
		this.entries.clear();
		this.totalBytes = 0;
		await Promise.all(entries.map(entry => this.fileService.del(entry.resource, { recursive: false }).catch(() => undefined)));
	}

	private async prune(): Promise<void> {
		const cutoff = Date.now() - ToolResultStore.TTL_MS;
		for (const [id, entry] of [...this.entries]) {
			if (entry.lastAccessedAt < cutoff) {await this.delete(id, entry);}
		}
		while (this.entries.size > ToolResultStore.MAX_ITEMS || this.totalBytes > ToolResultStore.MAX_TOTAL_BYTES) {
			const oldest = this.entries.entries().next().value as [string, StoredToolResult] | undefined;
			if (!oldest) {break;}
			await this.delete(oldest[0], oldest[1]);
		}
	}

	private async delete(id: string, entry: StoredToolResult): Promise<void> {
		this.entries.delete(id);
		this.totalBytes -= entry.byteLength;
		await this.fileService.del(entry.resource, { recursive: false }).catch(() => undefined);
	}
}

async function sha256(value: Uint8Array): Promise<string> {
	const copy = new Uint8Array(value.byteLength);
	copy.set(value);
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', copy.buffer));
	return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function isUtf8Continuation(byte: number): boolean {return (byte & 0xc0) === 0x80;}
function isHighSurrogate(code: number): boolean {return code >= 0xd800 && code <= 0xdbff;}
