/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeTool } from './INativeTool.js';

export interface DelegateRequest {
	readonly role: string;
	readonly task: string;
	readonly evidence?: string;
}

export interface DelegateFinding {
	readonly summary: string;
	readonly evidence: readonly string[];
	readonly contradictions: readonly string[];
}

export interface DelegateAggregate {
	readonly findings: readonly DelegateFinding[];
	readonly evidence: readonly string[];
	readonly contradictions: readonly string[];
}

/** Runs bounded, independent, read-only model analyses in parallel. */
export class NativeDelegateAnalysisTool implements INativeTool {
	public readonly name = 'delegate_analysis';
	public readonly description = 'Delegate 1-4 independent analysis/review tasks in parallel to bounded subagents with read-only workspace search and file tools. Delegates cannot mutate files, execute commands, browse, or call MCP.';
	public readonly inputSchema = {
		type: 'object',
		properties: {
			tasks: {
				type: 'array', minItems: 1, maxItems: 4,
				items: {
					type: 'object', additionalProperties: false,
					properties: {
						role: { type: 'string', minLength: 1, maxLength: 80 },
						task: { type: 'string', minLength: 1, maxLength: 4000 },
						evidence: { type: 'string', maxLength: 24000 }
					},
					required: ['role', 'task']
				}
			}
		},
		required: ['tasks'],
		additionalProperties: false
	};

	constructor(private readonly delegate: (requests: readonly DelegateRequest[]) => Promise<DelegateAggregate>) { }

	public async execute(parameters: { tasks?: DelegateRequest[] }): Promise<string> {
		const requests = parameters.tasks ?? [];
		if (requests.length < 1 || requests.length > 4) {throw new Error('tasks must contain between 1 and 4 delegates');}
		const results = await this.delegate(requests);
		return JSON.stringify(results, null, 2);
	}
}
