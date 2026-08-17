/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import * as nls from '../../../../../../nls.js';
import { IChatExternalToolInvocationUpdate, IChatProgress, IChatTerminalToolInvocationData } from '../../../common/chatService/chatService.js';
import { AgentModifiedFile, AgentSessionEvent, AgentSessionModel, AgentSessionStatus, AgentTerminalRun, AgentToolCall } from '../AgentSessionModel.js';
import { AgentSnapshotContentProvider } from './AgentSnapshotContentProvider.js';

const READ_TOOLS = new Set(['read_file', 'list_dir', 'list_directory']);
const SILENT_RAG_TOOLS = new Set(['search_codebase', 'codebase_search']);
const TERMINAL_TOOLS = new Set(['execute_command', 'run_tests', 'build', 'git_diff', 'git_status', 'git_log', 'git_checkout', 'package_manager']);

/** Maps structured runtime events to the existing, virtualized Chat Workbench renderer. */
export class AgentChatProgressAdapter extends Disposable {
	private readonly pendingTerminals = new Map<string, AgentTerminalRun>();
	private readonly terminalToolCalls = new Set<string>();
	private readonly terminalFlushScheduler = this._register(new RunOnceScheduler(() => this.flushTerminals(), 50));
	private readGroupId: string | undefined;
	private readGroupSequence = 0;
	private readonly readResources = new Set<string>();
	private planVisible = false;
	private lastPlan: AgentSessionEvent & { kind: 'planChanged' } | undefined;

	constructor(
		private readonly session: AgentSessionModel,
		private readonly progress: (part: IChatProgress) => void,
		private readonly snapshots: AgentSnapshotContentProvider,
	) {
		super();
		this._register(session.onDidChange(event => this.handleEvent(event)));
	}

	private handleEvent(event: AgentSessionEvent): void {
		switch (event.kind) {
			case 'stateChanged':
				this.renderStatus(event.state.status, event.state.statusMessage);
				break;
			case 'toolStarted':
				this.renderToolStarted(event.tool);
				break;
			case 'toolFinished':
				this.renderToolFinished(event.tool);
				break;
			case 'planChanged':
				this.renderPlan(event);
				break;
			case 'fileChanged':
				this.renderFile(event.file);
				break;
			case 'terminalChanged':
				this.renderTerminal(event.terminal, event.completed);
				break;
			case 'verificationChanged':
				this.progress({
					kind: 'progressMessage',
					id: `${this.session.id}:verification:${event.verification.toolCallId}`,
					content: new MarkdownString(verificationLabel(event.verification.label, event.verification.status, event.verification.detail)),
					shimmer: event.verification.status === 'running',
				});
				break;
			case 'contextCompaction':
				this.progress({
					kind: 'progressMessage',
					id: `${this.session.id}:context`,
					content: new MarkdownString(nls.localize('nativeAgent.contextCompaction', "Optimizing the working context ({0} tokens)…", event.tokens)),
					shimmer: true,
				});
				break;
			case 'completed':
				this.flushReadGroup();
				this.flushTerminals();
				this.completePlan();
				this.renderStatus(event.state.status, event.state.error);
				break;
		}
	}

	private renderStatus(status: AgentSessionStatus, detail?: string): void {
		if (status === 'thinking') {
			this.flushReadGroup();
		}
		const active = !['idle', 'done', 'error', 'cancelled'].includes(status);
		this.progress({
			kind: 'progressMessage',
			id: `${this.session.id}:status`,
			content: new MarkdownString(statusLabel(status, detail)),
			shimmer: active,
		});
	}

	private renderToolStarted(tool: AgentToolCall): void {
		if (SILENT_RAG_TOOLS.has(tool.name) || tool.name === 'update_task_plan') {
			return;
		}
		if (READ_TOOLS.has(tool.name)) {
			this.addToReadGroup(tool);
			return;
		}
		this.flushReadGroup();
		this.progress(this.toolUpdate(tool, false));
	}

	private renderToolFinished(tool: AgentToolCall): void {
		if (SILENT_RAG_TOOLS.has(tool.name) || tool.name === 'update_task_plan' || READ_TOOLS.has(tool.name)) {
			return;
		}
		if (TERMINAL_TOOLS.has(tool.name) && this.terminalToolCalls.has(tool.id)) {
			return;
		}
		this.progress(this.toolUpdate(tool, true));
	}

	private toolUpdate(tool: AgentToolCall, complete: boolean): IChatExternalToolInvocationUpdate {
		const message = toolLabel(tool.name, tool.parameters, false);
		const pastTenseMessage = toolLabel(tool.name, tool.parameters, true);
		return {
			kind: 'externalToolInvocationUpdate',
			toolCallId: tool.id,
			toolName: tool.name,
			isComplete: complete,
			invocationMessage: message,
			pastTenseMessage,
			errorMessage: tool.error,
			toolSpecificData: TERMINAL_TOOLS.has(tool.name) ? terminalData(tool, undefined) : {
				kind: 'input',
				rawInput: safeToolInput(tool.parameters),
			},
		};
	}

	private addToReadGroup(tool: AgentToolCall): void {
		if (!this.readGroupId) {
			this.readGroupId = `${this.session.id}:reads:${++this.readGroupSequence}`;
			this.readResources.clear();
		}
		const resource = tool.parameters.path ?? tool.parameters.filePath;
		if (typeof resource === 'string' && resource) {
			this.readResources.add(resource);
		}
		const count = Math.max(1, this.readResources.size);
		this.progress({
			kind: 'externalToolInvocationUpdate',
			toolCallId: this.readGroupId,
			toolName: 'read_file_group',
			isComplete: false,
			invocationMessage: nls.localize('nativeAgent.readingFiles', "Reading {0} files", count),
			toolSpecificData: { kind: 'input', rawInput: { files: [...this.readResources] } },
		});
	}

	private flushReadGroup(): void {
		if (!this.readGroupId) {
			return;
		}
		const count = Math.max(1, this.readResources.size);
		this.progress({
			kind: 'externalToolInvocationUpdate',
			toolCallId: this.readGroupId,
			toolName: 'read_file_group',
			isComplete: true,
			pastTenseMessage: count === 1
				? nls.localize('nativeAgent.readOneFile', "Read 1 file")
				: nls.localize('nativeAgent.readFiles', "Read {0} files", count),
			toolSpecificData: { kind: 'input', rawInput: { files: [...this.readResources] } },
		});
		this.readGroupId = undefined;
		this.readResources.clear();
	}

	private renderPlan(event: AgentSessionEvent & { kind: 'planChanged' }): void {
		this.lastPlan = event;
		this.planVisible = true;
		this.progress({
			kind: 'externalToolInvocationUpdate',
			toolCallId: `${this.session.id}:plan`,
			toolName: 'agent_plan',
			isComplete: false,
			invocationMessage: nls.localize('nativeAgent.plan', "Plan"),
			toolSpecificData: {
				kind: 'todoList',
				todoList: event.plan.map(step => ({
					id: step.id,
					title: step.step,
					status: step.status === 'completed' ? 'completed' : step.status === 'in_progress' ? 'in-progress' : 'not-started',
				})),
			},
		});
	}

	private completePlan(): void {
		if (!this.planVisible || !this.lastPlan) {
			return;
		}
		this.progress({
			kind: 'externalToolInvocationUpdate',
			toolCallId: `${this.session.id}:plan`,
			toolName: 'agent_plan',
			isComplete: true,
			pastTenseMessage: nls.localize('nativeAgent.planUpdated', "Updated plan"),
			toolSpecificData: {
				kind: 'todoList',
				todoList: this.lastPlan.plan.map(step => ({
					id: step.id,
					title: step.step,
					status: step.status === 'completed' ? 'completed' : step.status === 'in_progress' ? 'in-progress' : 'not-started',
				})),
			},
		});
		this.planVisible = false;
	}

	private renderFile(file: AgentModifiedFile): void {
		const beforeContentUri = file.beforeContent === undefined ? undefined : this.snapshots.add(this.session.id, file.resource, file.beforeContent, 'before');
		const afterContentUri = file.afterContent === undefined ? undefined : this.snapshots.add(this.session.id, file.resource, file.afterContent, 'after');
		this.progress({
			kind: 'externalEdit',
			uri: file.resource,
			editKind: file.editKind,
			originalUri: file.originalResource,
			beforeContentUri,
			afterContentUri,
			diff: { added: file.added, removed: file.removed },
			undoStopId: file.toolCallId,
		});
	}

	private renderTerminal(terminal: AgentTerminalRun, completed: boolean): void {
		this.terminalToolCalls.add(terminal.toolCallId);
		this.pendingTerminals.set(terminal.toolCallId, terminal);
		if (completed) {
			this.flushTerminal(terminal.toolCallId);
			if (terminal.terminalInstanceId !== undefined) {
				this.progress({
					kind: 'command',
					command: {
						id: 'folzeur.agent.openTerminal',
						title: nls.localize('nativeAgent.openTerminal', "Open Terminal"),
						arguments: [terminal.terminalInstanceId],
					},
				});
			}
		} else {
			this.terminalFlushScheduler.schedule();
		}
	}

	private flushTerminals(): void {
		for (const toolCallId of [...this.pendingTerminals.keys()]) {
			this.flushTerminal(toolCallId);
		}
	}

	private flushTerminal(toolCallId: string): void {
		const terminal = this.pendingTerminals.get(toolCallId);
		if (!terminal) {
			return;
		}
		this.pendingTerminals.delete(toolCallId);
		const completed = terminal.completedAt !== undefined;
		this.progress({
			kind: 'externalToolInvocationUpdate',
			toolCallId,
			toolName: 'run_in_terminal',
			isComplete: completed,
			invocationMessage: nls.localize('nativeAgent.runningCommand', "Running {0}", terminal.command),
			pastTenseMessage: completed ? nls.localize('nativeAgent.ranCommand', "Ran {0}", terminal.command) : undefined,
			errorMessage: completed && terminal.exitCode !== undefined && terminal.exitCode !== 0
				? nls.localize('nativeAgent.commandFailed', "Command exited with code {0}.", terminal.exitCode)
				: undefined,
			toolSpecificData: terminalData(undefined, terminal),
		});
	}
}

function terminalData(tool: AgentToolCall | undefined, terminal: AgentTerminalRun | undefined): IChatTerminalToolInvocationData {
	const command = terminal?.command ?? String(tool?.parameters.command ?? '');
	const cwd = terminal?.cwd ?? (typeof tool?.parameters.cwd === 'string' ? tool.parameters.cwd : undefined);
	return {
		kind: 'terminal',
		commandLine: { original: command, forDisplay: command },
		cwd: cwd ? URI.file(cwd) : undefined,
		language: 'shellscript',
		isPty: false,
		terminalCommandOutput: terminal ? { text: terminal.output, truncated: terminal.truncated, lineCount: terminal.lineCount } : undefined,
		terminalCommandState: terminal ? {
			exitCode: terminal.completedAt === undefined ? undefined : terminal.exitCode,
			timestamp: terminal.startedAt,
			duration: terminal.completedAt === undefined ? undefined : terminal.completedAt - terminal.startedAt,
		} : undefined,
	};
}

function safeToolInput(parameters: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const allowed = ['path', 'filePath', 'query', 'pattern', 'includes', 'cwd', 'action', 'url', 'line', 'column'];
	const result: Record<string, unknown> = {};
	for (const key of allowed) {
		if (parameters[key] !== undefined) {
			result[key] = parameters[key];
		}
	}
	return result;
}

function statusLabel(status: AgentSessionStatus, detail?: string): string {
	if (detail) {
		return detail;
	}
	switch (status) {
		case 'idle': return nls.localize('nativeAgent.idle', "Ready");
		case 'thinking': return nls.localize('nativeAgent.thinking', "Thinking…");
		case 'planning': return nls.localize('nativeAgent.planning', "Planning implementation…");
		case 'searching': return nls.localize('nativeAgent.searching', "Searching…");
		case 'running_tool': return nls.localize('nativeAgent.runningTool', "Running tool…");
		case 'editing': return nls.localize('nativeAgent.editing', "Editing files…");
		case 'verifying': return nls.localize('nativeAgent.verifying', "Verifying changes…");
		case 'debugging': return nls.localize('nativeAgent.debugging', "Investigating failure…");
		case 'waiting': return nls.localize('nativeAgent.waiting', "Waiting for approval…");
		case 'done': return nls.localize('nativeAgent.done', "Done");
		case 'error': return nls.localize('nativeAgent.error', "Agent task failed");
		case 'cancelled': return nls.localize('nativeAgent.cancelled', "Cancelled");
	}
}

function toolLabel(name: string, parameters: Readonly<Record<string, unknown>>, completed: boolean): string {
	const path = String(parameters.path ?? parameters.filePath ?? '');
	const command = String(parameters.command ?? '');
	switch (name) {
		case 'apply_diff': return completed ? nls.localize('nativeAgent.appliedEdit', "Updated {0}", path) : nls.localize('nativeAgent.applyingEdit', "Updating {0}", path);
		case 'apply_patch_transaction': return completed ? nls.localize('nativeAgent.appliedEdits', "Updated files") : nls.localize('nativeAgent.applyingEdits', "Updating files");
		case 'write_to_file': return completed ? nls.localize('nativeAgent.wroteFile', "Wrote {0}", path) : nls.localize('nativeAgent.writingFile', "Writing {0}", path);
		case 'delete_file': return completed ? nls.localize('nativeAgent.deletedFile', "Deleted {0}", path) : nls.localize('nativeAgent.deletingFile', "Deleting {0}", path);
		case 'search_files':
		case 'grep':
		case 'fuzzy_find_files': return completed ? nls.localize('nativeAgent.searchedWorkspace', "Searched workspace") : nls.localize('nativeAgent.searchingWorkspace', "Searching workspace");
		case 'run_tests': return completed ? nls.localize('nativeAgent.ranTests', "Ran tests") : nls.localize('nativeAgent.runningTests', "Running tests");
		case 'build': return completed ? nls.localize('nativeAgent.ranBuild', "Ran build") : nls.localize('nativeAgent.runningBuild', "Running build");
		case 'launch_local_app': return completed ? nls.localize('nativeAgent.launchedLocalApp', "Launched local application") : nls.localize('nativeAgent.launchingLocalApp', "Launching local application");
		case 'execute_command':
		case 'package_manager': return completed ? nls.localize('nativeAgent.ranTerminalCommand', "Ran {0}", command) : nls.localize('nativeAgent.runningTerminalCommand', "Running {0}", command);
		case 'attempt_completion': return completed ? nls.localize('nativeAgent.reviewedCompletion', "Reviewed completion") : nls.localize('nativeAgent.reviewingCompletion', "Reviewing completion");
		default: return completed ? nls.localize('nativeAgent.completedTool', "Completed {0}", name) : nls.localize('nativeAgent.executingTool', "Running {0}", name);
	}
}

function verificationLabel(label: string, status: 'running' | 'passed' | 'failed', detail?: string): string {
	const displayLabel = label === 'run_tests'
		? nls.localize('nativeAgent.tests', "Tests")
		: label === 'build'
			? nls.localize('nativeAgent.build', "Build")
			: label;
	if (status === 'running') {
		return nls.localize('nativeAgent.verificationRunning', "Verifying: {0}", displayLabel);
	}
	if (status === 'passed') {
		return `$(check) ${nls.localize('nativeAgent.verificationPassed', "{0} passed", displayLabel)}`;
	}
	return detail
		? `$(error) ${nls.localize('nativeAgent.verificationFailedDetail', "{0}: {1}", displayLabel, detail)}`
		: `$(error) ${nls.localize('nativeAgent.verificationFailed', "{0} failed", displayLabel)}`;
}
