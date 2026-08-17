/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IMarkerService } from '../../../../../../platform/markers/common/markers.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { URI } from '../../../../../../base/common/uri.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { isAbsolute } from '../../../../../../base/common/path.js';
import { WorkspaceIgnoreGuard } from './WorkspaceIgnoreGuard.js';
import { assertPublicHttpUrl, fetchWithPolicy, isNetworkEnabled } from './AgentNetworkPolicy.js';

export class PromptPreprocessor {
	constructor(
		private readonly markerService: IMarkerService,
		private readonly fileService: IFileService,
		private readonly configurationService: IConfigurationService,
		private readonly ignoreGuard: WorkspaceIgnoreGuard,
	) {}

	public async preprocess(prompt: string, cwd: string, token: CancellationToken): Promise<string> {
		let expandedPrompt = prompt;

		// 1. Resolve @problems (active compile/lint errors)
		if (expandedPrompt.includes('@problems')) {
			const markers = this.markerService.read({ take: 30 });
			const problemText = markers.map(m => `[${m.resource.fsPath} L${m.startLineNumber}]: ${m.message}`).join('\n');
			expandedPrompt = expandedPrompt.replace(/@problems/g, `\nActive Workspace Problems:\n${problemText || 'None'}\n`);
		}

		// 2. Resolve @file:relative_path (targeted file inclusion)
		const fileRegex = /@file:([^\s]+)/g;
		let match;
		while ((match = fileRegex.exec(expandedPrompt)) !== null) {
			const filePath = match[1];
			try {
				const requestedPath = isAbsolute(filePath) ? filePath : URI.joinPath(URI.file(cwd), filePath).fsPath;
				const fileUri = await this.ignoreGuard.assertAllowed(requestedPath);
				const content = (await this.fileService.readFile(fileUri)).value.toString().substring(0, 5000);
				expandedPrompt = expandedPrompt.replace(match[0], `\nFile Content (${filePath}):\n\`\`\`\n${content}\n\`\`\`\n`);
			} catch {
				expandedPrompt = expandedPrompt.replace(match[0], `[Error: could not read file ${filePath}]`);
			}
		}

		// 3. Resolve @url:https://... (Web Content)
		const urlRegex = /@url:(https?:\/\/[^\s]+)/g;
		let urlMatch;
		while ((urlMatch = urlRegex.exec(expandedPrompt)) !== null) {
			const urlPath = urlMatch[1];
			try {
				if (!isNetworkEnabled(this.configurationService, 'fetch')) {
					throw new Error('Network fetch is disabled in settings.');
				}
				const url = assertPublicHttpUrl(urlPath);
				const response = await fetchWithPolicy(url, token);
				if (!response.ok) {
					throw new Error(`HTTP ${response.status} ${response.statusText}`);
				}
				const content = (await response.text()).substring(0, 10000); // Limit to 10k chars
				expandedPrompt = expandedPrompt.replace(urlMatch[0], `\nWeb Content (${urlPath}):\n\`\`\`\n${content}\n\`\`\`\n`);
			} catch {
				expandedPrompt = expandedPrompt.replace(urlMatch[0], `[Error: could not fetch url ${urlPath}]`);
			}
		}

		return expandedPrompt;
	}
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
