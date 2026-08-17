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
import type { Browser, BrowserContext, ConsoleMessage, Page, Route, WebSocketRoute } from 'playwright-core';

interface BrowserSession {
	browser: Browser | null;
	context: BrowserContext | null;
	page: Page | null;
	consoleLogs: string[];
}

interface BrowserActionParameters {
	readonly sessionId?: string;
	readonly action?: 'launch' | 'click' | 'type' | 'screenshot' | 'get_console_logs' | 'evaluate' | 'close';
	readonly url?: string;
	readonly selector?: string;
	readonly text?: string;
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
				enum: ['launch', 'click', 'type', 'screenshot', 'get_console_logs', 'evaluate', 'close'],
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
			}
		},
		required: ['action']
	};

	private sessions = new Map<string, BrowserSession>();
	private tempFiles: URI[] = [];

	constructor(
		private readonly fileService: IFileService
	) {
		super();
	}

	private getSession(sessionId: string = 'default'): BrowserSession {
		let session = this.sessions.get(sessionId);
		if (!session) {
			session = { browser: null, context: null, page: null, consoleLogs: [] };
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
				const safeUrl = (await resolvePublicHttpUrl(parameters.url)).url.toString();
				if (!session.browser) {
					// Use local Chrome/Edge channel to avoid needing playwright downloads
					try {
						session.browser = await chromium.launch({ headless: true, channel: 'chrome' });
					} catch (e) {
						session.browser = await chromium.launch({ headless: true, channel: 'msedge' });
					}
				}
				if (session.page) {
					await session.page.close();
				}
				if (session.context) {await session.context.close();}
				session.context = await session.browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
				session.page = await session.context.newPage();
				session.consoleLogs = [];
				await session.context.route('**/*', async (route: Route) => {
					try {
						if (route.request().method() !== 'GET') {throw new Error('Only GET browser requests are allowed.');}
						await resolvePublicHttpUrl(route.request().url());
						await route.continue();
					} catch {
						await route.abort('blockedbyclient');
					}
				});
				if (typeof session.context.routeWebSocket === 'function') {await session.context.routeWebSocket(/.*/, (socket: WebSocketRoute) => socket.close());}
				await session.context.addInitScript(() => {
					Object.defineProperty(globalThis, 'WebSocket', { configurable: false, value: class { constructor() { throw new Error('WebSockets are disabled by agent browser policy.'); } } });
				});
				
				session.page.on('console', (msg: ConsoleMessage) => {
					session.consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
					if (session.consoleLogs.length > 500) {
						session.consoleLogs.shift();
					}
				});

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
				
			} else if (action === 'evaluate') {
				if (!session.page) {return 'No page loaded. Call launch first.';}
				if (parameters.selector) {
					const text = await this.runPageAction<string | null>(session, token, session.page.locator(parameters.selector).textContent());
					return text !== null ? text.substring(0, 3000) : 'Selector not found.';
				} else {
					const title = await this.runPageAction<string>(session, token, session.page.title() as Promise<string>);
					return `Page title: ${title}`;
				}
				
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
			return `Playwright error during ${action}: ${errorMessage(error)}`;
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
