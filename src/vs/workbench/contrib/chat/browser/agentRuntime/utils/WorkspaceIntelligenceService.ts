/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { WorkspaceCodeIndex } from './WorkspaceCodeIndex.js';
import { WorkspaceOutlineIndex } from './WorkspaceOutlineIndex.js';

interface WorkspaceIntelligenceEntry {
	readonly code: WorkspaceCodeIndex;
	readonly outline: WorkspaceOutlineIndex;
	references: number;
	disposeTimer?: ReturnType<typeof setTimeout>;
}

export interface WorkspaceIntelligenceLease extends IDisposable {
	readonly code: WorkspaceCodeIndex;
	readonly outline: WorkspaceOutlineIndex;
	cancelCurrentWork(): void;
}

const entries = new Map<string, WorkspaceIntelligenceEntry>();
const IDLE_RETENTION_MS = 5 * 60_000;

/** Shares incremental workspace intelligence across runs and disposes it after an idle retention window. */
export function acquireWorkspaceIntelligence(fileService: IFileService, workspace: URI): WorkspaceIntelligenceLease {
	const key = workspace.toString();
	let entry = entries.get(key);
	if (!entry) {
		entry = { code: new WorkspaceCodeIndex(fileService, workspace), outline: new WorkspaceOutlineIndex(fileService, workspace), references: 0 };
		entries.set(key, entry);
	}
	if (entry.disposeTimer) {clearTimeout(entry.disposeTimer);}
	entry.disposeTimer = undefined;
	entry.code.resumeCurrentWork();
	entry.outline.resumeCurrentWork();
	entry.references++;
	let disposed = false;
	return {
		code: entry.code,
		outline: entry.outline,
		cancelCurrentWork: () => { entry!.code.cancelCurrentWork(); entry!.outline.cancelCurrentWork(); },
		dispose: () => {
			if (disposed) {return;}
			disposed = true;
			entry!.references = Math.max(0, entry!.references - 1);
			if (!entry!.references) {entry!.disposeTimer = setTimeout(() => {
				if (entry!.references) {return;}
				entry!.code.dispose();
				entry!.outline.dispose();
				entries.delete(key);
			}, IDLE_RETENTION_MS);}
		},
	};
}
