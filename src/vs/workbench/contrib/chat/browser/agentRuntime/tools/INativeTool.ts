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
	readonly const?: unknown;
	readonly items?: NativeToolSchema;
	readonly allOf?: readonly NativeToolSchema[];
	readonly anyOf?: readonly NativeToolSchema[];
	readonly oneOf?: readonly NativeToolSchema[];
	readonly not?: NativeToolSchema;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly exclusiveMinimum?: number;
	readonly exclusiveMaximum?: number;
	readonly multipleOf?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
	readonly format?: string;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly uniqueItems?: boolean;
	readonly minProperties?: number;
	readonly maxProperties?: number;
	readonly patternProperties?: Readonly<Record<string, NativeToolSchema>>;
	readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
	readonly additionalProperties?: boolean | NativeToolSchema;
	readonly description?: string;
}

export interface INativeTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: NativeToolSchema;
	setIgnoreGuard?(guard: WorkspaceIgnoreGuard): void;

	execute(parameters: Record<string, unknown>, cwd: string, progress?: (part: IChatProgress) => void, token?: CancellationToken, context?: NativeToolExecutionContext): Promise<unknown>;
}

export interface NativeToolExecutionContext {
	/** Stable identity of the conversation invoking the tool. Never supplied by model parameters. */
	readonly conversationId: string;
}
