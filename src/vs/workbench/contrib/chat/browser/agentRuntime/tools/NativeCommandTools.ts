/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TerminalManager } from '../terminal/TerminalManager.js';
import { INativeTool, NativeToolSchema } from './INativeTool.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { hasShellControlOperators } from '../utils/AgentCommandPolicy.js';
import { TerminalSandboxBoundary } from '../terminal/TerminalSandboxBoundary.js';

type CommandKind = 'run_command' | 'run_background' | 'run_tests' | 'build' | 'git_diff' | 'git_status' | 'git_log' | 'git_checkout' | 'package_manager';

const fixedCommands: Partial<Record<CommandKind, string>> = {
	git_diff: 'git diff --',
	git_status: 'git status --short --branch',
	git_log: 'git log --oneline -20'
};

function quoteArg(value: string): string {
	if (!/^[A-Za-z0-9._/@:+\\/-]+$/.test(value)) {throw new Error('Invalid command argument. Shell metacharacters are not allowed.');}
	return value;
}

export class NativeCommandTool implements INativeTool {
	public readonly name: CommandKind;
	public readonly description: string;
	public readonly inputSchema: NativeToolSchema;

	constructor(private readonly terminalManager: TerminalManager, private readonly sandboxBoundary: TerminalSandboxBoundary, kind: CommandKind, description: string) {
		this.name = kind;
		this.description = description;
		this.inputSchema = { type: 'object', additionalProperties: false, properties: { command: { type: 'string', minLength: 1, maxLength: 32_768 }, packageManager: { type: 'string', enum: ['npm', 'pnpm', 'yarn', 'cargo', 'pip'] }, arguments: { type: 'string', maxLength: 8_192 }, ref: { type: 'string', minLength: 1, maxLength: 512 }, mode: { type: 'string', enum: ['switch', 'restore_file'] }, path: { type: 'string', minLength: 1, maxLength: 32_768 } }, required: kind === 'git_checkout' ? ['mode', 'ref'] : (kind === 'package_manager' ? ['packageManager'] : (fixedCommands[kind] ? [] : ['command'])) };
	}

	public async execute(parameters: { command?: string; packageManager?: string; arguments?: string; ref?: string; mode?: 'switch' | 'restore_file'; path?: string }, cwd: string, _progress?: unknown, token: CancellationToken = CancellationToken.None): Promise<{ terminalId: number; terminalInstanceId: number; exitCode?: number; output: string }> {
		let command = fixedCommands[this.name];
		if (this.name === 'git_checkout') {
			const ref = quoteArg(parameters.ref || '');
			if (parameters.mode === 'switch') {command = `git switch ${ref}`;}
			else if (parameters.mode === 'restore_file' && parameters.path) {command = `git restore --source=${ref} -- ${quoteArg(parameters.path)}`;}
			else {throw new Error('git_checkout requires mode=switch, or mode=restore_file with path.');}
		}
		else if (this.name === 'package_manager') {
			const manager = parameters.packageManager;
			if (!manager || !['npm', 'pnpm', 'yarn', 'cargo', 'pip'].includes(manager)) {throw new Error('packageManager must be npm, pnpm, yarn, cargo, or pip');}
			if (hasShellControlOperators(parameters.arguments ?? '')) {throw new Error('Package-manager arguments may not contain shell control operators. Run one direct package-manager operation at a time.');}
			command = `${manager} ${parameters.arguments || ''}`.trim();
		} else if (this.name === 'run_command' || this.name === 'run_background' || this.name === 'run_tests' || this.name === 'build') {
			command = parameters.command?.trim();
		}
		if (!command) {throw new Error('command is required');}
		const prepared = await this.sandboxBoundary.prepare(command, cwd);
		return this.terminalManager.executeCommand(prepared.command, cwd, this.name === 'run_background', undefined, token);
	}
}
