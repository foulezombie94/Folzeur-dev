/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeTool } from './INativeTool.js';

/** Provides bounded pagination for large tool results without writing sensitive output to disk. */
export class NativeReadToolResultTool implements INativeTool {
	readonly name = 'read_tool_result';
	readonly description = 'Read a bounded slice of a large tool result retained in task memory.';
	readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			resultId: { type: 'string', minLength: 1, maxLength: 100 },
			offset: { type: 'integer', minimum: 0, maximum: 1_000_000 },
			maxChars: { type: 'integer', minimum: 1, maximum: 20_000 },
		},
		required: ['resultId'],
	};

	constructor(private readonly results: Map<string, string>) { }

	async execute(parameters: { resultId?: string; offset?: number; maxChars?: number }): Promise<string> {
		const value = this.results.get(parameters.resultId ?? '');
		if (value === undefined) {throw new Error('Large tool result not found or expired.');}
		const offset = Math.min(value.length, parameters.offset ?? 0);
		const end = Math.min(value.length, offset + (parameters.maxChars ?? 12_000));
		return `[Result ${parameters.resultId}; characters ${offset}-${end} of ${value.length}]\n${value.slice(offset, end)}${end < value.length ? '\n[MORE AVAILABLE]' : ''}`;
	}
}
