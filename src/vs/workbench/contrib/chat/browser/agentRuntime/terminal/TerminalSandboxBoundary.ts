/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { ITerminalSandboxService, TerminalSandboxPrerequisiteCheck } from '../../../../../../platform/sandbox/common/terminalSandboxService.js';

export interface PreparedTerminalCommand {
	readonly command: string;
	readonly sandboxed: boolean;
}

/** Applies VS Code's OS-backed terminal sandbox before a native-agent command reaches the PTY. */
export class TerminalSandboxBoundary {
	constructor(private readonly sandboxService: ITerminalSandboxService) { }

	async prepare(command: string, cwd: string): Promise<PreparedTerminalCommand> {
		const prerequisites = await this.sandboxService.checkForSandboxingPrereqs(false, { isDefaultApprovalPermissionEnabled: true });
		if (!prerequisites.enabled || prerequisites.failedCheck === TerminalSandboxPrerequisiteCheck.Config) {
			return { command, sandboxed: false };
		}
		if (prerequisites.failedCheck) {
			throw new Error(`Terminal sandbox is enabled but unavailable (${prerequisites.failedCheck}). Resolve its prerequisites before running agent commands.`);
		}
		const wrapped = await this.sandboxService.wrapCommand(command, false, undefined, URI.file(cwd), [], false);
		if (wrapped.requiresUnsandboxConfirmation) {
			throw new Error(`The command requires execution outside the terminal sandbox${wrapped.blockedDomains?.length ? ` because of: ${wrapped.blockedDomains.join(', ')}` : ''}. Native Agent refused the privilege escalation.`);
		}
		if (wrapped.requiresAllowNetworkConfirmation) {
			throw new Error('The command requires unrestricted network access. Native Agent refused the sandbox privilege escalation.');
		}
		return { command: wrapped.command, sandboxed: wrapped.isSandboxWrapped };
	}
}
