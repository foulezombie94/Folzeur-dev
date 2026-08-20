/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeTool } from './INativeTool.js';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { TerminalSandboxBoundary } from '../terminal/TerminalSandboxBoundary.js';
import { ITerminalProfileResolverService } from '../../../../../contrib/terminal/common/terminal.js';
import { resolveAgentShellEnvironment, validateCommandDialect } from '../terminal/TerminalShellEnvironment.js';
import { IRemoteAgentService } from '../../../../../services/remote/common/remoteAgentService.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';

export class NativeExecuteCommandTool implements INativeTool {
	public readonly name = 'execute_command';
	public readonly description = 'Execute one raw command using the exact active shell dialect stated in the system environment. Inspect the project manifest before choosing a project command. Set isBackground=true for servers and long-running applications; use launch_local_app when the goal is simply to start the project.';
	public readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			command: {
				type: 'string', minLength: 1, maxLength: 32_768,
				description: 'The shell command to execute.'
			},
			commands: {
				type: 'array', minItems: 1, maxItems: 20,
				items: { type: 'string', minLength: 1, maxLength: 32_768 },
				description: 'A structured sequence of direct commands. Each command is validated and sandboxed independently; execution stops on the first failure.'
			},
			isBackground: {
				type: 'boolean',
				description: 'If true, the command will run in the background and this tool will return immediately.'
			},
			allowUnsandboxedHost: { type: 'boolean', description: 'Explicitly request host execution when the OS sandbox is unavailable. This always requires confirmation for non-read-only commands.' }
			,timeoutMs: { type: 'integer', minimum: 1_000, maximum: 3_600_000, description: 'Foreground timeout. Defaults to 10 minutes; use a longer bounded value for builds.' },
			persistAfterTask: { type: 'boolean', description: 'Keep a background process alive after the task ends. This always requires explicit confirmation.' }
		},
		required: []
	};

	constructor(private readonly terminalManager: TerminalManager, private readonly sandboxBoundary: TerminalSandboxBoundary, private readonly terminalProfileResolverService: ITerminalProfileResolverService, private readonly remoteAgentService: IRemoteAgentService, private readonly environmentService: IWorkbenchEnvironmentService) {
	}

	public async execute(parameters: { command?: string; commands?: string[]; isBackground?: boolean; allowUnsandboxedHost?: boolean; timeoutMs?: number; persistAfterTask?: boolean }, cwd?: string, _progress?: unknown, token: CancellationToken = CancellationToken.None): Promise<{ terminalId?: number; terminalInstanceId?: number; exitCode?: number; output: string }> {
		const commands = parameters.commands?.length ? parameters.commands : parameters.command ? [parameters.command] : [];
		const isBackground = parameters.isBackground === true;
		if (!commands.length) {throw new Error('command or commands is required');}
		if (isBackground && commands.length !== 1) {throw new Error('Structured command sequences cannot be launched as one background process.');}
		const shell = await resolveAgentShellEnvironment(this.terminalProfileResolverService, this.remoteAgentService, this.environmentService);
		let last: { terminalId?: number; terminalInstanceId?: number; exitCode?: number; output: string } = { output: '' };
		if (parameters.persistAfterTask && !isBackground) {throw new Error('persistAfterTask is valid only for background commands.');}
		const outputs: string[] = [];
		for (let index = 0; index < commands.length; index++) {
			const command = commands[index];
			validateCommandDialect(command, shell);
			const prepared = await this.sandboxBoundary.prepare(command, cwd ?? '', parameters.allowUnsandboxedHost === true);
			last = await this.terminalManager.executeCommand(prepared.command, cwd, isBackground, parameters.timeoutMs, token, parameters.persistAfterTask === true);
			outputs.push(`[Command ${index + 1}/${commands.length}] ${command}\n${last.output}`);
			if (last.exitCode !== undefined && last.exitCode !== 0) {break;}
		}
		return { ...last, output: outputs.join('\n\n') };
	}
}
