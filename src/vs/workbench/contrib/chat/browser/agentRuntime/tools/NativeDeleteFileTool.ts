/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { INativeTool } from './INativeTool.js';
import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import { sha256 } from '../utils/AgentStateCrypto.js';

export class NativeDeleteFileTool implements INativeTool {
	private ignoreGuard?: WorkspaceIgnoreGuard;
	public readonly name = 'delete_file';
	public readonly description = 'Delete one file after explicit user confirmation. Directories are never deleted by this tool.';
	public readonly inputSchema = {
		type: 'object',
		additionalProperties: false,
		properties: {
			path: { type: 'string', minLength: 1, maxLength: 32_768, description: 'Absolute path of the file to delete.' },
			expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA-256 contentHash returned by read_file.' }
		},
		required: ['path', 'expectedHash']
	};

	constructor(@IFileService private readonly fileService: IFileService, @ITextFileService private readonly textFileService: ITextFileService) { }
	public setIgnoreGuard(guard: WorkspaceIgnoreGuard): void { this.ignoreGuard = guard; }

	public async execute(parameters: { path?: string; expectedHash?: string }, _cwd: string): Promise<string> {
		const filePath = parameters.path?.trim();
		if (!filePath) {throw new Error('path is required');}
		const uri = this.ignoreGuard ? await this.ignoreGuard.assertAllowed(filePath) : URI.file(filePath);
		try {
			const stat = await this.fileService.resolve(uri);
			if (stat.isDirectory) {throw new Error(`${filePath} is a directory. This tool only deletes files.`);}
			if (this.textFileService.isDirty(uri)) {throw new Error(`${filePath} has unsaved editor changes. Save and read it again before deleting.`);}
			const current = await this.textFileService.read(uri);
			if (await sha256(current.value) !== parameters.expectedHash) {throw new Error(`${filePath} changed after it was read. Read it again before deleting.`);}
			await this.fileService.del(uri, { recursive: false });
			return `File deleted successfully at ${filePath}`;
		} catch (error) {
			throw new Error(`Error deleting file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
