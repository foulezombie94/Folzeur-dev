/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isLinux } from '../../../../../../base/common/platform.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';

const INTERNAL_SEGMENTS = new Set(['.git', '.folzeur']);

/** Collects workspace file events produced by an external terminal process. */
export class WorkspaceMutationObserver {
	constructor(private readonly fileService: IFileService) { }

	public begin(workspacePath: string): { finish(): Promise<readonly string[]> } {
		const root = normalizePath(URI.file(workspacePath).fsPath);
		const changed = new Set<string>();
		let disposed = false;
		const listener: IDisposable = this.fileService.onDidFilesChange(event => {
			for (const resource of [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted]) {
				const candidate = normalizePath(resource.fsPath);
				if ((candidate === root || candidate.startsWith(`${root}/`)) && !isInternal(candidate.slice(root.length + 1))) {
					changed.add(resource.fsPath);
				}
			}
		});
		return {
			finish: async () => {
				if (!disposed) {
					// File watchers are asynchronous relative to process exit. A short bounded
					// yield lets the final batch arrive without slowing ordinary tool calls.
					await new Promise<void>(resolve => setTimeout(resolve, 100));
					disposed = true;
					listener.dispose();
				}
				return [...changed].sort();
			}
		};
	}
}

function normalizePath(value: string): string {
	const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
	return isLinux ? normalized : normalized.toLowerCase();
}

function isInternal(relativePath: string): boolean {
	return relativePath.split('/').some(segment => INTERNAL_SEGMENTS.has(segment.toLowerCase()));
}
