/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import { NativeSearchReplaceStrategy } from '../diff/NativeSearchReplaceStrategy.js';
import { DiffResult } from '../diff/types.js';
import { INativeTool } from './INativeTool.js';
import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';
import { sha256 } from '../utils/AgentStateCrypto.js';
import { IFolzeurAgentService } from '../../../../../../platform/folzeurAgent/common/folzeurAgent.js';

export class NativeApplyDiffTool implements INativeTool {
	private diffStrategy: NativeSearchReplaceStrategy;
	private consecutiveFailures = new Map<string, number>();
	private ignoreGuard?: WorkspaceIgnoreGuard;

	public readonly name = 'apply_diff';
	public readonly description = 'Atomically apply exact SEARCH/REPLACE blocks with ambiguity, overlap and stale-content rejection.';
	public readonly inputSchema = {
		type: 'object',
		properties: {
			filePath: { type: 'string', minLength: 1, maxLength: 32_768, description: 'The absolute path to the file.' },
			diffContent: { type: 'string', minLength: 1, maxLength: 2_000_000, description: 'The diff content to apply, in search/replace format.' },
			expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA-256 contentHash returned by read_file. The edit is rejected if the file changed.' }
		},
		additionalProperties: false,
		required: ['filePath', 'diffContent', 'expectedHash']
	};

	constructor(@ITextFileService private readonly textFileService: ITextFileService, private readonly backend?: IFolzeurAgentService) {
		this.diffStrategy = new NativeSearchReplaceStrategy();
	}

	public setIgnoreGuard(guard: WorkspaceIgnoreGuard): void {
		this.ignoreGuard = guard;
	}

	public async execute(parameters: { filePath?: string; diffContent?: string; expectedHash?: string }, cwd?: string): Promise<DiffResult> {
		const filePath = parameters.filePath;
		const diffContent = parameters.diffContent;
		if (!filePath || !diffContent || !parameters.expectedHash) {
			return { success: false, error: 'filePath, diffContent, and expectedHash are required.' };
		}

		const uri = this.ignoreGuard ? await this.ignoreGuard.assertAllowed(filePath) : URI.file(filePath);
		
		try {
			if (this.textFileService.isDirty(uri)) {
				return { success: false, error: 'Edit conflict: the file has unsaved editor changes. Save it, read it again, and regenerate the patch.' };
			}
			// Read the current file content
			const fileContent = await this.textFileService.read(uri);
			const originalText = fileContent.value;
			if (parameters.expectedHash !== await sha256(originalText)) {
				return { success: false, error: 'Edit conflict: the file changed after it was read. Read it again and regenerate the patch.' };
			}

			// Apply diff
			let result: DiffResult;
			try {
				const raw = this.backend?.isSupported ? await this.backend.request('apply_search_replace_blocks', { originalContent: originalText, diffContent, filePath }) : undefined;
				result = raw ? JSON.parse(raw) as DiffResult : await this.diffStrategy.applyDiff(originalText, diffContent, undefined, undefined, filePath);
			} catch {
				result = await this.diffStrategy.applyDiff(originalText, diffContent, undefined, undefined, filePath);
			}

			if (result.success && result.content !== undefined) {
				if (this.textFileService.isDirty(uri)) {return { success: false, error: `Edit conflict: ${filePath} gained unsaved editor changes while the diff was computed.` };}
				const beforeWrite = await this.textFileService.read(uri);
				if (await sha256(beforeWrite.value) !== parameters.expectedHash) {return { success: false, error: `Edit conflict: ${filePath} changed while the diff was computed.` };}
				await this.textFileService.write(uri, result.content);
				const afterWrite = await this.textFileService.read(uri);
				if (afterWrite.value !== result.content) {return { success: false, error: `Write verification failed for ${filePath}.` };}
				this.consecutiveFailures.delete(filePath);
			} else {
				const failures = (this.consecutiveFailures.get(filePath) || 0) + 1;
				this.consecutiveFailures.set(filePath, failures);
				
				if (failures >= 3) {
					result.error = `[FALLBACK TRIGGERED] Native Diff engine failed ${failures} times consecutively. The diff is malformed. DO NOT USE apply_diff AGAIN for this file. Use the 'write_to_file' tool. For your convenience, here is the CURRENT full content of the file so you can rewrite it:\n\n\`\`\`\n${originalText}\n\`\`\``;
				} else {
					result.error = `Diff applied failed. The SEARCH block did not match exactly. Attempt ${failures}/3. Please check indentation and try again.`;
				}
			}

			return result;
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}
}
