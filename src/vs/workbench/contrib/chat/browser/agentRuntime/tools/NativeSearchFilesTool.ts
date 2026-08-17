/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { INativeTool } from './INativeTool.js';
import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';

export class NativeSearchFilesTool implements INativeTool {
	public readonly name = 'search_files';
	public readonly description = 'Search workspace files by name using the native local file index.';
	public readonly inputSchema = { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 2_000 }, path: { type: 'string', minLength: 1, maxLength: 32_768 } }, required: ['query', 'path'] };
	private ignoreGuard?: WorkspaceIgnoreGuard;
	constructor(@IFileService private readonly fileService: IFileService) {}
	public setIgnoreGuard(guard: WorkspaceIgnoreGuard): void { this.ignoreGuard = guard; }

	public async execute(parameters: { query?: string; path?: string }, cwd: string): Promise<string> {
		const query = parameters.query?.toLowerCase().trim();
		const root = parameters.path || cwd;
		if (!query || !root) {throw new Error('query and path are required');}
		const rootUri = this.ignoreGuard ? await this.ignoreGuard.assertAllowed(root) : URI.file(root);
		const files: URI[] = [];
		await collectFiles(this.fileService, rootUri, files, this.ignoreGuard, 0);
		const allMatches = files.filter(file => file.fsPath.toLowerCase().includes(query));
		const matches = allMatches.slice(0, 100);
		if (!matches.length) {return 'No files found.';}
		let output = `Found ${allMatches.length} files:\nShowing first ${matches.length} files:\n${matches.map(file => `[File] ${file.fsPath}`).join('\n')}`;
		if (allMatches.length > 100) {output += `\n\n[TRUNCATED]: Too many results (${allMatches.length} files). Showing first 100.\nTo get better results, call search_files again with a more specific 'path' or query.`;}
		return output;
	}
}

async function collectFiles(fileService: IFileService, resource: URI, result: URI[], guard: WorkspaceIgnoreGuard | undefined, depth: number): Promise<void> {
	if (depth > 12 || result.length >= 5000 || (guard && guard.isIgnored(resource.fsPath))) {return;}
	try {
		const stat = await fileService.resolve(resource);
		if (stat.isDirectory) {for (const child of stat.children ?? []) {await collectFiles(fileService, child.resource, result, guard, depth + 1);}}
		else {result.push(resource);}
	} catch { /* files may disappear during traversal */ }
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
