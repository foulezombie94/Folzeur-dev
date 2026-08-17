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
			isBackground: {
				type: 'boolean',
				description: 'If true, the command will run in the background and this tool will return immediately.'
			}
		},
		required: ['command']
	};

	constructor(private readonly terminalManager: TerminalManager, private readonly sandboxBoundary: TerminalSandboxBoundary, private readonly terminalProfileResolverService: ITerminalProfileResolverService) {
	}

	public async execute(parameters: { command?: string; isBackground?: boolean }, cwd?: string, _progress?: unknown, token: CancellationToken = CancellationToken.None): Promise<{ terminalId?: number; terminalInstanceId?: number; exitCode?: number; output: string }> {
		const command = parameters.command;
		const isBackground = parameters.isBackground === true;
		if (!command) {
			throw new Error('command is required');
		}
		validateCommandDialect(command, await resolveAgentShellEnvironment(this.terminalProfileResolverService));

		const prepared = await this.sandboxBoundary.prepare(command, cwd ?? '');
		return await this.terminalManager.executeCommand(prepared.command, cwd, isBackground, undefined, token);
	}
}
