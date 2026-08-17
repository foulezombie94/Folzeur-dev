/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IChatProgress } from '../../../common/chatService/chatService.js';
import { INativeTool, NativeToolSchema } from './INativeTool.js';
import { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';

/** Exposes a stable Cursor/Roo-compatible tool name without duplicating implementation. */
export class NativeToolAlias implements INativeTool {
	public readonly name: string;
	public readonly description: string;
	public readonly inputSchema: NativeToolSchema;

	constructor(alias: string, private readonly target: INativeTool) {
		this.name = alias;
		this.description = target.description;
		this.inputSchema = target.inputSchema;
	}

	public execute(parameters: Record<string, unknown>, cwd: string, progress?: (part: IChatProgress) => void): Promise<unknown> {
		return this.target.execute(parameters, cwd, progress);
	}

	public setIgnoreGuard(guard: WorkspaceIgnoreGuard): void {
		this.target.setIgnoreGuard?.(guard);
	}
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
