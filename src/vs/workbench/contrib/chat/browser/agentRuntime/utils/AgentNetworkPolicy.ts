/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';

interface ResolvedAddress { readonly address: string; readonly family: number }
interface DnsModule { readonly promises: { lookup(hostname: string, options: { all: true; verbatim: true }): Promise<ResolvedAddress[]> } }
interface NodeResponse {
	readonly statusCode?: number;
	readonly statusMessage?: string;
	readonly headers: Record<string, string | string[] | undefined>;
	on(event: 'data', listener: (chunk: Uint8Array) => void): void;
	on(event: 'end', listener: () => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
	destroy(error?: Error): void;
}
interface NodeRequest {
	on(event: 'error', listener: (error: Error) => void): void;
	end(): void;
	destroy(error?: Error): void;
}
interface HttpModule {
	request(options: Record<string, unknown>, listener: (response: NodeResponse) => void): NodeRequest;
}

export interface AgentNetworkResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
	readonly headers: { get(name: string): string | null };
	text(): Promise<string>;
}

const PRIVATE_IPV4 = [
	/^0\./,
	/^10\./,
	/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(?:1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^192\.(?:0\.0|0\.2|88\.99)\./,
	/^198\.(?:1[89]|51\.100)\./,
	/^203\.0\.113\./,
	/^224\./,
	/^24[0-9]\./,
	/^25[0-5]\./,
];

function builtinModule<T>(name: string): T | undefined {
	if (typeof process === 'undefined') {return undefined;}
	const candidate = process as typeof process & { getBuiltinModule?: (id: string) => unknown };
	return candidate.getBuiltinModule?.(name) as T | undefined;
}

function isBlockedAddress(rawAddress: string): boolean {
	const address = rawAddress.toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
	if (mapped) {return isBlockedAddress(mapped);}
	const mappedHex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
	if (mappedHex) {
		const high = Number.parseInt(mappedHex[1], 16);
		const low = Number.parseInt(mappedHex[2], 16);
		return isBlockedAddress(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
	}
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
		const octets = address.split('.').map(Number);
		if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {return true;}
		return PRIVATE_IPV4.some(pattern => pattern.test(address));
	}
	if (address.includes(':')) {
		return address === '::' || address === '::1' || /^f[cd]/.test(address) || /^fe[89ab]/.test(address) || /^ff/.test(address) || /^2001:db8(?::|$)/.test(address);
	}
	return true;
}

/** Performs URL syntax and literal-address checks. DNS targets are checked by fetchWithPolicy. */
export function assertPublicHttpUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error('A valid absolute HTTP(S) URL is required.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {throw new Error('Only HTTP(S) URLs are allowed.');}
	if (url.username || url.password) {throw new Error('URLs containing credentials are not allowed.');}
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === 'metadata.google.internal' || hostname === 'metadata.azure.internal' || hostname === 'metadata.google.com') {
		throw new Error(`Network security policy blocked local or private host: ${url.hostname}`);
	}
	if ((/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) && isBlockedAddress(hostname)) {
		throw new Error(`Network security policy blocked local or private host: ${url.hostname}`);
	}
	return url;
}

/** Resolves every address and fails closed if DNS is unavailable or any answer is non-public. */
export async function resolvePublicHttpUrl(rawUrl: string | URL): Promise<{ readonly url: URL; readonly addresses: readonly ResolvedAddress[] }> {
	const url = assertPublicHttpUrl(typeof rawUrl === 'string' ? rawUrl : rawUrl.toString());
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
		if (isBlockedAddress(hostname)) {throw new Error(`Network security policy blocked local or private host: ${url.hostname}`);}
		return { url, addresses: [{ address: hostname, family: hostname.includes(':') ? 6 : 4 }] };
	}
	const dns = builtinModule<DnsModule>('dns');
	if (!dns) {throw new Error('Secure DNS resolution is unavailable in this workbench.');}
	const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
	if (!addresses.length) {throw new Error(`DNS returned no addresses for ${hostname}.`);}
	const blocked = addresses.find(item => isBlockedAddress(item.address));
	if (blocked) {throw new Error(`Network security policy blocked ${hostname} because it resolves to ${blocked.address}.`);}
	return { url, addresses };
}

export function isNetworkEnabled(configurationService: IConfigurationService, capability: 'search' | 'fetch' | 'browser'): boolean {
	if (configurationService.getValue<boolean>('chat.api.allowNetwork') === false) {return false;}
	if (capability === 'search') {return configurationService.getValue<boolean>('chat.api.allowWebSearch') !== false;}
	if (capability === 'fetch') {return configurationService.getValue<boolean>('chat.api.allowFetch') !== false;}
	return configurationService.getValue<boolean>('chat.api.allowBrowser') !== false;
}

/** GET-only request with DNS pinning and validation repeated at every redirect hop. */
export async function fetchWithPolicy(rawUrl: URL, token: CancellationToken, timeoutMs = 15_000, maxBytes = 2 * 1024 * 1024, headers: Readonly<Record<string, string>> = {}): Promise<AgentNetworkResponse> {
	let current = rawUrl;
	for (let redirect = 0; redirect <= 5; redirect++) {
		const response = await requestOnceWithPolicy(current, token, timeoutMs, maxBytes, headers);
		if (![301, 302, 303, 307, 308].includes(response.status)) {return response;}
		const location = response.headers.get('location');
		if (!location) {throw new Error(`HTTP redirect ${response.status} did not include a Location header.`);}
		if (redirect === 5) {throw new Error('Network request exceeded the maximum of 5 redirects.');}
		current = (await resolvePublicHttpUrl(new URL(location, current))).url;
	}
	throw new Error('Network redirect validation failed.');
}

async function requestOnceWithPolicy(rawUrl: URL, token: CancellationToken, timeoutMs: number, maxBytes: number, extraHeaders: Readonly<Record<string, string>>): Promise<AgentNetworkResponse> {
	const { url, addresses } = await resolvePublicHttpUrl(rawUrl);
	const transport = builtinModule<HttpModule>(url.protocol === 'https:' ? 'https' : 'http');
	if (!transport) {throw new Error('Secure network transport is unavailable in this workbench.');}
	const selected = addresses[0];
	return await new Promise<AgentNetworkResponse>((resolve, reject) => {
		let settled = false;
		const operation: { request?: NodeRequest; timeout?: ReturnType<typeof setTimeout> } = {};
		let cancellation: { dispose(): void } = { dispose() { } };
		const finishError = (error: Error) => {
			if (settled) {return;}
			settled = true;
			if (operation.timeout) {clearTimeout(operation.timeout);}
			cancellation.dispose();
			reject(error);
		};
		operation.timeout = setTimeout(() => {
			const error = new Error(`Network request timed out after ${timeoutMs} ms.`);
			operation.request?.destroy(error);
			finishError(error);
		}, Math.max(1_000, Math.min(timeoutMs, 60_000)));
		cancellation = token.onCancellationRequested(() => {
			const error = new Error('Network request cancelled.');
			operation.request?.destroy(error);
			finishError(error);
		});
		if (token.isCancellationRequested) {
			finishError(new Error('Network request cancelled.'));
			return;
		}
		operation.request = transport.request({
			protocol: url.protocol,
			hostname: url.hostname.replace(/^\[|\]$/g, ''),
			port: url.port || undefined,
			path: `${url.pathname}${url.search}`,
			method: 'GET',
			headers: { 'user-agent': 'Folzeur-Agent/1.0', host: url.host, accept: '*/*', ...extraHeaders },
			servername: url.hostname.replace(/^\[|\]$/g, ''),
			lookup: (_hostname: string, _options: unknown, callback: (error: Error | null, address?: string, family?: number) => void) => callback(null, selected.address, selected.family),
		}, response => {
			const chunks: Uint8Array[] = [];
			let received = 0;
			response.on('data', chunk => {
				received += chunk.byteLength;
				if (received > maxBytes) {
					const error = new Error(`Network response exceeded ${maxBytes} bytes.`);
					response.destroy(error);
					finishError(error);
					return;
				}
				chunks.push(chunk);
			});
			response.on('error', finishError);
			response.on('end', () => {
				if (settled) {return;}
				settled = true;
				if (operation.timeout) {clearTimeout(operation.timeout);}
				cancellation.dispose();
				const bytes = new Uint8Array(received);
				let offset = 0;
				for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
				const body = new TextDecoder().decode(bytes);
				const status = response.statusCode ?? 0;
				resolve({
					ok: status >= 200 && status < 300,
					status,
					statusText: response.statusMessage ?? '',
					headers: { get: name => {
						const value = response.headers[name.toLowerCase()];
						return Array.isArray(value) ? value.join(', ') : value ?? null;
					} },
					text: async () => body,
				});
			});
		});
		operation.request.on('error', finishError);
		operation.request.end();
	});
}
