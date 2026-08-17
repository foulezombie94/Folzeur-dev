/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { INativeTool } from './INativeTool.js';
import { TerminalManager } from '../terminal/TerminalManager.js';

export class NativeManageTerminalTool implements INativeTool {
	public readonly name = 'manage_terminal';
	public readonly description = 'Inspect or interrupt a background terminal process.';
	public readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			action: {
				type: 'string',
				enum: ['get_output', 'interrupt'],
				description: 'The action to perform on the terminal.'
			},
			terminalId: {
				type: 'integer', minimum: 1, maximum: 1_000_000,
				description: 'The ID of the background terminal.'
			}
		},
		required: ['action', 'terminalId']
	};

	constructor(private readonly terminalManager: TerminalManager) {
	}

	public async execute(parameters: { action?: 'get_output' | 'interrupt'; terminalId?: number }, cwd?: string): Promise<string> {
		const action = parameters.action;
		const id = parameters.terminalId;

		if (!action || typeof id !== 'number') {
			throw new Error('action and terminalId are required');
		}

		if (action === 'get_output') {
			const res = await this.terminalManager.getUnretrievedOutput(id);
			return JSON.stringify(res);
		} else if (action === 'interrupt') {
			return this.terminalManager.interrupt(id);
		}

		throw new Error('Invalid action');
	}
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
