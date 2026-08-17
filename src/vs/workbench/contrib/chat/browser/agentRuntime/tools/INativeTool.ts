/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IChatProgress } from '../../../common/chatService/chatService.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import type { WorkspaceIgnoreGuard } from '../utils/WorkspaceIgnoreGuard.js';

export interface NativeToolSchema {
	readonly type?: string;
	readonly properties?: Readonly<Record<string, NativeToolSchema>>;
	readonly required?: readonly string[];
	readonly enum?: readonly unknown[];
	readonly items?: NativeToolSchema;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly additionalProperties?: boolean;
	readonly description?: string;
}

export interface INativeTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: NativeToolSchema;
	setIgnoreGuard?(guard: WorkspaceIgnoreGuard): void;

	execute(parameters: Record<string, unknown>, cwd: string, progress?: (part: IChatProgress) => void, token?: CancellationToken): Promise<unknown>;
}
