/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { INativeTool } from './INativeTool.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { resolvePublicHttpUrl } from '../utils/AgentNetworkPolicy.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
// Playwright is an optional Node-only runtime dependency; this type-only import documents its boundary.
// eslint-disable-next-line local/code-import-patterns
import type { Browser, BrowserContext, ConsoleMessage, Page, Request, Response, Route, WebSocketRoute } from 'playwright-core';
import { LocalAppServerRegistry } from '../utils/LocalAppServerRegistry.js';
import { redactSecrets } from '../utils/SecretProtection.js';

const MAX_STORAGE_KEYS_PER_AREA = 100;
const MAX_STORAGE_KEY_CHARS = 256;
const MAX_STORAGE_VALUE_CHARS = 4_000;
const MAX_STORAGE_OUTPUT_CHARS = 20_000;

type BrowserStorageArea = 'local' | 'session';

export interface BrowserStorageSnapshot {
	readonly origin: string;
	readonly localStorage: Readonly<Record<string, string>>;
	readonly sessionStorage: Readonly<Record<string, string>>;
}

interface BrowserSession {
	browser: Browser | null;
	context: BrowserContext | null;
	page: Page | null;
	consoleLogs: string[];
	networkLogs: string[];
}

interface BrowserActionParameters {
	readonly sessionId?: string;
	readonly action?: 'launch' | 'click' | 'type' | 'screenshot' | 'get_console_logs' | 'get_network_logs' | 'get_text' | 'get_title' | 'inspect_dom' | 'accessibility_snapshot' | 'get_storage' | 'list_storage_keys' | 'get_storage_value' | 'wait_for' | 'assert' | 'evaluate' | 'close';
	readonly url?: string;
	readonly selector?: string;
	readonly text?: string;
	readonly expected?: string;
	readonly assertion?: 'visible' | 'text_contains' | 'title_contains' | 'url_contains';
	readonly timeoutMs?: number;
	readonly storageArea?: BrowserStorageArea;
	readonly storageKey?: string;
}

export class NativeBrowserActionTool extends Disposable implements INativeTool {
	public readonly name = 'browser_action';
	public readonly description = 'Launch a headless browser to interact with web pages, take screenshots, or analyze console errors.';
	public readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			sessionId: {
				type: 'string', maxLength: 100,
				description: 'The unique ID for this browser session (optional, defaults to "default").'
			},
			action: {
				type: 'string', maxLength: 50,
				enum: ['launch', 'click', 'type', 'screenshot', 'get_console_logs', 'get_network_logs', 'get_text', 'get_title', 'inspect_dom', 'accessibility_snapshot', 'get_storage', 'list_storage_keys', 'get_storage_value', 'wait_for', 'assert', 'evaluate', 'close'],
				description: 'The browser action to perform.'
			},
			url: {
				type: 'string', maxLength: 8_192,
				description: 'The URL to navigate to (used with "launch").'
			},
			selector: {
				type: 'string', maxLength: 4_000,
				description: 'The CSS selector for "click", "type", or "evaluate" actions.'
			},
			text: {
				type: 'string', maxLength: 20_000,
				description: 'The text to type (used with "type").'
			},
			expected: { type: 'string', maxLength: 20_000, description: 'Expected value for an assertion.' },
			assertion: { type: 'string', enum: ['visible', 'text_contains', 'title_contains', 'url_contains'], description: 'Deterministic browser assertion.' },
			timeoutMs: { type: 'integer', minimum: 100, maximum: 120_000, description: 'Bounded action timeout.' },
			storageArea: { type: 'string', enum: ['local', 'session'], description: 'Storage area used by list_storage_keys or get_storage_value.' },
			storageKey: { type: 'string', maxLength: MAX_STORAGE_KEY_CHARS, description: 'Exact current-origin key used by get_storage_value.' }
		},
		required: ['action']
	};

	private sessions = new Map<string, BrowserSession>();
	private tempFiles: URI[] = [];

	constructor(
		private readonly fileService: IFileService,
		private readonly localAppServerRegistry: LocalAppServerRegistry,
	) {
		super();
	}

	private getSession(sessionId: string = 'default'): BrowserSession {
		let session = this.sessions.get(sessionId);
		if (!session) {
			session = { browser: null, context: null, page: null, consoleLogs: [], networkLogs: [] };
			this.sessions.set(sessionId, session);
		}
		return session;
	}

	public async execute(parameters: BrowserActionParameters, cwd?: string, _progress?: unknown, token: CancellationToken = CancellationToken.None): Promise<string> {
		if (token.isCancellationRequested) {throw new Error('Browser action cancelled.');}
		const action = parameters.action;
		const sessionId = parameters.sessionId || 'default';
		const session = this.getSession(sessionId);
		
		try {
			// This optional Node dependency must stay lazy so browser workbench bundles can load.
			// eslint-disable-next-line local/code-amd-node-module
			const { chromium } = await import('playwright-core');

			if (action === 'launch' && parameters.url) {
				if (token.isCancellationRequested) {throw new Error('Browser action cancelled.');}
				const localUrl = this.localAppServerRegistry.resolveOwnedUrl(parameters.url);
				const safeUrl = localUrl?.toString() ?? (await resolvePublicHttpUrl(parameters.url)).url.toString();
				const localOrigin = localUrl?.origin;
				if (!session.browser) {
					// Use local Chrome/Edge channel to avoid needing playwright downloads
					const errors: string[] = [];
					for (const options of [{ channel: 'chrome' as const }, { channel: 'msedge' as const }, { channel: 'chromium' as const }, {}]) {
						try {session.browser = await chromium.launch({ headless: true, ...options }); break;} catch (error) {errors.push(errorMessage(error));}
					}
					if (!session.browser) {throw new Error(`No compatible Chromium executable was found. Install Chrome, Edge, or Playwright Chromium. Attempts: ${errors.join(' | ')}`);}
				}
				if (session.page) {
					await session.page.close();
				}
				if (session.context) {await session.context.close();}
				session.context = await session.browser.newContext({ serviceWorkers: localOrigin ? 'allow' : 'block', acceptDownloads: Boolean(localOrigin) });
				session.page = await session.context.newPage();
				session.consoleLogs = [];
				session.networkLogs = [];
				await session.context.route('**/*', async (route: Route) => {
					try {
						const requested = new URL(route.request().url());
						if (localOrigin && requested.origin === localOrigin) {
							await route.continue();
							return;
						}
						if (route.request().method() !== 'GET') {throw new Error('Only registered local applications may issue non-GET browser requests.');}
						await resolvePublicHttpUrl(requested.toString());
						await route.continue();
					} catch {
						await route.abort('blockedbyclient');
					}
				});
				if (!localOrigin && typeof session.context.routeWebSocket === 'function') {await session.context.routeWebSocket(/.*/, (socket: WebSocketRoute) => socket.close());}
				if (!localOrigin) {await session.context.addInitScript(() => {
					Object.defineProperty(globalThis, 'WebSocket', { configurable: false, value: class { constructor() { throw new Error('WebSockets are disabled by agent browser policy.'); } } });
				});}
				
				session.page.on('console', (msg: ConsoleMessage) => {
					session.consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
					if (session.consoleLogs.length > 500) {
						session.consoleLogs.shift();
					}
				});
				session.page.on('request', (request: Request) => this.pushNetworkLog(session, `-> ${request.method()} ${request.url()}`));
				session.page.on('response', (response: Response) => this.pushNetworkLog(session, `<- ${response.status()} ${response.url()}`));

				const cancellation = token.onCancellationRequested(() => void session.page?.close().catch(() => { }));
				try {
					await session.page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
				} catch (err) {
					await session.page.close();
					session.page = null;
					return `Failed to navigate: ${errorMessage(err)}. Page closed.`;
				} finally { cancellation.dispose(); }
				return `Navigated to ${safeUrl} via Playwright Chromium (Session: ${sessionId}).`;
				
			} else if (action === 'click') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				const selector = parameters.selector;
				if (!selector) {return 'selector is required for click.';}
				await this.runPageAction(session, token, session.page.click(selector));
				return `Clicked on ${selector}.`;
				
			} else if (action === 'type') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				const selector = parameters.selector;
				if (!selector) {return 'selector is required for type.';}
				await this.runPageAction(session, token, session.page.fill(selector, parameters.text || ''));
				return `Typed text into ${selector}.`;
				
			} else if (action === 'get_text' || action === 'evaluate') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				if (parameters.selector) {
					const text = await this.runPageAction<string | null>(session, token, session.page.locator(parameters.selector).textContent());
					return text !== null ? text.substring(0, 3000) : 'Selector not found.';
				}
				const text = await this.runPageAction<string>(session, token, session.page.locator('body').innerText());
				return text.substring(0, 20_000);
			} else if (action === 'get_title') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				const title = await this.runPageAction<string>(session, token, session.page.title() as Promise<string>);
				return `Page title: ${title}`;
			} else if (action === 'inspect_dom') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				const locator = session.page.locator(parameters.selector || 'body').first();
				const html = await this.runPageAction<string>(session, token, locator.evaluate(element => element.outerHTML));
				return html.slice(0, 20_000);
			} else if (action === 'accessibility_snapshot') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				const snapshot = await this.runPageAction<string>(session, token, session.page.locator(parameters.selector || 'body').ariaSnapshot({ timeout: parameters.timeoutMs ?? 10_000 }));
				return snapshot.slice(0, 30_000);
			} else if (action === 'get_storage') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				const storage = await this.readCurrentOriginStorage(session, token);
				return boundedStorageJson(sanitizeBrowserStorageSnapshot(storage));
			} else if (action === 'list_storage_keys') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				const storage = await this.readCurrentOriginStorage(session, token);
				return boundedStorageJson({
					origin: storage.origin,
					localStorage: Object.keys(storage.localStorage).sort(),
					sessionStorage: Object.keys(storage.sessionStorage).sort(),
				});
			} else if (action === 'get_storage_value') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				if (!parameters.storageArea || !parameters.storageKey) {return 'storageArea and storageKey are required for get_storage_value.';}
				const storage = await this.readCurrentOriginStorage(session, token);
				const source = parameters.storageArea === 'local' ? storage.localStorage : storage.sessionStorage;
				const value = Object.hasOwn(source, parameters.storageKey) ? source[parameters.storageKey] : null;
				return boundedStorageJson({
					origin: storage.origin,
					storageArea: parameters.storageArea,
					storageKey: parameters.storageKey,
					value: value === null ? null : redactBrowserStorageValue(parameters.storageKey, value),
				});
			} else if (action === 'wait_for') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				if (!parameters.selector) {return 'selector is required for wait_for.';}
				await this.runPageAction(session, token, session.page.locator(parameters.selector).waitFor({ state: 'visible', timeout: parameters.timeoutMs ?? 10_000 }));
				return `Selector became visible: ${parameters.selector}`;
			} else if (action === 'assert') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				const assertion = parameters.assertion;
				if (!assertion) {return 'assertion is required for assert.';}
				if (assertion === 'visible') {
					if (!parameters.selector) {return 'selector is required for visible assertion.';}
					await this.runPageAction(session, token, session.page.locator(parameters.selector).waitFor({ state: 'visible', timeout: parameters.timeoutMs ?? 10_000 }));
				} else {
					const expected = parameters.expected ?? '';
					const actual = assertion === 'title_contains' ? await session.page.title() : assertion === 'url_contains' ? session.page.url() : await session.page.locator(parameters.selector || 'body').innerText();
					if (!actual.includes(expected)) {throw new Error(`Browser assertion failed: ${assertion} expected ${JSON.stringify(expected)} in ${JSON.stringify(actual.slice(0, 1_000))}.`);}
				}
				return `Browser assertion passed: ${assertion}.`;
				
			} else if (action === 'screenshot') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				const buffer = await this.runPageAction<Uint8Array>(session, token, session.page.screenshot({ type: 'jpeg', quality: 50 }) as Promise<Uint8Array>);
				
				const uuid = generateUuid();
				const tempDir = URI.joinPath(URI.file(cwd || '.'), '.folzeur', 'temp');
				const screenshotUri = URI.joinPath(tempDir, `screenshot_${uuid}.jpg`);
				
				await this.fileService.createFolder(tempDir);
				await this.fileService.writeFile(screenshotUri, VSBuffer.wrap(buffer));
				this.tempFiles.push(screenshotUri);
				
				return `[Screenshot taken] Saved to disk: ${screenshotUri.fsPath}`;
				
			} else if (action === 'get_console_logs') {
				const logs = session.consoleLogs.join('\n');
				session.consoleLogs = [];
				return logs || 'No console logs.';
			} else if (action === 'get_network_logs') {
				const logs = session.networkLogs.join('\n');
				session.networkLogs = [];
				return logs || 'No network logs.';
				
			} else if (action === 'close') {
				if (session.context) {await session.context.close();}
				if (session.browser) {
					await session.browser.close();
				}
				this.sessions.delete(sessionId);
				return `Browser session ${sessionId} closed.`;
			}
			
			return `Unknown action ${action}.`;
		} catch (error) {
			// Tool failures must reject so the task runtime cannot record a failed
			// assertion, navigation, or browser mutation as successful evidence.
			throw new Error(`Playwright error during ${action}: ${errorMessage(error)}`);
		}
	}

	private async runPageAction<T>(session: BrowserSession, token: CancellationToken, operation: Promise<T>): Promise<T> {
		if (token.isCancellationRequested) {throw new Error('Browser action cancelled.');}
		return await new Promise<T>((resolve, reject) => {
			let settled = false;
			const cancellation = token.onCancellationRequested(() => {
				if (settled) {return;}
				settled = true;
				void session.page?.close().catch(() => { });
				reject(new Error('Browser action cancelled.'));
			});
			operation.then(value => {
				if (settled) {return;}
				settled = true;
				cancellation.dispose();
				resolve(value);
			}, error => {
				if (settled) {return;}
				settled = true;
				cancellation.dispose();
				reject(error);
			});
		});
	}

	private async readCurrentOriginStorage(session: BrowserSession, token: CancellationToken): Promise<BrowserStorageSnapshot> {
		if (!session.page) {throw new Error('No page loaded. Call launch first.');}
		return this.runPageAction(session, token, session.page.evaluate(({ maxKeys, maxKeyChars, maxValueChars }) => {
			const read = (storage: Storage): Record<string, string> => {
				const entries: Record<string, string> = {};
				for (let index = 0; index < Math.min(storage.length, maxKeys); index++) {
					const key = storage.key(index);
					if (key === null || key.length > maxKeyChars) {continue;}
					const value = storage.getItem(key);
					if (value !== null) {entries[key] = value.slice(0, maxValueChars);}
				}
				return entries;
			};
			return {
				origin: globalThis.location.origin,
				localStorage: read(globalThis.localStorage),
				sessionStorage: read(globalThis.sessionStorage),
			};
		}, { maxKeys: MAX_STORAGE_KEYS_PER_AREA, maxKeyChars: MAX_STORAGE_KEY_CHARS, maxValueChars: MAX_STORAGE_VALUE_CHARS }));
	}

	private pushNetworkLog(session: BrowserSession, value: string): void {
		session.networkLogs.push(value.slice(0, 4_000));
		if (session.networkLogs.length > 1_000) {session.networkLogs.shift();}
	}

	public async closeAll(): Promise<void> {
		for (const session of this.sessions.values()) {
			await session.context?.close().catch(() => undefined);
			await session.browser?.close().catch(() => undefined);
		}
		this.sessions.clear();
	}

	public override dispose() {
		for (const session of this.sessions.values()) {
			if (session.context) {session.context.close().catch(() => {});}
			if (session.page) {
				session.page.close().catch(() => {});
			}
			if (session.browser) {
				session.browser.close().catch(() => {});
			}
		}
		this.sessions.clear();
		for (const fileUri of this.tempFiles) {
			this.fileService.del(fileUri, { recursive: false }).catch(() => {});
		}
		this.tempFiles = [];
		super.dispose();
	}
}

export function sanitizeBrowserStorageSnapshot(snapshot: BrowserStorageSnapshot): BrowserStorageSnapshot {
	const sanitize = (entries: Readonly<Record<string, string>>): Readonly<Record<string, string>> => Object.fromEntries(
		Object.entries(entries)
			.sort(([left], [right]) => left.localeCompare(right))
			.slice(0, MAX_STORAGE_KEYS_PER_AREA)
			.map(([key, value]) => [key.slice(0, MAX_STORAGE_KEY_CHARS), redactBrowserStorageValue(key, value.slice(0, MAX_STORAGE_VALUE_CHARS))])
	);
	return {
		origin: snapshot.origin,
		localStorage: sanitize(snapshot.localStorage),
		sessionStorage: sanitize(snapshot.sessionStorage),
	};
}

function redactBrowserStorageValue(key: string, value: string): string {
	const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
	const sensitiveKeyParts = ['authorization', 'accesstoken', 'refreshtoken', 'authtoken', 'token', 'secret', 'password', 'passwd', 'cookie', 'session', 'apikey', 'credential', 'bearer', 'jwt', 'csrftoken', 'email', 'userprofile', 'accountid', 'userid'];
	return sensitiveKeyParts.some(part => normalizedKey.includes(part)) ? '[REDACTED]' : redactSecrets(value);
}

function boundedStorageJson(value: unknown): string {
	const serialized = JSON.stringify(value, undefined, 2);
	if (serialized.length <= MAX_STORAGE_OUTPUT_CHARS) {return serialized;}
	return JSON.stringify({ truncated: true, preview: serialized.slice(0, Math.floor(MAX_STORAGE_OUTPUT_CHARS / 3)) }, undefined, 2);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
