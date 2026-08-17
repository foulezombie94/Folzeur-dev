/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IChatMessage, IChatResponsePart } from '../../../common/languageModels.js';

export type ModelProviderId = 'gemini' | 'openai' | 'claude' | 'ollama';

export interface ModelToolDeclaration {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: Record<string, unknown>;
}

export interface ModelAdapterRequest {
	readonly modelId: string;
	readonly messages: IChatMessage[];
	readonly apiKey?: string;
	readonly tools: ModelToolDeclaration[];
	readonly token: CancellationToken;
}

export interface ModelAdapter {
	readonly provider: ModelProviderId;
	stream(request: ModelAdapterRequest): AsyncGenerator<IChatResponsePart[], void, unknown>;
}

export type ModelProviderRecovery = 'retry' | 'fail' | 'compact' | 'rebuild_request';

/** Structured provider failure consumed directly by the agent retry classifier. */
export class ModelProviderError extends Error {
	constructor(
		readonly provider: ModelProviderId,
		readonly status: number | undefined,
		readonly code: string,
		readonly recovery: ModelProviderRecovery,
		message: string,
	) {
		super(message);
		this.name = 'ModelProviderError';
	}
}

export function createModelHttpError(provider: ModelProviderId, status: number, body: string, statusText: string): ModelProviderError {
	const detail = (body || statusText || 'request failed').slice(0, 8_000);
	const normalized = detail.toLowerCase();
	const contextFailure = status === 413 || /context(?:_length)?|too many tokens|maximum context/.test(normalized);
	const rebuildable = status === 400 && /tool|schema|message|request|json/.test(normalized);
	const recovery: ModelProviderRecovery = contextFailure ? 'compact' : status === 429 || status >= 500 ? 'retry' : rebuildable ? 'rebuild_request' : 'fail';
	const code = contextFailure ? 'context_too_large' : status === 429 ? 'rate_limited' : status >= 500 ? 'provider_unavailable' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 400 ? 'invalid_request' : `http_${status}`;
	return new ModelProviderError(provider, status, code, recovery, `${provider} API ${status}: ${detail}`);
}
