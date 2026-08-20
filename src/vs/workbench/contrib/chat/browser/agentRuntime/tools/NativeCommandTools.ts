/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TerminalManager } from '../terminal/TerminalManager.js';
import { INativeTool, NativeToolSchema } from './INativeTool.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { hasShellControlOperators } from '../utils/AgentCommandPolicy.js';
import { TerminalSandboxBoundary } from '../terminal/TerminalSandboxBoundary.js';

export type CommandKind = 'run_command' | 'run_background' | 'run_tests' | 'build' | 'git_diff' | 'git_status' | 'git_log' | 'git_checkout' | 'package_manager';

const fixedCommands: Partial<Record<CommandKind, string>> = {
	git_status: 'git status --short --branch',
	git_log: 'git log --oneline -20'
};

function quoteArg(value: string): string {
	if (!/^[A-Za-z0-9._/@:+\\/-]+$/.test(value)) {throw new Error('Invalid command argument. Shell metacharacters are not allowed.');}
	return value;
}

function quoteWorkspacePath(value: string): string {
	if (!/^[A-Za-z0-9._/@+\\/\- ]+$/.test(value)) {throw new Error('Invalid Git path. Shell metacharacters are not allowed.');}
	const normalized = value.replace(/\\/g, '/');
	if (/^(?:[A-Za-z]:|\/)/.test(normalized) || normalized.split('/').includes('..')) {throw new Error('Git paths must be workspace-relative and may not traverse parent directories.');}
	return `"${normalized}"`;
}

export function resolveNativeCommand(kind: CommandKind, parameters: { command?: unknown; packageManager?: unknown; arguments?: unknown; ref?: unknown; mode?: unknown; path?: unknown }): string {
	if (kind === 'git_diff') {return `git diff --${parameters.path ? ` ${quoteWorkspacePath(String(parameters.path))}` : ''}`;}
	if (kind === 'git_checkout') {
		const ref = quoteArg(String(parameters.ref ?? ''));
		if (parameters.mode === 'switch') {return `git switch ${ref}`;}
		if (parameters.mode === 'restore_file' && parameters.path) {return `git restore --source=${ref} -- ${quoteWorkspacePath(String(parameters.path))}`;}
		return '';
	}
	if (kind === 'package_manager') {return `${String(parameters.packageManager ?? '')} ${String(parameters.arguments ?? '')}`.trim();}
	return fixedCommands[kind] ?? String(parameters.command ?? '').trim();
}

export class NativeCommandTool implements INativeTool {
	public readonly name: CommandKind;
	public readonly description: string;
	public readonly inputSchema: NativeToolSchema;

	constructor(private readonly terminalManager: TerminalManager, private readonly sandboxBoundary: TerminalSandboxBoundary, kind: CommandKind, description: string, private readonly internalDiff?: (path?: string) => Promise<string>) {
		this.name = kind;
		this.description = description;
		this.inputSchema = { type: 'object', additionalProperties: false, properties: { command: { type: 'string', minLength: 1, maxLength: 32_768 }, packageManager: { type: 'string', enum: ['npm', 'pnpm', 'yarn', 'bun', 'deno', 'cargo', 'pip', 'uv', 'poetry', 'composer', 'bundle', 'go', 'dotnet', 'mvn', 'gradle'] }, arguments: { type: 'string', maxLength: 8_192 }, ref: { type: 'string', minLength: 1, maxLength: 512 }, mode: { type: 'string', enum: ['switch', 'restore_file'] }, path: { type: 'string', minLength: 1, maxLength: 32_768 }, allowUnsandboxedHost: { type: 'boolean' }, timeoutMs: { type: 'integer', minimum: 1_000, maximum: 3_600_000 } }, required: kind === 'git_checkout' ? ['mode', 'ref'] : (kind === 'package_manager' ? ['packageManager'] : (fixedCommands[kind] || kind === 'git_diff' ? [] : ['command'])) };
	}

	public async execute(parameters: { command?: string; packageManager?: string; arguments?: string; ref?: string; mode?: 'switch' | 'restore_file'; path?: string; allowUnsandboxedHost?: boolean; timeoutMs?: number }, cwd: string, _progress?: unknown, token: CancellationToken = CancellationToken.None): Promise<{ terminalId: number; terminalInstanceId: number; exitCode?: number; output: string }> {
		if (this.name === 'git_diff') {
			const pathArgument = parameters.path ? ` ${quoteWorkspacePath(parameters.path)}` : '';
			const diffCommand = `git diff --${pathArgument}`;
			const preparedDiff = await this.sandboxBoundary.prepare(diffCommand, cwd, false);
			const diff = await this.terminalManager.executeCommand(preparedDiff.command, cwd, false, undefined, token);
			if (diff.exitCode !== 0) {
				if (!this.internalDiff) {return diff;}
				return { ...diff, exitCode: 0, output: `[Internal snapshot diff; Git unavailable]\n${await this.internalDiff(parameters.path)}` };
			}
			const statusCommand = `git status --short --untracked-files=all --${pathArgument}`;
			const preparedStatus = await this.sandboxBoundary.prepare(statusCommand, cwd, false);
			const status = await this.terminalManager.executeCommand(preparedStatus.command, cwd, false, undefined, token);
			if (status.exitCode !== 0) {return status;}
			const untracked = status.output.trim();
			const output = `${diff.output.trim()}${untracked ? `\n\n[Git status, including untracked files]\n${untracked}` : ''}`.trim() || 'Working tree has no changes for the selected path.';
			return { ...status, output };
		}
		let command = fixedCommands[this.name];
		if (this.name === 'git_checkout') {
			command = resolveNativeCommand(this.name, parameters);
			if (parameters.mode === 'switch') { /* resolved above */ }
			else if (parameters.mode === 'restore_file' && parameters.path) { /* resolved above */ }
			else {throw new Error('git_checkout requires mode=switch, or mode=restore_file with path.');}
		}
		else if (this.name === 'package_manager') {
			const manager = parameters.packageManager;
			if (!manager || !['npm', 'pnpm', 'yarn', 'bun', 'deno', 'cargo', 'pip', 'uv', 'poetry', 'composer', 'bundle', 'go', 'dotnet', 'mvn', 'gradle'].includes(manager)) {throw new Error('Unsupported package manager.');}
			if (hasShellControlOperators(parameters.arguments ?? '')) {throw new Error('Package-manager arguments may not contain shell control operators. Run one direct package-manager operation at a time.');}
			command = resolveNativeCommand(this.name, parameters);
		} else if (this.name === 'run_command' || this.name === 'run_background' || this.name === 'run_tests' || this.name === 'build') {
			command = parameters.command?.trim();
		}
		if (!command) {throw new Error('command is required');}
		const prepared = await this.sandboxBoundary.prepare(command, cwd, parameters.allowUnsandboxedHost === true);
		return this.terminalManager.executeCommand(prepared.command, cwd, this.name === 'run_background', parameters.timeoutMs, token);
	}
}
