/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { dirname } from '../../../../../../base/common/path.js';
import { INativeTool } from './INativeTool.js';

import { sha256 } from '../utils/AgentStateCrypto.js';
import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';

export class NativeWriteFileTool implements INativeTool {
	public readonly name = 'write_to_file';
	public readonly description = 'Write complete content to a file, overwriting existing content.';
	public readonly inputSchema = {
		type: 'object',
		properties: {
			path: { type: 'string', minLength: 1, maxLength: 32_768, description: 'The absolute path to the file.' },
			content: { type: 'string', maxLength: 5_000_000, description: 'The new file content.' },
			expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Optional SHA-256 contentHash returned by read_file for overwrite conflict detection.' }
		},
		additionalProperties: false,
		required: ['path', 'content']
	};

	private ignoreGuard?: WorkspaceIgnoreGuard;

	constructor(
		@ITextFileService private readonly textFileService: ITextFileService,
		@IFileService private readonly fileService: IFileService
	) {}

	public setIgnoreGuard(guard: WorkspaceIgnoreGuard) {
		this.ignoreGuard = guard;
	}

	public async execute(parameters: { path?: string; content?: string; expectedHash?: string }, cwd: string): Promise<string> {
		const filePath = parameters.path;
		const content = parameters.content ?? '';
		if (!filePath) {
			throw new Error('path is required');
		}

		const uri = this.ignoreGuard ? await this.ignoreGuard.assertAllowed(filePath) : URI.file(filePath);

		try {
			const exists = await this.fileService.exists(uri);
			if (exists) {
				if (!parameters.expectedHash) {
					throw new Error(`Edit conflict: expectedHash is required when overwriting ${filePath}. Read the file first.`);
				}
				if (this.textFileService.isDirty(uri)) {
					throw new Error(`Edit conflict: ${filePath} has unsaved editor changes. Save and read it again before overwriting.`);
				}
				const current = await this.textFileService.read(uri);
				if (await sha256(current.value) !== parameters.expectedHash) {
					throw new Error(`Edit conflict: ${filePath} changed after it was read. Read it again before overwriting.`);
				}
			}
			// External paths are supported (for example Desktop projects). The caller
			// still passes through NativeTask's confirmation gate before this runs.
			await this.fileService.createFolder(URI.file(dirname(uri.fsPath)));
			if (exists) {
				if (this.textFileService.isDirty(uri)) {throw new Error(`Edit conflict: ${filePath} gained unsaved editor changes before write.`);}
				const beforeWrite = await this.textFileService.read(uri);
				if (await sha256(beforeWrite.value) !== parameters.expectedHash) {throw new Error(`Edit conflict: ${filePath} changed before write.`);}
			} else if (await this.fileService.exists(uri)) {throw new Error(`Edit conflict: ${filePath} was created before write.`);}
			await this.textFileService.write(uri, content);
			const afterWrite = await this.textFileService.read(uri);
			if (afterWrite.value !== content) {throw new Error(`Write verification failed for ${filePath}.`);}
			return `File written successfully at ${filePath}`;
		} catch (error) {
			throw new Error(`Error writing file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
