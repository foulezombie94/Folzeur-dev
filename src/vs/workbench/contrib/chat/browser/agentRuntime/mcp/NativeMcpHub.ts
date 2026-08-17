/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';

export interface McpServerConfig {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export interface McpSettings {
	mcpServers: Record<string, McpServerConfig>;
}

export class NativeMcpHub {
	private servers: Map<string, McpServerConfig> = new Map();

	constructor(@IFileService private readonly fileService: IFileService) {}

	public async initialize(workspaceUri: URI): Promise<void> {
		try {
			const settingsUri = URI.joinPath(workspaceUri, 'mcp_settings.json');
			const content = await this.fileService.readFile(settingsUri);
			const settings: McpSettings = JSON.parse(content.value.toString());
			
			if (settings.mcpServers) {
				for (const [name, config] of Object.entries(settings.mcpServers)) {
					this.servers.set(name, config);
				}
			}
		} catch (e) {
			// No config found or invalid, keep empty servers
		}
	}

	public getServers(): string[] {
		return Array.from(this.servers.keys());
	}

	public getServerConfig(name: string): McpServerConfig | undefined {
		return this.servers.get(name);
	}
}
