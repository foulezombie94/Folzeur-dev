/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { INativeTool } from './INativeTool.js';
import { IChatProgress } from '../../../common/chatService/chatService.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';

export class NativeAttemptCompletionTool implements INativeTool {
	public readonly name = 'attempt_completion';
	public readonly description = 'Call this tool when you have completed your task. Provide a summary of the actions taken and the final result.';
	public readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			result: {
				type: 'string', minLength: 1, maxLength: 20_000,
				description: 'A summary of the completed work or the final answer to the user.'
			},
			commandToRun: {
				type: 'string', maxLength: 4_000,
				description: 'An optional command that the user should run to verify the result (e.g. "npm run test").'
			}
		},
		required: ['result']
	};

	public async execute(parameters: { result?: string; commandToRun?: string }, cwd?: string, progress?: (part: IChatProgress) => void): Promise<string> {
		if (!parameters.result) {
			throw new Error('result is required');
		}

		if (progress) {
			progress({ kind: 'markdownContent', content: new MarkdownString('\n### 🎯 Mission Terminée\n\n' + parameters.result + '\n\n') });
			if (parameters.commandToRun) {
				progress({ kind: 'markdownContent', content: new MarkdownString('**Commande suggérée :**\n```bash\n' + parameters.commandToRun + '\n```\n') });
			}
		}

		return 'TASK_COMPLETED_SUCCESSFULLY';
	}
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
