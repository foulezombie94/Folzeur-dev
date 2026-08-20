/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeTool } from './INativeTool.js';
import { ToolResultStore } from '../utils/ToolResultStore.js';

/** Provides bounded, run-scoped pagination for complete large tool results. */
export class NativeReadToolResultTool implements INativeTool {
	readonly name = 'read_tool_result';
	readonly description = 'Read a bounded page of a complete large tool result retained in run-scoped disk storage.';
	readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			resultId: { type: 'string', minLength: 1, maxLength: 100 },
			offset: { type: 'integer', minimum: 0, maximum: 268_435_456, description: 'Byte offset returned by the previous page.' },
			maxChars: { type: 'integer', minimum: 1, maximum: 20_000 },
		},
		required: ['resultId'],
	};

	constructor(private readonly results: ToolResultStore) { }

	async execute(parameters: { resultId?: string; offset?: number; maxChars?: number }): Promise<string> {
		const result = await this.results.read(parameters.resultId ?? '', parameters.offset, parameters.maxChars);
		if (!result) {throw new Error('Large tool result not found, expired, evicted, or owned by another run.');}
		return `[Result ${parameters.resultId}; bytes ${result.offset}-${result.end} of ${result.length}; sha256=${result.hash}]\n${result.value}${result.end < result.length ? '\n[MORE AVAILABLE]' : ''}`;
	}
}
