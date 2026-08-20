/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeTool } from './INativeTool.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { assertPublicHttpUrl, fetchWithPolicy } from '../utils/AgentNetworkPolicy.js';
import { ISecretStorageService } from '../../../../../../platform/secrets/common/secrets.js';

const MAX_RESPONSE_CHARS = 120_000;
const FETCH_TIMEOUT_MS = 15_000;

function htmlToText(html: string): string {
	return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/\s+/g, ' ').trim();
}

async function fetchText(rawUrl: string, token: CancellationToken, headers?: Readonly<Record<string, string>>): Promise<{ text: string; contentType: string }> {
	const url = assertPublicHttpUrl(rawUrl);
	const response = await fetchWithPolicy(url, token, FETCH_TIMEOUT_MS, undefined, headers);
	if (!response.ok) {throw new Error(`HTTP ${response.status} ${response.statusText}`);}
	const contentType = response.headers.get('content-type') || '';
	const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
	return { text, contentType };
}

export class NativeWebSearchTool implements INativeTool {
	public readonly name = 'web_search';
	public readonly description = 'Search the public web and return a small set of titles, URLs, and snippets.';
	public readonly inputSchema = { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 2_000 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] };
	constructor(private readonly secretStorageService?: ISecretStorageService) { }

	public async execute(parameters: { query?: string; limit?: number }, _cwd: string, _progress?: unknown, token: CancellationToken = CancellationToken.None): Promise<string> {
		const query = parameters.query?.trim();
		if (!query) {throw new Error('query is required');}
		const limit = Math.min(10, Math.max(1, Math.floor(parameters.limit || 5)));
		const braveKey = await this.secretStorageService?.get('chat.api.webSearch.braveKey');
		if (braveKey) {
			try {
				const { text } = await fetchText(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, token, { accept: 'application/json', 'x-subscription-token': braveKey });
				const parsed = JSON.parse(text) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
				const results = (parsed.web?.results ?? []).slice(0, limit).map((item, index) => `${index + 1}. ${item.title ?? ''}\nURL: ${item.url ?? ''}\n${item.description ?? ''}`);
				if (results.length) {return `Web results for "${query}" (Brave Search API):\n${results.join('\n\n')}`;}
			} catch {
				// Continue with the public fallback when the configured provider is unavailable.
			}
		}
		const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
		try {
			const { text } = await fetchText(url, token);
			const results: string[] = [];
			const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
			let match: RegExpExecArray | null;
			while (results.length < limit && (match = pattern.exec(text))) {
				results.push(`${results.length + 1}. ${htmlToText(match[2])}\nURL: ${match[1]}\n${htmlToText(match[3])}`);
			}
			return results.length ? `Web results for "${query}" (DuckDuckGo fallback):\n${results.join('\n\n')}` : `No web results found for "${query}".`;
		} catch (error) { return `Web search failed: ${error instanceof Error ? error.message : String(error)}`; }
	}
}

export class NativeWebFetchTool implements INativeTool {
	public readonly name = 'web_fetch';
	public readonly description = 'Fetch a public HTTP(S) page and return bounded readable text.';
	public readonly inputSchema = { type: 'object', additionalProperties: false, properties: { url: { type: 'string', minLength: 8, maxLength: 8_192 } }, required: ['url'] };

	public async execute(parameters: { url?: string }, _cwd: string, _progress?: unknown, token: CancellationToken = CancellationToken.None): Promise<string> {
		const url = parameters.url?.trim();
		if (!url || !/^https?:\/\//i.test(url)) {throw new Error('url must use http:// or https://');}
		try {
			const result = await fetchText(url, token);
			const content = /html/i.test(result.contentType) ? htmlToText(result.text) : result.text;
			return `Fetched ${url}${result.text.length >= MAX_RESPONSE_CHARS ? ' (truncated)' : ''}:\n${content}`;
		} catch (error) { return `Web fetch failed: ${error instanceof Error ? error.message : String(error)}`; }
	}
}
