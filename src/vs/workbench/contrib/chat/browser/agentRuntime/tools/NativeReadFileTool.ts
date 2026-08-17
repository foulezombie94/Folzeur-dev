/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { hash } from '../../../../../../base/common/hash.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import { INativeTool } from './INativeTool.js';

import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';

export class NativeReadFileTool implements INativeTool {
	public readonly name = 'read_file';
	public readonly description = 'Read the contents of a file, optionally within a specific line range.';
	public readonly inputSchema = {
		type: 'object',
		properties: {
			path: { type: 'string', minLength: 1, maxLength: 32_768, description: 'The absolute path to the file to read.' },
			startLine: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'The 1-indexed starting line number (optional).' },
			endLine: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'The 1-indexed ending line number (optional).' }
		},
		additionalProperties: false,
		required: ['path']
	};

	private ignoreGuard?: WorkspaceIgnoreGuard;

	constructor(
		@ITextFileService private readonly textFileService: ITextFileService
	) {}

	public setIgnoreGuard(guard: WorkspaceIgnoreGuard) {
		this.ignoreGuard = guard;
	}

	public async execute(parameters: { path?: string; startLine?: number; endLine?: number }, cwd: string): Promise<string> {
		const filePath = parameters.path;
		const startLine = typeof parameters.startLine === 'number' ? parameters.startLine : undefined;
		const endLine = typeof parameters.endLine === 'number' ? parameters.endLine : undefined;

		if (!filePath) {
			throw new Error('path is required');
		}

		const uri = this.ignoreGuard ? await this.ignoreGuard.assertAllowed(filePath) : URI.file(filePath);

		try {
			const model = await this.textFileService.read(uri);
			const content = model.value;
			if (content.includes('\0')) {
				return 'Error: binary files cannot be read as text.';
			}
			const contentHash = hash(content).toString(16);
			
			const lines = content.split(/\r?\n/);
			const totalLines = lines.length;

			if (startLine !== undefined || endLine !== undefined) {
				const start = startLine !== undefined ? Math.max(1, startLine) : 1;
				const end = endLine !== undefined ? Math.min(totalLines, endLine) : totalLines;
				
				if (start > totalLines) {
					return `Error: startLine (${start}) exceeds file line count (${totalLines}).`;
				}
				if (start > end) {
					return `Error: startLine (${start}) cannot be greater than endLine (${end}).`;
				}
				
				const lineLimit = 500;
				if (end - start + 1 > lineLimit) {
					return `Error: Requested range (${end - start + 1} lines) exceeds maximum limit of ${lineLimit} lines. Please read a smaller range.`;
				}
				
				const rangeText = lines.slice(start - 1, end).join('\n');
				if (rangeText.length > 120_000) {return `Error: Requested range exceeds the maximum limit of 120000 characters. Please read a smaller range.`;}
				return `[contentHash: ${contentHash}] [Showing lines ${start} to ${end} of ${totalLines}]:\n` + rangeText;
			}

			const defaultLimit = 300;
			if (totalLines > defaultLimit) {
				const rangeText = lines.slice(0, defaultLimit).join('\n').slice(0, 120_000);
				return `[contentHash: ${contentHash}] [Showing first ${defaultLimit} lines of ${totalLines} (file has more lines, specify startLine and endLine to read other regions)]:\n` + rangeText;
			}

			return `[contentHash: ${contentHash}]\n${content.slice(0, 120_000)}${content.length > 120_000 ? '\n[TRUNCATED: specify a smaller line range]' : ''}`;
		} catch (error) {
			return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}
