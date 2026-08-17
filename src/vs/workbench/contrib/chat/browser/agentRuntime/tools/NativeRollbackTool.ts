/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeTool } from './INativeTool.js';
import { RollbackSelection, TaskSnapshotManager } from '../utils/TaskSnapshotManager.js';

export class NativeRollbackTool implements INativeTool {
	public readonly name = 'rollback_task_changes';
	public readonly description = 'Restore the smallest coherent snapshot scope: one operation, selected files, an atomic group, a plan step, a checkpoint, or the entire run. Current hashes are verified first; conflicts never overwrite newer user changes.';
	public readonly inputSchema = { type: 'object', properties: {
		scope: { type: 'string', enum: ['operation', 'files', 'atomic_group', 'plan_step', 'checkpoint', 'entire_run'] },
		operationId: { type: 'string', minLength: 1, maxLength: 200 },
		groupId: { type: 'string', minLength: 1, maxLength: 200 },
		stepId: { type: 'string', minLength: 1, maxLength: 200 },
		checkpointId: { type: 'string', minLength: 1, maxLength: 200 },
		files: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 32_768 } },
	}, required: ['scope'], additionalProperties: false };
	constructor(private readonly snapshots: TaskSnapshotManager) { }
	public async execute(parameters: Record<string, unknown>): Promise<string> {
		const scope = parameters.scope;
		let selection: RollbackSelection;
		if (scope === 'entire_run') {selection = { scope };}
		else if (scope === 'operation' && typeof parameters.operationId === 'string') {selection = { scope, operationId: parameters.operationId };}
		else if (scope === 'atomic_group' && typeof parameters.groupId === 'string') {selection = { scope, groupId: parameters.groupId };}
		else if (scope === 'plan_step' && typeof parameters.stepId === 'string') {selection = { scope, stepId: parameters.stepId };}
		else if (scope === 'checkpoint' && typeof parameters.checkpointId === 'string') {selection = { scope, checkpointId: parameters.checkpointId };}
		else if (scope === 'files' && Array.isArray(parameters.files) && parameters.files.every(file => typeof file === 'string')) {selection = { scope, files: parameters.files as string[] };}
		else {throw new Error(`Rollback scope ${String(scope)} is missing its required selector.`);}
		const count = await this.snapshots.restore(selection);
		return count ? `Restored ${count} file snapshot(s).` : 'No task file changes to restore.';
	}
}
