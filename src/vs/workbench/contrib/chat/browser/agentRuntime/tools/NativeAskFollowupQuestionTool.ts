/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { INativeTool } from './INativeTool.js';

export class NativeAskFollowupQuestionTool implements INativeTool {
	public readonly name = 'ask_followup_question';
	public readonly description = 'Ask the user a question to gather additional information needed to complete the task. Use this when you are stuck or need clarification on requirements.';
	public readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			question: {
				type: 'string', minLength: 1, maxLength: 4_000,
				description: 'The question to ask the user.'
			}
		},
		required: ['question']
	};

	constructor(private readonly askUserCallback: (question: string) => Promise<string>) {
	}

	public async execute(parameters: { question?: string }, cwd?: string): Promise<string> {
		if (!parameters.question) {
			throw new Error('question is required');
		}

		return await this.askUserCallback(parameters.question);
	}
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
