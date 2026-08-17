/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService, IFileStatWithMetadata } from '../../../../../../platform/files/common/files.js';
import { INativeTool } from './INativeTool.js';

import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';

export class NativeListDirTool implements INativeTool {
	public readonly name = 'list_dir';
	public readonly description = 'List files and directories in a given path.';
	public readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			path: { type: 'string', minLength: 1, maxLength: 32_768, description: 'The absolute path to the directory.' }
		},
		required: ['path']
	};

	private ignoreGuard?: WorkspaceIgnoreGuard;

	constructor(
		@IFileService private readonly fileService: IFileService
	) { }

	public setIgnoreGuard(guard: WorkspaceIgnoreGuard) {
		this.ignoreGuard = guard;
	}

	public async execute(parameters: { path?: string }, cwd: string): Promise<string> {
		const dirPath = parameters.path;
		if (!dirPath) {
			throw new Error('path is required');
		}

		const uri = this.ignoreGuard ? await this.ignoreGuard.assertAllowed(dirPath) : URI.file(dirPath);

		try {
			const stat = await this.fileService.resolve(uri, { resolveMetadata: true });

			if (!stat.isDirectory) {
				return `Error: ${dirPath} is not a directory.`;
			}

			if (!stat.children || stat.children.length === 0) {
				return `Directory ${dirPath} is empty.`;
			}

			const visibleChildren = stat.children.filter(child => !this.ignoreGuard?.isIgnored(child.resource.fsPath));
			if (!visibleChildren.length) {return `Directory ${dirPath} has no visible entries after security exclusions.`;}
			const lines = visibleChildren.map((child: IFileStatWithMetadata) => {
				const type = child.isDirectory ? 'DIR' : 'FILE';
				return `[${type}] ${child.name}`;
			});

			return `Contents of ${dirPath}:\n${lines.join('\n')}`;
		} catch (error) {
			return `Error listing directory: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}
