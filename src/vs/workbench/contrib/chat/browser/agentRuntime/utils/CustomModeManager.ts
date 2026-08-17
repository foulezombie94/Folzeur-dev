/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';

export interface CustomMode {
	slug: string;
	name: string;
	roleDefinition: string;
	customInstructions?: string;
}

export class CustomModeManager {
	constructor(@IFileService private readonly fileService: IFileService) {}

	public async loadModes(workspaceUri: URI): Promise<CustomMode[]> {
		try {
			const modesUri = URI.joinPath(workspaceUri, '.agentmodes');
			const content = await this.fileService.readFile(modesUri);
			return JSON.parse(content.value.toString());
		} catch (e) {
			// File might not exist or be invalid JSON, return default empty array
			return [];
		}
	}

	public async getMode(workspaceUri: URI, slug: string): Promise<CustomMode | undefined> {
		const modes = await this.loadModes(workspaceUri);
		return modes.find(m => m.slug === slug);
	}
}
