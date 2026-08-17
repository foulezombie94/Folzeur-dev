/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export class TokenCondenser {
	// A safe threshold before we start dropping old messages to prevent API crashes
	private readonly MAX_MESSAGES_THRESHOLD = 50; 

	/**
	 * Condense conversation history by dropping middle messages while preserving
	 * the system prompt (index 0) and the most recent context.
	 * 
	 * Note: In a full implementation, this would use an actual tokenizer (like tiktoken)
	 * to count exact tokens. Here we use a message count heuristic as a safe proxy.
	 */
	public condenseHistory(messages: readonly CondensableMessage[]): CondensableMessage[] {
		if (messages.length <= this.MAX_MESSAGES_THRESHOLD) {
			return [...messages];
		}

		// Keep system prompt (index 0)
		const systemMessage = messages[0];
		
		// Keep the most recent 10 messages to maintain immediate context
		const recentMessages = messages.slice(-10);
		
		const condensedCount = messages.length - 1 - recentMessages.length;
		const condensedNotice = {
			role: 'system',
			content: `[System Notice: The conversation history has been condensed to save memory. ${condensedCount} older messages were removed.]`
		};

		return [systemMessage, condensedNotice, ...recentMessages];
	}
}

export interface CondensableMessage {
	readonly role: string;
	readonly content: unknown;
}
