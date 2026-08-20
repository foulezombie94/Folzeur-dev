/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITerminalService, ITerminalInstance } from '../../../../../contrib/terminal/browser/terminal.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { isWindows } from '../../../../../../base/common/platform.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { redactSecrets } from '../utils/SecretProtection.js';
import { GeneralShellType, ITerminalLaunchError, TerminalShellType, WindowsShellType } from '../../../../../../platform/terminal/common/terminal.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';

export type TerminalManagerEvent =
	| { readonly kind: 'started'; readonly terminalId: number; readonly terminalInstanceId: number; readonly command: string; readonly cwd?: string }
	| { readonly kind: 'data'; readonly terminalId: number; readonly data: string }
	| { readonly kind: 'finished'; readonly terminalId: number; readonly exitCode?: number; readonly output: string };

export class TerminalManager implements IDisposable {
	private terminals: Map<number, ITerminalInstance> = new Map();
	private outputs: Map<number, string> = new Map();
	private nextId = 1;
	private dataListeners: Map<number, IDisposable> = new Map();
	private exitListeners: Map<number, IDisposable> = new Map();
	private completedExitCodes: Map<number, number | undefined> = new Map();
	private cancellationListeners: Map<number, IDisposable> = new Map();
	private forceStopTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();
	private readonly eventEmitter = new Emitter<TerminalManagerEvent>();
	private readonly spoolResources = new Map<number, URI>();
	private readonly spoolWrites = new Map<number, Promise<void>>();
	private readonly spoolErrors = new Map<number, Error>();
	private readonly completedAt = new Map<number, number>();
	private spoolRoot: URI | undefined;
	private currentRunId = '';
	private readonly terminalRuns = new Map<number, string>();
	private readonly persistentTerminals = new Set<number>();
	readonly onDidChange: Event<TerminalManagerEvent> = this.eventEmitter.event;

	constructor(
		private readonly terminalService: ITerminalService,
		private readonly fileService: IFileService
	) {}

	public setRunScope(workspace: URI, runId: string): void {
		const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-160) || generateUuid();
		this.spoolRoot = URI.joinPath(workspace, '.folzeur', 'agent-state', 'terminal-output', safeRunId);
		this.currentRunId = runId;
	}

	public async executeCommand(command: string, cwd?: string, isBackground: boolean = false, timeoutMs = 10 * 60 * 1000, token: CancellationToken = CancellationToken.None, persistAfterTask = false): Promise<{ terminalId: number; terminalInstanceId: number; exitCode?: number; output: string }> {
		if (!command.trim()) {
			throw new Error('Command must not be empty.');
		}
		if (command.length > 32_768) {
			throw new Error('Command exceeds the maximum supported length.');
		}
		const id = this.nextId++;
		this.terminalRuns.set(id, this.currentRunId);
		if (persistAfterTask) {this.persistentTerminals.add(id);}
		this.pruneCompleted();
		if (this.spoolRoot) {
			await this.fileService.createFolder(this.spoolRoot);
			const resource = URI.joinPath(this.spoolRoot, `${id}.log`);
			this.spoolResources.set(id, resource);
			await this.fileService.writeFile(resource, VSBuffer.fromString(''));
			this.spoolWrites.set(id, Promise.resolve());
		}
		const terminal = await this.terminalService.createTerminal({
			config: { name: `Agent Task #${id}` },
			cwd
		});
		
		this.terminals.set(id, terminal);
		this.outputs.set(id, '');
		this.eventEmitter.fire({ kind: 'started', terminalId: id, terminalInstanceId: terminal.instanceId, command: redactSecrets(command), cwd });
		
		const dataListener = terminal.onLineData((line: string) => {
			// Keep a bounded UI preview while the file-service spool captures the complete
			// redacted stream for paginated reads, including very large command output.
			let currentOutput = this.outputs.get(id) || '';
			const safeLine = redactSecrets(line);
			currentOutput += safeLine + '\n';
			
			// The chat preview is bounded; the native terminal owns the complete scrollback.
			if (currentOutput.length > 120_000) {
				currentOutput = currentOutput.substring(currentOutput.length - 120_000);
			}
			this.outputs.set(id, currentOutput);
			this.appendSpool(id, `${safeLine}\n`);
			this.eventEmitter.fire({ kind: 'data', terminalId: id, data: `${safeLine}\n` });
		});
		this.dataListeners.set(id, dataListener);
		this.cancellationListeners.set(id, token.onCancellationRequested(() => this.interrupt(id)));
		
		if (isBackground) {
			let shellType: TerminalShellType = terminal.shellType;
			if (!shellType && terminal.processName) {
				const procName = terminal.processName.toLowerCase();
				if (procName.includes('cmd')) {
					shellType = WindowsShellType.CommandPrompt;
				} else if (procName.includes('powershell') || procName.includes('pwsh')) {
					shellType = GeneralShellType.PowerShell;
				}
			}

			let runCommand: string;
			if (shellType === 'pwsh' || (!shellType && isWindows)) {
				runCommand = `$global:LASTEXITCODE = $null; & { ${command} }; $folzeurSucceeded = $?; $folzeurNativeExitCode = $LASTEXITCODE; if ($null -ne $folzeurNativeExitCode) { exit $folzeurNativeExitCode } elseif ($folzeurSucceeded) { exit 0 } else { exit 1 }`;
			} else if (shellType === 'cmd') {
				runCommand = `${command} & exit`;
			} else {
				runCommand = `${command}; exit $?`;
			}

			const exitListener = terminal.onExit((exitCode: number | ITerminalLaunchError | undefined) => {
				const code = typeof exitCode === 'number' ? exitCode : exitCode?.code;
				this.completedExitCodes.set(id, code);
				this.eventEmitter.fire({ kind: 'finished', terminalId: id, exitCode: code, output: this.outputs.get(id) ?? '' });
				this.cleanup(id);
			});
			this.exitListeners.set(id, exitListener);

			terminal.sendText(runCommand, true);
			return { terminalId: id, terminalInstanceId: terminal.instanceId, output: `Process started in background. Output is managed by terminal ${id}. Use manage_terminal with action=get_output and terminalId=${id} to inspect it.` };
		} else {
			return new Promise(resolve => {
				let settled = false;
				const timeoutHandle = setTimeout(() => {
					const tail = this.outputs.get(id) || '';
					this.interrupt(id);
					finish({ terminalId: id, terminalInstanceId: terminal.instanceId, exitCode: 124, output: `Command timed out after ${timeoutMs} ms. Last output:\n${tail}` });
				}, Math.max(1_000, Math.min(timeoutMs, 60 * 60 * 1000)));
				const finish = (result: { terminalId: number; terminalInstanceId: number; exitCode?: number; output: string }) => {
					if (settled) {return;}
					settled = true;
					if (timeoutHandle) {clearTimeout(timeoutHandle);}
					resolve(result);
				};
				this.cancellationListeners.get(id)?.dispose();
				this.cancellationListeners.set(id, token.onCancellationRequested(() => {
					const tail = this.outputs.get(id) || '';
					this.interrupt(id);
					finish({ terminalId: id, terminalInstanceId: terminal.instanceId, exitCode: 130, output: `Command cancelled. Last output:\n${tail}` });
				}));
				const exitListener = terminal.onExit((exitCode: number | ITerminalLaunchError | undefined) => {
					const code = typeof exitCode === 'number' ? exitCode : exitCode?.code;
					const tail = this.outputs.get(id) || '';
					this.eventEmitter.fire({ kind: 'finished', terminalId: id, exitCode: code, output: tail });
					this.cleanup(id);
					finish({ terminalId: id, terminalInstanceId: terminal.instanceId, exitCode: code, output: tail });
				});
				this.exitListeners.set(id, exitListener);
				
				// Detect active shell type for multi-OS/multi-shell compatibility
				let shellType: TerminalShellType = terminal.shellType;
				if (!shellType && terminal.processName) {
					const procName = terminal.processName.toLowerCase();
					if (procName.includes('cmd')) {
						shellType = WindowsShellType.CommandPrompt;
					} else if (procName.includes('powershell') || procName.includes('pwsh')) {
						shellType = GeneralShellType.PowerShell;
					}
				}

				let runCommand: string;
				if (shellType === 'cmd') {
					runCommand = `${command} & exit`;
				} else if (shellType === 'pwsh' || (!shellType && isWindows)) {
					runCommand = `$global:LASTEXITCODE = $null; & { ${command} }; $folzeurSucceeded = $?; $folzeurNativeExitCode = $LASTEXITCODE; if ($null -ne $folzeurNativeExitCode) { exit $folzeurNativeExitCode } elseif ($folzeurSucceeded) { exit 0 } else { exit 1 }`;
				} else {
					runCommand = `${command}; exit $?`;
				}

				terminal.sendText(runCommand, true);
			});
		}
	}

	public async getUnretrievedOutput(id: number, offset = 0, limit = 120_000): Promise<{ output: string; offset: number; nextOffset?: number; totalLength: number; exitCode?: number; running: boolean }> {
		if (!this.outputs.has(id) && !this.completedExitCodes.has(id)) {return { output: `Terminal ${id} not found.`, offset: 0, totalLength: 0, running: false };}
		await this.spoolWrites.get(id);
		const spoolError = this.spoolErrors.get(id);
		if (spoolError) {throw new Error(`Terminal ${id} output could not be persisted: ${spoolError.message}`);}
		let output = this.outputs.get(id) ?? '';
		const resource = this.spoolResources.get(id);
		if (resource && await this.fileService.exists(resource)) {output = (await this.fileService.readFile(resource)).value.toString();}
		const safeOffset = Math.max(0, Math.min(Math.floor(offset), output.length));
		const safeLimit = Math.max(1_000, Math.min(Math.floor(limit), 250_000));
		const page = output.slice(safeOffset, safeOffset + safeLimit);
		const nextOffset = safeOffset + page.length < output.length ? safeOffset + page.length : undefined;
		return { output: page, offset: safeOffset, nextOffset, totalLength: output.length, exitCode: this.completedExitCodes.get(id), running: this.terminals.has(id) };
	}

	public interrupt(id: number): string {
		const terminal = this.terminals.get(id);
		if (terminal) {
			// Give cooperative programs a short grace period, then dispose the PTY. Disposing
			// the terminal asks the terminal backend to tear down the complete process tree.
			terminal.sendText('\x03', false);
			if (!this.forceStopTimers.has(id)) {
				this.forceStopTimers.set(id, setTimeout(() => {
					this.forceStopTimers.delete(id);
					if (this.terminals.get(id) === terminal) {
						terminal.dispose();
						this.cleanup(id);
					}
				}, 2_000));
			}
			return `Sent SIGINT to terminal ${id}; the process tree will be terminated after the grace period if it is still running.`;
		}
		return `Terminal ${id} not found.`;
	}

	public interruptAll(): void {
		for (const id of [...this.terminals.keys()]) {this.interrupt(id);}
	}

	public cleanupRun(runId: string): void {
		for (const [id, owner] of this.terminalRuns) {
			if (owner === runId && !this.persistentTerminals.has(id)) {this.interrupt(id);}
		}
	}

	private cleanup(id: number) {
		const forceStopTimer = this.forceStopTimers.get(id);
		if (forceStopTimer) {clearTimeout(forceStopTimer);}
		this.forceStopTimers.delete(id);
		this.dataListeners.get(id)?.dispose();
		this.dataListeners.delete(id);
		this.exitListeners.get(id)?.dispose();
		this.exitListeners.delete(id);
		this.terminals.delete(id);
		this.cancellationListeners.get(id)?.dispose();
		this.cancellationListeners.delete(id);
		this.terminalRuns.delete(id);
		this.persistentTerminals.delete(id);
		this.completedAt.set(id, Date.now());
	}

	private appendSpool(id: number, value: string): void {
		const resource = this.spoolResources.get(id);
		if (!resource) {return;}
		const bytes = VSBuffer.fromString(value);
		const pending = this.spoolWrites.get(id) ?? Promise.resolve();
		this.spoolWrites.set(id, pending.then(async () => {
			await this.fileService.writeFile(resource, bytes, { append: true });
		}).catch(error => {
			this.spoolErrors.set(id, error instanceof Error ? error : new Error(String(error)));
		}));
	}

	private pruneCompleted(): void {
		const cutoff = Date.now() - 60 * 60_000;
		const sorted = [...this.completedAt.entries()].sort((a, b) => b[1] - a[1]);
		for (let index = 0; index < sorted.length; index++) {
			const [id, completed] = sorted[index];
			if (index < 50 && completed >= cutoff) {continue;}
			this.completedAt.delete(id);
			this.completedExitCodes.delete(id);
			this.outputs.delete(id);
			const resource = this.spoolResources.get(id);
			this.spoolResources.delete(id);
			this.spoolWrites.delete(id);
			this.spoolErrors.delete(id);
			if (resource) {void this.fileService.del(resource, { recursive: false }).catch(() => undefined);}
		}
	}

	public dispose() {
		this.interruptAll();
		for (const timer of this.forceStopTimers.values()) {clearTimeout(timer);}
		this.forceStopTimers.clear();
		for (const terminal of this.terminals.values()) {terminal.dispose();}
		this.completedExitCodes.clear();
		this.spoolResources.clear();
		this.spoolWrites.clear();
		this.spoolErrors.clear();
		this.completedAt.clear();
		this.terminalRuns.clear();
		this.persistentTerminals.clear();
		for (const listener of this.cancellationListeners.values()) {listener.dispose();}
		this.cancellationListeners.clear();
		for (const listener of this.dataListeners.values()) {
			listener.dispose();
		}
		this.dataListeners.clear();
		for (const listener of this.exitListeners.values()) {
			listener.dispose();
		}
		this.exitListeners.clear();
		this.terminals.clear();
		this.outputs.clear();
		this.eventEmitter.dispose();
	}
}
