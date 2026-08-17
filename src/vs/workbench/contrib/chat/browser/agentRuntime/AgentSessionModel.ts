/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { PlanStep } from './tools/NativeTaskPlanTool.js';
import { AgentRuntimePhase } from './utils/AgentRuntimeControl.js';
import { redactSecrets } from './utils/SecretProtection.js';

export type AgentSessionStatus =
	| 'idle'
	| 'thinking'
	| 'planning'
	| 'searching'
	| 'running_tool'
	| 'editing'
	| 'verifying'
	| 'debugging'
	| 'waiting'
	| 'done'
	| 'error'
	| 'cancelled';

export type AgentStepStatus = 'pending' | 'running' | 'success' | 'warning' | 'error' | 'cancelled';

export interface AgentStep {
	readonly id: string;
	readonly label: string;
	readonly status: AgentStepStatus;
	readonly startedAt: number;
	readonly completedAt?: number;
}

export interface AgentToolCall {
	readonly id: string;
	readonly name: string;
	readonly parameters: Readonly<Record<string, unknown>>;
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly status: 'running' | 'success' | 'error' | 'cancelled';
	readonly error?: string;
}

export interface AgentModifiedFile {
	readonly resource: URI;
	readonly editKind: 'create' | 'delete' | 'rename' | 'edit';
	readonly originalResource?: URI;
	readonly beforeContent?: string;
	readonly afterContent?: string;
	readonly added: number;
	readonly removed: number;
	readonly toolCallId: string;
}

export interface AgentTerminalRun {
	readonly toolCallId: string;
	readonly command: string;
	readonly cwd: string;
	readonly terminalInstanceId?: number;
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly exitCode?: number;
	readonly output: string;
	readonly lineCount: number;
	readonly truncated: boolean;
}

export interface AgentVerification {
	readonly toolCallId: string;
	readonly label: string;
	readonly command: string;
	readonly status: 'running' | 'passed' | 'failed';
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly detail?: string;
}

export interface AgentSessionState {
	readonly id: string;
	readonly model: string;
	readonly status: AgentSessionStatus;
	readonly statusMessage?: string;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly steps: readonly AgentStep[];
	readonly modifiedFiles: readonly AgentModifiedFile[];
	readonly plan: readonly PlanStep[];
	readonly activeToolCall?: AgentToolCall;
	readonly terminalRuns: readonly AgentTerminalRun[];
	readonly verifications: readonly AgentVerification[];
	readonly error?: string;
}

export type AgentSessionEvent =
	| { readonly kind: 'stateChanged'; readonly state: AgentSessionState }
	| { readonly kind: 'toolStarted'; readonly tool: AgentToolCall }
	| { readonly kind: 'toolFinished'; readonly tool: AgentToolCall }
	| { readonly kind: 'planChanged'; readonly plan: readonly PlanStep[] }
	| { readonly kind: 'fileChanged'; readonly file: AgentModifiedFile }
	| { readonly kind: 'terminalChanged'; readonly terminal: AgentTerminalRun; readonly completed: boolean }
	| { readonly kind: 'verificationChanged'; readonly verification: AgentVerification }
	| { readonly kind: 'contextCompaction'; readonly tokens: number }
	| { readonly kind: 'completed'; readonly state: AgentSessionState };

const MAX_TERMINAL_LINES = 1_000;
const MAX_TERMINAL_CHARACTERS = 120_000;

/** Single runtime-owned source of truth for one agent request. */
export class AgentSessionModel extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<AgentSessionEvent>());
	readonly onDidChange: Event<AgentSessionEvent> = this._onDidChange.event;

	private status: AgentSessionStatus = 'idle';
	private statusMessage: string | undefined;
	private startedAt: number | undefined;
	private completedAt: number | undefined;
	private error: string | undefined;
	private readonly steps: AgentStep[] = [];
	private readonly tools = new Map<string, AgentToolCall>();
	private readonly modifiedFiles = new Map<string, AgentModifiedFile>();
	private plan: readonly PlanStep[] = [];
	private activeToolCall: AgentToolCall | undefined;
	private readonly terminalRuns = new Map<string, AgentTerminalRun>();
	private readonly verifications = new Map<string, AgentVerification>();

	constructor(readonly id: string, readonly model: string) {
		super();
	}

	get snapshot(): AgentSessionState {
		return {
			id: this.id,
			model: this.model,
			status: this.status,
			statusMessage: this.statusMessage,
			startedAt: this.startedAt,
			completedAt: this.completedAt,
			steps: [...this.steps],
			modifiedFiles: [...this.modifiedFiles.values()],
			plan: [...this.plan],
			activeToolCall: this.activeToolCall,
			terminalRuns: [...this.terminalRuns.values()],
			verifications: [...this.verifications.values()],
			error: this.error,
		};
	}

	start(message?: string): void {
		this.startedAt = Date.now();
		this.setStatus('planning', message);
	}

	setStatus(status: AgentSessionStatus, message?: string): void {
		this.status = status;
		this.statusMessage = message;
		this._onDidChange.fire({ kind: 'stateChanged', state: this.snapshot });
	}

	setRuntimePhase(phase: AgentRuntimePhase, message?: string): void {
		const status: AgentSessionStatus = phase === 'classifying' || phase === 'compacting' ? 'thinking'
			: phase === 'exploring' ? 'searching'
				: phase === 'planning' || phase === 'replanning' || phase === 'recovering' ? 'planning'
					: phase === 'running_tool' ? 'running_tool'
						: phase === 'applying' ? 'editing'
							: phase === 'verifying' ? 'verifying'
								: phase === 'debugging' ? 'debugging'
									: phase === 'waiting_user' ? 'waiting'
										: phase === 'completed' ? 'done'
											: phase === 'cancelled' ? 'cancelled'
												: phase === 'failed' ? 'error'
													: 'thinking';
		this.setStatus(status, message);
	}

	beginTool(id: string, name: string, parameters: Readonly<Record<string, unknown>>, label = name): void {
		const tool: AgentToolCall = { id, name, parameters: sanitizeDisplayValue(parameters) as Readonly<Record<string, unknown>>, startedAt: Date.now(), status: 'running' };
		this.tools.set(id, tool);
		this.activeToolCall = tool;
		this.steps.push({ id, label, status: 'running', startedAt: tool.startedAt });
		this.setStatus(statusForTool(name));
		this._onDidChange.fire({ kind: 'toolStarted', tool });
	}

	finishTool(id: string, error?: string, cancelled = false): void {
		const previous = this.tools.get(id);
		if (!previous) {
			return;
		}
		const completedAt = Date.now();
		const tool: AgentToolCall = {
			...previous,
			completedAt,
			status: cancelled ? 'cancelled' : error ? 'error' : 'success',
			error,
		};
		this.tools.set(id, tool);
		if (this.activeToolCall?.id === id) {
			this.activeToolCall = undefined;
		}
		const stepIndex = this.steps.findIndex(step => step.id === id);
		if (stepIndex >= 0) {
			this.steps[stepIndex] = {
				...this.steps[stepIndex],
				completedAt,
				status: cancelled ? 'cancelled' : error ? 'error' : 'success',
			};
		}
		this._onDidChange.fire({ kind: 'toolFinished', tool });
	}

	updatePlan(plan: readonly PlanStep[]): void {
		this.plan = plan.map(step => ({ ...step, dependsOn: [...step.dependsOn], acceptanceCriteria: [...step.acceptanceCriteria], evidence: [...step.evidence], files: step.files ? [...step.files] : undefined, affectedFiles: step.affectedFiles ? [...step.affectedFiles] : undefined, verification: step.verification ? [...step.verification] : undefined }));
		this._onDidChange.fire({ kind: 'planChanged', plan: this.plan });
	}

	recordFileChange(file: AgentModifiedFile): void {
		this.modifiedFiles.set(file.resource.toString(), file);
		this._onDidChange.fire({ kind: 'fileChanged', file });
	}

	startTerminal(toolCallId: string, command: string, cwd: string, terminalInstanceId?: number): void {
		const existing = this.terminalRuns.get(toolCallId);
		const terminal: AgentTerminalRun = existing ? { ...existing, terminalInstanceId: terminalInstanceId ?? existing.terminalInstanceId } : {
			toolCallId,
			command: redactSecrets(command),
			cwd,
			terminalInstanceId,
			startedAt: Date.now(),
			output: '',
			lineCount: 0,
			truncated: false,
		};
		this.terminalRuns.set(toolCallId, terminal);
		this._onDidChange.fire({ kind: 'terminalChanged', terminal, completed: false });
	}

	appendTerminalOutput(toolCallId: string, data: string): void {
		const previous = this.terminalRuns.get(toolCallId);
		if (!previous || previous.completedAt !== undefined) {
			return;
		}
		const bounded = boundTerminalOutput(previous.output + redactSecrets(data));
		const terminal = { ...previous, ...bounded, truncated: previous.truncated || bounded.truncated };
		this.terminalRuns.set(toolCallId, terminal);
		this._onDidChange.fire({ kind: 'terminalChanged', terminal, completed: false });
	}

	finishTerminal(toolCallId: string, exitCode: number | undefined, output?: string): void {
		const previous = this.terminalRuns.get(toolCallId);
		if (!previous) {
			return;
		}
		if (previous.completedAt !== undefined && previous.exitCode === exitCode && (output === undefined || previous.output === output)) {
			return;
		}
		const bounded = boundTerminalOutput(redactSecrets(output ?? previous.output));
		const terminal: AgentTerminalRun = {
			...previous,
			completedAt: Date.now(),
			exitCode,
			output: bounded.output,
			lineCount: bounded.lineCount,
			truncated: previous.truncated || bounded.truncated,
		};
		this.terminalRuns.set(toolCallId, terminal);
		this._onDidChange.fire({ kind: 'terminalChanged', terminal, completed: true });
	}

	startVerification(toolCallId: string, label: string, command: string): void {
		const verification: AgentVerification = { toolCallId, label, command: redactSecrets(command), status: 'running', startedAt: Date.now() };
		this.verifications.set(toolCallId, verification);
		this.setStatus('verifying', label);
		this._onDidChange.fire({ kind: 'verificationChanged', verification });
	}

	finishVerification(toolCallId: string, passed: boolean, detail: string): void {
		const previous = this.verifications.get(toolCallId);
		if (!previous) {
			return;
		}
		const verification: AgentVerification = { ...previous, status: passed ? 'passed' : 'failed', completedAt: Date.now(), detail };
		this.verifications.set(toolCallId, verification);
		this._onDidChange.fire({ kind: 'verificationChanged', verification });
	}

	recordContextCompaction(tokens: number): void {
		this._onDidChange.fire({ kind: 'contextCompaction', tokens });
	}

	complete(status: 'done' | 'error' | 'cancelled', error?: string): void {
		this.status = status;
		this.statusMessage = undefined;
		this.error = error;
		this.completedAt = Date.now();
		this._onDidChange.fire({ kind: 'completed', state: this.snapshot });
	}
}

function statusForTool(name: string): AgentSessionStatus {
	if (name === 'update_task_plan') {
		return 'planning';
	}
	if (['apply_diff', 'apply_patch_transaction', 'write_to_file', 'create_directory', 'delete_file', 'rollback_task_changes'].includes(name)) {
		return 'editing';
	}
	if (['run_tests', 'build'].includes(name)) {
		return 'verifying';
	}
	if (['search_files', 'grep', 'fuzzy_find_files'].includes(name)) {
		return 'searching';
	}
	return 'running_tool';
}

function countLines(value: string): number {
	if (!value) {
		return 0;
	}
	return value.split('\n').length;
}

function boundTerminalOutput(value: string): { output: string; lineCount: number; truncated: boolean } {
	let output = value;
	let truncated = false;
	const lines = output.split('\n');
	if (lines.length > MAX_TERMINAL_LINES) {
		output = lines.slice(-MAX_TERMINAL_LINES).join('\n');
		truncated = true;
	}
	if (output.length > MAX_TERMINAL_CHARACTERS) {
		output = output.slice(-MAX_TERMINAL_CHARACTERS);
		truncated = true;
	}
	return { output, lineCount: countLines(output), truncated };
}

function sanitizeDisplayValue(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') {return redactSecrets(value);}
	if (depth > 8) {return '[TRUNCATED]';}
	if (Array.isArray(value)) {return value.map(item => sanitizeDisplayValue(item, depth + 1));}
	if (value && typeof value === 'object') {return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDisplayValue(item, depth + 1)]));}
	return value;
}
