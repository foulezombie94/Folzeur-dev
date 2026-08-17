/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { INativeTool } from './INativeTool.js';
import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';

export class NativeCreateDirectoryTool implements INativeTool {
	private ignoreGuard?: WorkspaceIgnoreGuard;
	public readonly name = 'create_directory';
	public readonly description = 'Create a directory and all missing parent directories at an absolute path.';
	public readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			path: { type: 'string', minLength: 1, maxLength: 32_768, description: 'Absolute directory path to create.' }
		},
		required: ['path']
	};

	constructor(@IFileService private readonly fileService: IFileService) { }
	public setIgnoreGuard(guard: WorkspaceIgnoreGuard): void { this.ignoreGuard = guard; }

	public async execute(parameters: { path?: string }, _cwd: string): Promise<string> {
		const directoryPath = parameters.path?.trim();
		if (!directoryPath) {
			throw new Error('path is required');
		}
		if (!URI.file(directoryPath).fsPath || !/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(directoryPath)) {
			throw new Error('path must be absolute');
		}

		try {
			const uri = this.ignoreGuard ? await this.ignoreGuard.assertAllowed(directoryPath) : URI.file(directoryPath);
			await this.fileService.createFolder(uri);
			return `Directory created successfully at ${directoryPath}`;
		} catch (error) {
			throw new Error(`Error creating directory: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
