/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Emitter } from '../../../base/common/event.js';
import { IFolzeurAgentEvent, IFolzeurAgentService } from '../common/folzeurAgent.js';

interface BackendResponse { readonly id?: string; readonly ok?: boolean; readonly result?: string; readonly error?: string; readonly event?: IFolzeurAgentEvent; }

export class FolzeurAgentWorkerService implements IFolzeurAgentService {
	declare readonly _serviceBrand: undefined;
	readonly isSupported = true;
	private readonly eventEmitter = new Emitter<IFolzeurAgentEvent>();
	readonly onEvent = this.eventEmitter.event;
	private backend: ChildProcessWithoutNullStreams | undefined;
	private activeWorkspace: string | undefined;
	private readonly pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

	async start(options?: { readonly workspacePath?: string }): Promise<void> {
		if (this.backend) {
			if (options?.workspacePath && options.workspacePath !== this.activeWorkspace) {
				await this.request('initialize', { workspacePath: options.workspacePath });
				this.activeWorkspace = options.workspacePath;
			}
			return;
		}
		const executableName = process.platform === 'win32' ? 'folzeur-backend.exe' : 'folzeur-backend';
		const developmentExecutable = join(process.cwd(), 'folzeur-backend', 'target', 'release', executableName);
		const executable = process.env.FOLZEUR_BACKEND_PATH || (existsSync(developmentExecutable) ? developmentExecutable : executableName);
		this.backend = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, FOLZEUR_WORKSPACE: options?.workspacePath ?? '' } });
		const backend = this.backend;
		const lines = createInterface({ input: backend.stdout });
		lines.on('line', line => this.onLine(line));
		backend.stderr.on('data', data => this.eventEmitter.fire({ requestId: '', kind: 'progress', data: String(data) }));
		backend.on('exit', code => {
			this.eventEmitter.fire({ requestId: '', kind: 'exited', data: String(code ?? '') });
			for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error(`Folzeur backend exited with code ${code ?? 'unknown'}`)); }
			this.pending.clear();
			this.backend = undefined;
			this.activeWorkspace = undefined;
		});
		backend.on('error', error => {
			for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
			this.pending.clear();
			this.backend = undefined;
			this.activeWorkspace = undefined;
		});
		try {
			await this.request('initialize', { workspacePath: options?.workspacePath });
			this.activeWorkspace = options?.workspacePath;
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async request(method: string, params?: Record<string, unknown>): Promise<string> {
		if (!this.backend) { await this.start({ workspacePath: typeof params?.workspacePath === 'string' ? params.workspacePath : undefined }); }
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Folzeur backend request timed out: ${method}`));
			}, 30_000);
			this.pending.set(id, { resolve, reject, timeout });
			this.backend!.stdin.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`, error => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timeout);
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	async stop(): Promise<void> {
		for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('Folzeur backend stopped.')); }
		this.pending.clear();
		this.backend?.kill();
		this.backend = undefined;
		this.activeWorkspace = undefined;
	}

	private onLine(line: string): void {
		let response: BackendResponse;
		try { response = JSON.parse(line) as BackendResponse; } catch { return; }
		if (response.event) { this.eventEmitter.fire(response.event); return; }
		if (!response.id) { return; }
		const pending = this.pending.get(response.id);
		if (!pending) { return; }
		this.pending.delete(response.id);
		clearTimeout(pending.timeout);
		if (response.ok === false || response.error) { pending.reject(new Error(response.error || 'Folzeur backend request failed')); return; }
		pending.resolve(response.result ?? '');
	}
}
