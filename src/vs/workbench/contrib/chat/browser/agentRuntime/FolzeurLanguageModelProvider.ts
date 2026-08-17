/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatMessagePart,
	IChatResponsePart,
	IChatResponseToolUsePart,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
} from '../../common/languageModels.js';
import { createModelHttpError, ModelAdapter, ModelProviderId, ModelToolDeclaration } from './model/ModelAdapter.js';

export const FOLZEUR_LM_VENDOR = 'folzeur';

type FolzeurApiProvider = ModelProviderId;

interface FolzeurToolDeclaration extends ModelToolDeclaration { }

interface GeminiToolUsePart extends IChatResponseToolUsePart {
	thoughtSignature?: string;
}

/**
 * Gemini function declarations accept only a subset of OpenAPI Schema. Keep
 * the richer schema for the other providers and remove unsupported keywords
 * from the Gemini copy without mutating the tool's source schema.
 */
export function toGeminiFunctionParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
	const source = schema && Object.keys(schema).length ? schema : { type: 'object', properties: {} };
	return sanitizeGeminiSchemaValue(source) as Record<string, unknown>;
}

function sanitizeGeminiSchemaValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sanitizeGeminiSchemaValue);
	}
	if (!value || typeof value !== 'object') {
		return value;
	}
	const sanitized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (key !== 'additionalProperties') {
			sanitized[key] = sanitizeGeminiSchemaValue(child);
		}
	}
	return sanitized;
}

/** Incremental UTF-8 line decoder used by SSE and NDJSON provider streams. */
export class BoundedStreamLineDecoder {
	private readonly decoder = new TextDecoder();
	private buffered = '';
	private receivedBytes = 0;

	constructor(private readonly maxBytes = 32 * 1024 * 1024, private readonly maxLineCharacters = 2_000_000) { }

	push(value: Uint8Array): string[] {
		this.receivedBytes += value.byteLength;
		if (this.receivedBytes > this.maxBytes) {throw new Error(`Provider stream exceeds the ${this.maxBytes}-byte safety limit.`);}
		this.buffered += this.decoder.decode(value, { stream: true });
		if (this.buffered.length > this.maxLineCharacters && !/[\r\n]/.test(this.buffered)) {throw new Error('Provider stream contains an oversized line.');}
		const lines = this.buffered.split(/\r?\n/);
		this.buffered = lines.pop() ?? '';
		return lines.filter(line => line.trim());
	}

	finish(): string[] {
		this.buffered += this.decoder.decode();
		const final = this.buffered.trim() ? [this.buffered] : [];
		this.buffered = '';
		return final;
	}
}

export function toFolzeurModelIdentifier(provider: FolzeurApiProvider, modelId: string): string {
	return `${FOLZEUR_LM_VENDOR}/${provider}/${modelId}`;
}

export function parseFolzeurModelIdentifier(modelIdentifier: string): { provider: FolzeurApiProvider; modelId: string } | undefined {
	const parts = modelIdentifier.split('/');
	if (parts.length < 3 || parts[0] !== FOLZEUR_LM_VENDOR) {
		return undefined;
	}
	const provider = parts[1] as FolzeurApiProvider;
	if (provider !== 'gemini' && provider !== 'openai' && provider !== 'claude' && provider !== 'ollama') {
		return undefined;
	}
	return { provider, modelId: parts.slice(2).join('/') };
}

/**
 * Built-in Folzeur language-model provider. Calls Gemini / OpenAI / Anthropic / Ollama
 * directly with the Folzeur API key — no Copilot BYOK vendor required.
 */
export class FolzeurLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private readonly adapters: ReadonlyMap<FolzeurApiProvider, ModelAdapter>;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.adapters = new Map<FolzeurApiProvider, ModelAdapter>([
			['gemini', { provider: 'gemini', stream: request => this._gemini(request.modelId, request.messages, request.apiKey!, request.tools, request.token) }],
			['openai', { provider: 'openai', stream: request => this._openai(request.modelId, request.messages, request.apiKey!, request.tools, request.token) }],
			['claude', { provider: 'claude', stream: request => this._claude(request.modelId, request.messages, request.apiKey!, request.tools, request.token) }],
			['ollama', { provider: 'ollama', stream: request => this._ollama(request.modelId, request.messages, request.tools, request.token) }],
		]);
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('chat.api.provider') ||
				e.affectsConfiguration('chat.api.gemini.model') ||
				e.affectsConfiguration('chat.api.openai.model') ||
				e.affectsConfiguration('chat.api.claude.model') ||
				e.affectsConfiguration('localAI.model') ||
				e.affectsConfiguration('chat.api.maxInputTokens') ||
				e.affectsConfiguration('chat.api.maxOutputTokens')
			) {
				this._onDidChange.fire();
			}
		}));
	}

	notifyChanged(): void {
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const models: ILanguageModelChatMetadataAndIdentifier[] = [];

		const geminiEnum = [
			'gemini-3.1-pro-preview',
			'gemini-3.6-flash',
			'gemini-3.5-flash',
			'gemini-3-flash-preview',
			'gemini-3.5-flash-lite',
			'gemini-3.1-flash-lite',
		];
		const selectedGemini = this.configurationService.getValue<string>('chat.api.gemini.model')?.trim();
		for (const id of new Set([...geminiEnum, ...(selectedGemini ? [selectedGemini] : [])])) {
			models.push(this._model('gemini', id, `Gemini ${id}`, 1_000_000, 65_536));
		}

		const openaiModel = this.configurationService.getValue<string>('chat.api.openai.model')?.trim() || 'gpt-4o-mini';
		models.push(this._model('openai', openaiModel, `OpenAI ${openaiModel}`, 128_000, 16_384));

		const claudeModel = this.configurationService.getValue<string>('chat.api.claude.model')?.trim() || 'claude-3-5-sonnet-20241022';
		models.push(this._model('claude', claudeModel, `Claude ${claudeModel}`, 200_000, 8_192));

		const ollamaModel = this.configurationService.getValue<string>('localAI.model')?.trim() || 'llama3.2';
		models.push(this._model('ollama', ollamaModel, `Ollama ${ollamaModel}`, 32_768, 8_192));

		return models;
	}

	async sendChatRequest(
		modelIdentifier: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		options: ILanguageModelChatRequestOptions,
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		const parsed = parseFolzeurModelIdentifier(modelIdentifier);
		if (!parsed) {
			throw new Error(`Unknown Folzeur model: ${modelIdentifier}`);
		}

		const apiKey = this._apiKey(options);
		if (parsed.provider !== 'ollama' && !apiKey) {
			throw new Error(`Missing API key for Folzeur provider ${parsed.provider}. Use "Folzeur: Set API Key".`);
		}

		const tools = this._tools(options);
		const stream = this._streamResponse(parsed.provider, parsed.modelId, messages, apiKey, tools, token);
		return {
			stream,
			result: Promise.resolve(),
		};
	}

	async provideTokenCount(modelId: string, message: string | IChatMessage, token: CancellationToken): Promise<number> {
		const text = typeof message === 'string' ? message : JSON.stringify(message);
		if (token.isCancellationRequested) {throw new Error('Token count cancelled.');}
		const provider = parseFolzeurModelIdentifier(modelId)?.provider;
		try {
			if (provider === 'claude') {
				// Optional tokenizer dependency: keep lazy so other providers do not load it.
				// eslint-disable-next-line local/code-amd-node-module
				const { countTokens } = await import('@anthropic-ai/tokenizer');
				return countTokens(text);
			}
			if (provider === 'openai') {
				// Optional tokenizer dependency: keep lazy so other providers do not load it.
				// eslint-disable-next-line local/code-amd-node-module
				const { get_encoding } = await import('tiktoken');
				const tokenizer = get_encoding(/(?:gpt-4o|gpt-5|o[134])(?:\b|-)/i.test(modelId) ? 'o200k_base' : 'cl100k_base');
				try { return tokenizer.encode(text).length; } finally { tokenizer.free(); }
			}
		} catch {
			// Tokenizer loading must not block the task. Use a Unicode-aware conservative estimate below.
		}
		const utf8Bytes = new TextEncoder().encode(text).byteLength;
		const nonAscii = [...text].filter(character => character.codePointAt(0)! > 0x7f).length;
		return Math.max(1, Math.ceil((utf8Bytes + nonAscii * 1.5) / (provider === 'gemini' ? 3.6 : 3.8)));
	}

	private _model(provider: FolzeurApiProvider, id: string, name: string, maxInputTokens: number, maxOutputTokens: number): ILanguageModelChatMetadataAndIdentifier {
		const configuredInput = this.configurationService.getValue<number>('chat.api.maxInputTokens');
		const configuredOutput = this.configurationService.getValue<number>('chat.api.maxOutputTokens');
		if (Number.isInteger(configuredInput) && configuredInput >= 1_024) {maxInputTokens = configuredInput;}
		if (Number.isInteger(configuredOutput) && configuredOutput >= 256) {maxOutputTokens = Math.min(configuredOutput, maxInputTokens - 1);}
		return {
			identifier: toFolzeurModelIdentifier(provider, id),
			metadata: {
				extension: nullExtensionDescription.identifier,
				name,
				id,
				vendor: FOLZEUR_LM_VENDOR,
				version: '1.0.0',
				family: provider,
				maxInputTokens,
				maxOutputTokens,
				isDefaultForLocation: {},
				isUserSelectable: true,
				isBYOK: true,
				capabilities: {
					vision: provider === 'gemini' || provider === 'openai' || provider === 'claude',
					toolCalling: true,
					agentMode: true,
				},
			},
		};
	}

	private _configuredOutputLimit(fallback?: number): number | undefined {
		const configured = this.configurationService.getValue<number>('chat.api.maxOutputTokens');
		return Number.isInteger(configured) && configured >= 256
			? Math.min(configured, 1_000_000)
			: fallback;
	}

	private _apiKey(options: ILanguageModelChatRequestOptions): string | undefined {
		const fromConfig = options.configuration?.['apiKey'];
		const fromModelOptions = options.modelOptions?.['apiKey'];
		const value = typeof fromConfig === 'string' ? fromConfig : typeof fromModelOptions === 'string' ? fromModelOptions : undefined;
		return value?.trim() || undefined;
	}

	private _tools(options: ILanguageModelChatRequestOptions): FolzeurToolDeclaration[] {
		const raw = (options as { tools?: FolzeurToolDeclaration[] }).tools;
		return Array.isArray(raw) ? raw.filter(t => t && typeof t.name === 'string') : [];
	}

	private async * _streamResponse(
		provider: FolzeurApiProvider,
		modelId: string,
		messages: IChatMessage[],
		apiKey: string | undefined,
		tools: FolzeurToolDeclaration[],
		token: CancellationToken,
	): AsyncGenerator<IChatResponsePart[], void, unknown> {
		if (token.isCancellationRequested) {
			return;
		}
		const adapter = this.adapters.get(provider);
		if (!adapter) {throw new Error(`No model adapter registered for ${provider}.`);}
		yield* adapter.stream({ modelId, messages, apiKey, tools, token });
	}

	private _textOf(parts: readonly IChatMessagePart[]): string {
		return parts
			.map(part => {
				if (part.type === 'text') {
					return part.value;
				}
				if (part.type === 'tool_result') {
					const body = part.value.map(v => v.type === 'text' ? v.value : JSON.stringify(v)).join('\n');
					return `Tool result (${part.toolCallId}):\n${body}`;
				}
				if (part.type === 'tool_use') {
					return `Tool call ${part.name}(${JSON.stringify(part.parameters)})`;
				}
				return '';
			})
			.filter(Boolean)
			.join('\n');
	}

	private async * _gemini(
		modelId: string,
		messages: IChatMessage[],
		apiKey: string,
		tools: FolzeurToolDeclaration[],
		token: CancellationToken,
	): AsyncGenerator<IChatResponsePart[], void, unknown> {
		let systemInstruction: { parts: Array<{ text: string }> } | undefined;
		const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
		const toolNamesById = new Map<string, string>();

		for (const message of messages) {
			if (message.role === ChatMessageRole.System) {
				systemInstruction = { parts: [{ text: this._textOf(message.content) }] };
				continue;
			}

			const role = message.role === ChatMessageRole.Assistant ? 'model' : 'user';
			const parts: Array<Record<string, unknown>> = [];
			for (const part of message.content) {
				if (part.type === 'text') {
					parts.push({ text: part.value });
				} else if (part.type === 'tool_use') {
					toolNamesById.set(part.toolCallId, part.name);
					const thoughtSignature = (part as GeminiToolUsePart).thoughtSignature;
					parts.push({
						functionCall: {
							name: part.name,
							args: part.parameters ?? {},
						},
						...(thoughtSignature ? { thoughtSignature } : {}),
					});
				} else if (part.type === 'tool_result') {
					const responseText = part.value.map(v => v.type === 'text' ? v.value : JSON.stringify(v)).join('\n');
					parts.push({
						functionResponse: {
							name: toolNamesById.get(part.toolCallId) || part.toolCallId,
							response: { result: responseText },
						},
					});
				}
			}
			if (parts.length) {
				contents.push({ role, parts });
			}
		}

		const body: Record<string, unknown> = { contents };
		const outputLimit = this._configuredOutputLimit();
		if (outputLimit) {
			body.generationConfig = { maxOutputTokens: outputLimit };
		}
		if (systemInstruction) {
			body.systemInstruction = systemInstruction;
		}
		if (tools.length) {
			body.tools = [{
				functionDeclarations: tools.map(tool => ({
					name: tool.name,
					description: tool.description || tool.name,
					parameters: toGeminiFunctionParameters(tool.inputSchema),
				})),
			}];
		}

		const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
		const request = await this._fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': apiKey,
			},
			body: JSON.stringify(body),
		}, token);
		const response = request.response;
		if (!response.ok) {
			const errText = await response.text().catch(() => '');
			request.dispose();
			throw createModelHttpError('gemini', response.status, errText, response.statusText);
		}
		try {
			for await (const data of this._readEventData(response, token)) {
				const json = JSON.parse(data) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thoughtSignature?: string; functionCall?: { name?: string; args?: unknown } }> } }> };
				const responseParts: IChatResponsePart[] = [];
				for (const part of json.candidates?.[0]?.content?.parts ?? []) {
					if (part.text) {responseParts.push({ type: 'text', value: part.text });}
					if (part.functionCall?.name) {
						const toolUse: GeminiToolUsePart = {
							type: 'tool_use',
							name: part.functionCall.name,
							toolCallId: generateUuid(),
							parameters: part.functionCall.args ?? {},
							...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
						};
						responseParts.push(toolUse);
					}
				}
				if (responseParts.length) {yield responseParts;}
			}
		} finally {
			request.dispose();
		}
	}

	private async * _openai(
		modelId: string,
		messages: IChatMessage[],
		apiKey: string,
		tools: FolzeurToolDeclaration[],
		token: CancellationToken,
	): AsyncGenerator<IChatResponsePart[], void, unknown> {
		const openaiMessages: Array<Record<string, unknown>> = [];
		for (const message of messages) {
			const role = message.role === ChatMessageRole.System
				? 'system'
				: message.role === ChatMessageRole.Assistant
					? 'assistant'
					: 'user';
			const toolCalls = message.content.filter(p => p.type === 'tool_use');
			const toolResults = message.content.filter(p => p.type === 'tool_result');
			if (toolResults.length) {
				for (const result of toolResults) {
					if (result.type !== 'tool_result') {
						continue;
					}
					openaiMessages.push({
						role: 'tool',
						tool_call_id: result.toolCallId,
						content: result.value.map(v => v.type === 'text' ? v.value : JSON.stringify(v)).join('\n'),
					});
				}
				continue;
			}
			if (toolCalls.length && role === 'assistant') {
				openaiMessages.push({
					role: 'assistant',
					content: this._textOf(message.content.filter(p => p.type === 'text')) || null,
					tool_calls: toolCalls.map(call => call.type === 'tool_use' ? ({
						id: call.toolCallId,
						type: 'function',
						function: {
							name: call.name,
							arguments: JSON.stringify(call.parameters ?? {}),
						},
					}) : undefined).filter(Boolean),
				});
				continue;
			}
			openaiMessages.push({ role, content: this._textOf(message.content) });
		}

		const body: Record<string, unknown> = {
			model: modelId,
			messages: openaiMessages,
			stream: true,
		};
		const outputLimit = this._configuredOutputLimit();
		if (outputLimit) {
			body[/^(?:o[134]|gpt-5)(?:\b|-)/i.test(modelId) ? 'max_completion_tokens' : 'max_tokens'] = outputLimit;
		}
		if (tools.length) {
			body.tools = tools.map(tool => ({
				type: 'function',
				function: {
					name: tool.name,
					description: tool.description || tool.name,
					parameters: tool.inputSchema ?? { type: 'object', properties: {} },
				},
			}));
		}

		const request = await this._fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		}, token);
		const response = request.response;
		if (!response.ok) {
			const errText = await response.text().catch(() => '');
			request.dispose();
			throw createModelHttpError('openai', response.status, errText, response.statusText);
		}
		const pendingTools = new Map<number, { id: string; name: string; arguments: string }>();
		try {
			for await (const data of this._readEventData(response, token)) {
				if (data === '[DONE]') {break;}
				const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
				const delta = json.choices?.[0]?.delta;
				if (delta?.content) {yield [{ type: 'text', value: delta.content }];}
				for (const call of delta?.tool_calls ?? []) {
					const index = call.index ?? 0;
					const current = pendingTools.get(index) ?? { id: call.id || generateUuid(), name: '', arguments: '' };
					if (call.id) {current.id = call.id;}
					current.name += call.function?.name ?? '';
					current.arguments += call.function?.arguments ?? '';
					if (current.arguments.length > 2_000_000) {throw new Error('OpenAI streamed tool arguments exceed the safety limit.');}
					pendingTools.set(index, current);
				}
			}
			for (const call of [...pendingTools.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
				yield [{ type: 'tool_use', name: call.name || 'unknown', toolCallId: call.id, parameters: this._parseToolArguments(call.arguments) }];
			}
		} finally {
			request.dispose();
		}
	}

	private async * _claude(
		modelId: string,
		messages: IChatMessage[],
		apiKey: string,
		tools: FolzeurToolDeclaration[],
		token: CancellationToken,
	): AsyncGenerator<IChatResponsePart[], void, unknown> {
		let system: string | undefined;
		const claudeMessages: Array<Record<string, unknown>> = [];
		for (const message of messages) {
			if (message.role === ChatMessageRole.System) {
				system = this._textOf(message.content);
				continue;
			}
			const role = message.role === ChatMessageRole.Assistant ? 'assistant' : 'user';
			const content: Array<Record<string, unknown>> = [];
			for (const part of message.content) {
				if (part.type === 'text') {
					content.push({ type: 'text', text: part.value });
				} else if (part.type === 'tool_use') {
					content.push({
						type: 'tool_use',
						id: part.toolCallId,
						name: part.name,
						input: part.parameters ?? {},
					});
				} else if (part.type === 'tool_result') {
					content.push({
						type: 'tool_result',
						tool_use_id: part.toolCallId,
						content: part.value.map(v => v.type === 'text' ? v.value : JSON.stringify(v)).join('\n'),
					});
				}
			}
			if (content.length) {
				claudeMessages.push({ role, content });
			}
		}

		const body: Record<string, unknown> = {
			model: modelId,
			max_tokens: this._configuredOutputLimit(8192),
			messages: claudeMessages,
			stream: true,
		};
		if (system) {
			body.system = system;
		}
		if (tools.length) {
			body.tools = tools.map(tool => ({
				name: tool.name,
				description: tool.description || tool.name,
				input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
			}));
		}

		const request = await this._fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(body),
		}, token);
		const response = request.response;
		if (!response.ok) {
			const errText = await response.text().catch(() => '');
			request.dispose();
			throw createModelHttpError('claude', response.status, errText, response.statusText);
		}
		const pendingTools = new Map<number, { id: string; name: string; arguments: string; input?: unknown }>();
		try {
			for await (const data of this._readEventData(response, token)) {
				const event = JSON.parse(data) as { type?: string; index?: number; content_block?: { type?: string; id?: string; name?: string; input?: unknown }; delta?: { type?: string; text?: string; partial_json?: string } };
				if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {pendingTools.set(event.index ?? 0, { id: event.content_block.id || generateUuid(), name: event.content_block.name || 'unknown', arguments: '', input: event.content_block.input });}
				if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {yield [{ type: 'text', value: event.delta.text }];}
				if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
					const current = pendingTools.get(event.index ?? 0);
					if (current) {
						current.arguments += event.delta.partial_json ?? '';
						if (current.arguments.length > 2_000_000) {throw new Error('Anthropic streamed tool arguments exceed the safety limit.');}
					}
				}
				if (event.type === 'content_block_stop') {
					const current = pendingTools.get(event.index ?? 0);
					if (current) {
						yield [{ type: 'tool_use', name: current.name, toolCallId: current.id, parameters: current.arguments ? this._parseToolArguments(current.arguments) : current.input ?? {} }];
						pendingTools.delete(event.index ?? 0);
					}
				}
			}
		} finally {
			request.dispose();
		}
	}

	private async * _ollama(
		modelId: string,
		messages: IChatMessage[],
		tools: FolzeurToolDeclaration[],
		token: CancellationToken,
	): AsyncGenerator<IChatResponsePart[], void, unknown> {
		const ollamaMessages = messages.map(message => ({
			role: message.role === ChatMessageRole.System
				? 'system'
				: message.role === ChatMessageRole.Assistant
					? 'assistant'
					: 'user',
			content: this._textOf(message.content),
		}));
		const body: Record<string, unknown> = {
			model: modelId,
			messages: ollamaMessages,
			stream: true,
		};
		const outputLimit = this._configuredOutputLimit();
		if (outputLimit) {
			body.options = { num_predict: outputLimit };
		}
		if (tools.length) {
			body.tools = tools.map(tool => ({
				type: 'function',
				function: {
					name: tool.name,
					description: tool.description || tool.name,
					parameters: tool.inputSchema ?? { type: 'object', properties: {} },
				},
			}));
		}
		const request = await this._fetch('http://127.0.0.1:11434/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}, token);
		const response = request.response;
		if (!response.ok) {
			const errText = await response.text().catch(() => '');
			request.dispose();
			throw createModelHttpError('ollama', response.status, errText, response.statusText);
		}
		try {
			for await (const line of this._readLines(response, token)) {
				const json = JSON.parse(line) as { message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> } };
				const responseParts: IChatResponsePart[] = [];
				if (json.message?.content) {responseParts.push({ type: 'text', value: json.message.content });}
				for (const call of json.message?.tool_calls ?? []) {responseParts.push({ type: 'tool_use', name: call.function?.name || 'unknown', toolCallId: generateUuid(), parameters: call.function?.arguments ?? {} });}
				if (responseParts.length) {yield responseParts;}
			}
		} finally {
			request.dispose();
		}
	}

	private _parseToolArguments(value: string): unknown {
		if (!value.trim()) {return {};}
		try { return JSON.parse(value); } catch { return { raw: value }; }
	}

	private async * _readEventData(response: Response, token: CancellationToken): AsyncGenerator<string> {
		for await (const line of this._readLines(response, token)) {
			if (line.startsWith('data:')) {
				const data = line.slice(5).trimStart();
				if (data) {yield data;}
			}
		}
	}

	private async * _readLines(response: Response, token: CancellationToken): AsyncGenerator<string> {
		if (!response.body) {throw new Error('Provider response does not expose a streaming body.');}
		const reader = response.body.getReader();
		const decoder = new BoundedStreamLineDecoder();
		try {
			while (true) {
				if (token.isCancellationRequested) {throw new Error('Language model request cancelled.');}
				const { done, value } = await reader.read();
				if (done) {break;}
				for (const line of decoder.push(value)) {yield line;}
			}
			for (const line of decoder.finish()) {yield line;}
		} finally {
			reader.releaseLock();
		}
	}

	private async _fetch(input: string, init: RequestInit, token: CancellationToken): Promise<{ response: Response; dispose: () => void }> {
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		const timeout = setTimeout(() => controller.abort(), 120_000);
		let disposed = false;
		const dispose = () => {
			if (disposed) {return;}
			disposed = true;
			controller.abort();
			clearTimeout(timeout);
			cancellation.dispose();
		};
		try {
			if (token.isCancellationRequested) {controller.abort();}
			return { response: await fetch(input, { ...init, signal: controller.signal }), dispose };
		} catch (error) {
			dispose();
			throw error;
		}
	}
}
