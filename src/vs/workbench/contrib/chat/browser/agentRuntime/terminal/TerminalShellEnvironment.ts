/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OperatingSystem, OS } from '../../../../../../base/common/platform.js';
import { ITerminalProfileResolverService } from '../../../../../contrib/terminal/common/terminal.js';
import { IRemoteAgentService } from '../../../../../services/remote/common/remoteAgentService.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';

export type AgentShellDialect = 'powershell' | 'cmd' | 'posix' | 'fish';

export interface AgentShellEnvironment {
	readonly profileName: string;
	readonly executable: string;
	readonly dialect: AgentShellDialect;
	readonly displayDialect: string;
}


export async function resolveAgentShellEnvironment(terminalProfileResolverService: ITerminalProfileResolverService, remoteAgentService?: IRemoteAgentService, environmentService?: IWorkbenchEnvironmentService): Promise<AgentShellEnvironment> {
	const remoteEnvironment = environmentService?.remoteAuthority ? await remoteAgentService?.getEnvironment() : undefined;
	const os = remoteEnvironment?.os ?? OS;
	try {
		const profile = await terminalProfileResolverService.getDefaultProfile({ remoteAuthority: environmentService?.remoteAuthority, os, allowAutomationShell: false });
		const identity = `${profile.profileName} ${profile.path}`.toLowerCase();
		if (/pwsh|powershell/.test(identity)) {return { profileName: profile.profileName, executable: profile.path, dialect: 'powershell', displayDialect: 'PowerShell' };}
		if (/cmd(?:\.exe)?|command prompt/.test(identity)) {return { profileName: profile.profileName, executable: profile.path, dialect: 'cmd', displayDialect: 'Windows Command Prompt (CMD)' };}
		if (/fish/.test(identity)) {return { profileName: profile.profileName, executable: profile.path, dialect: 'fish', displayDialect: 'fish' };}
		return { profileName: profile.profileName, executable: profile.path, dialect: 'posix', displayDialect: /zsh/.test(identity) ? 'zsh' : 'Bash/POSIX' };
	} catch {
		return os === OperatingSystem.Windows
			? { profileName: 'Windows PowerShell fallback', executable: 'powershell.exe', dialect: 'powershell', displayDialect: 'PowerShell' }
			: { profileName: 'system shell', executable: 'default', dialect: 'posix', displayDialect: 'POSIX shell' };
	}
}

export function validateCommandDialect(command: string, shell: AgentShellEnvironment): void {
	const opensHtmlFile = /(?:^|[;&|]\s*)(?:start|start\.exe|Start-Process|Invoke-Item|ii|explorer(?:\.exe)?|xdg-open|open)\s+(?:(?:""\s+)?(?:['"]?[^\r\n]*?\.(?:html?|HTML?)(?:['"]?)(?:\s|$)))/i.test(command);
	if (opensHtmlFile) {
		throw new Error('Direct HTML file opening was blocked because it can open in a text editor. Use launch_local_app to serve the complete project on a local HTTP link.');
	}
	if (shell.dialect === 'powershell' && /^\s*start\s+""\s+/i.test(command)) {
		throw new Error('CMD syntax was rejected in PowerShell. Use launch_local_app for local applications.');
	}
	if (shell.dialect === 'cmd' && /\bStart-Process\b|\$env:|\$LASTEXITCODE/i.test(command)) {
		throw new Error('PowerShell syntax was rejected in CMD. Use launch_local_app, or a native CMD command.');
	}
	if ((shell.dialect === 'powershell' || shell.dialect === 'cmd') && /(?:^|\s)(?:xdg-open|open)\s+/i.test(command)) {
		throw new Error('POSIX launch syntax was rejected on the active Windows shell. Use launch_local_app.');
	}
}
