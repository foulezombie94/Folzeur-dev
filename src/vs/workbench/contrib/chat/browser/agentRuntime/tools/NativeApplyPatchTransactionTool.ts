/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../../../base/common/hash.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import { NativeSearchReplaceStrategy } from '../diff/NativeSearchReplaceStrategy.js';
import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';
import { INativeTool } from './INativeTool.js';
import { IFolzeurAgentService } from '../../../../../../platform/folzeurAgent/common/folzeurAgent.js';

interface TransactionChange {
	readonly filePath: string;
	readonly expectedHash: string;
	readonly diffContent: string;
}

/** Validates every edit before committing any and restores committed files if a write fails. */
export class NativeApplyPatchTransactionTool implements INativeTool {
	readonly name = 'apply_patch_transaction';
	readonly description = 'Transactionally apply 1-20 SEARCH/REPLACE patches across existing files with two-phase validation, per-write conflict checks, verification, and safe rollback.';
	readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			changes: {
				type: 'array', minItems: 1, maxItems: 20,
				items: {
					type: 'object', additionalProperties: false,
					properties: {
						filePath: { type: 'string', minLength: 1, maxLength: 32_768 },
						expectedHash: { type: 'string', minLength: 1, maxLength: 128 },
						diffContent: { type: 'string', minLength: 1, maxLength: 2_000_000 },
					},
					required: ['filePath', 'expectedHash', 'diffContent'],
				},
			},
		},
		required: ['changes'],
	};
	private ignoreGuard?: WorkspaceIgnoreGuard;
	private readonly strategy = new NativeSearchReplaceStrategy();

	constructor(@ITextFileService private readonly textFileService: ITextFileService, private readonly backend?: IFolzeurAgentService) { }
	setIgnoreGuard(guard: WorkspaceIgnoreGuard): void { this.ignoreGuard = guard; }

	async execute(parameters: { changes?: TransactionChange[] }): Promise<{ success: boolean; files?: string[]; error?: string }> {
		const changes = parameters.changes ?? [];
		const validated: Array<{ uri: URI; filePath: string; original: string; updated: string }> = [];
		const unique = new Set<string>();
		for (const change of changes) {
			const uri = this.ignoreGuard ? await this.ignoreGuard.assertAllowed(change.filePath) : URI.file(change.filePath);
			const key = uri.toString();
			if (unique.has(key)) {return { success: false, error: `Duplicate transaction target: ${change.filePath}` };}
			unique.add(key);
			if (this.textFileService.isDirty(uri)) {return { success: false, error: `Edit conflict: ${change.filePath} has unsaved editor changes.` };}
			const original = (await this.textFileService.read(uri)).value;
			if (hash(original).toString(16) !== change.expectedHash) {return { success: false, error: `Edit conflict: ${change.filePath} changed after it was read.` };}
			let result: { success: boolean; content?: string; error?: string };
			try {
				const raw = this.backend?.isSupported ? await this.backend.request('apply_search_replace_blocks', { originalContent: original, diffContent: change.diffContent, filePath: change.filePath }) : undefined;
				result = raw ? JSON.parse(raw) : await this.strategy.applyDiff(original, change.diffContent, undefined, undefined, change.filePath);
			} catch {
				result = await this.strategy.applyDiff(original, change.diffContent, undefined, undefined, change.filePath);
			}
			if (!result.success || result.content === undefined) {return { success: false, error: `${change.filePath}: ${result.error ?? 'diff validation failed'}` };}
			validated.push({ uri, filePath: change.filePath, original, updated: result.content });
		}

		const committed: typeof validated = [];
		try {
			// Close the validation/commit gap as far as the file API permits: revalidate the entire set immediately before the first write.
			for (const change of validated) {
				if (this.textFileService.isDirty(change.uri)) {return { success: false, error: `Edit conflict before commit: ${change.filePath} has unsaved editor changes.` };}
				const current = (await this.textFileService.read(change.uri)).value;
				if (hash(current).toString(16) !== hash(change.original).toString(16)) {return { success: false, error: `Edit conflict before commit: ${change.filePath} changed during transaction validation.` };}
			}
			for (const change of validated) {
				if (this.textFileService.isDirty(change.uri)) {throw new Error(`Edit conflict during commit: ${change.filePath} has unsaved editor changes.`);}
				const beforeWrite = (await this.textFileService.read(change.uri)).value;
				if (hash(beforeWrite).toString(16) !== hash(change.original).toString(16)) {throw new Error(`Edit conflict during commit: ${change.filePath} changed before its write.`);}
				await this.textFileService.write(change.uri, change.updated);
				committed.push(change);
				const afterWrite = (await this.textFileService.read(change.uri)).value;
				if (hash(afterWrite).toString(16) !== hash(change.updated).toString(16)) {throw new Error(`Transaction verification failed after writing ${change.filePath}.`);}
			}
			return { success: true, files: committed.map(change => change.filePath) };
		} catch (error) {
			const rollbackConflicts: string[] = [];
			for (const change of committed) {
				try {
					const current = (await this.textFileService.read(change.uri)).value;
					if (hash(current).toString(16) !== hash(change.updated).toString(16)) {rollbackConflicts.push(`${change.filePath} has newer concurrent changes`);}
				} catch (rollbackError) {
					rollbackConflicts.push(`${change.filePath}: ${String(rollbackError)}`);
				}
			}
			if (rollbackConflicts.length) {
				return { success: false, files: committed.map(change => change.filePath), error: `Transaction write failed: ${String(error)}; safe rollback refused: ${rollbackConflicts.join('; ')}` };
			}
			const rollbackErrors: string[] = [];
			for (const change of [...committed].reverse()) {
				try { await this.textFileService.write(change.uri, change.original); } catch (rollbackError) { rollbackErrors.push(`${change.filePath}: ${String(rollbackError)}`); }
			}
			return { success: false, files: rollbackErrors.length ? committed.map(change => change.filePath) : [], error: `Transaction write failed: ${String(error)}${rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join('; ')}` : '; committed files restored after conflict validation'}` };
		}
	}
}
