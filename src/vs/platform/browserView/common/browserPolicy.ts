/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type BrowserAccessLevel = 'view' | 'interact' | 'sensitive';
export type BrowserOriginTrust = 'local' | 'trusted' | 'public' | 'blocked';

export interface BrowserPolicyInput {
	readonly action: string;
	readonly url?: string;
	readonly selector?: string;
	readonly text?: string;
	readonly trustedOrigin?: boolean;
	readonly ownedLocalOrigin?: boolean;
}

export interface BrowserPolicyDecision {
	readonly access: BrowserAccessLevel;
	readonly origin: BrowserOriginTrust;
	readonly allowed: boolean;
	readonly requiresConfirmation: boolean;
	readonly reason: string;
}

const VIEW_ACTIONS = new Set([
	'read_page', 'screenshot_page', 'get_text', 'get_title', 'inspect_dom',
	'accessibility_snapshot', 'get_console_logs', 'get_network_logs', 'list_storage_keys', 'wait_for', 'assert',
]);

const SENSITIVE_ACTIONS = new Set([
	'run_playwright_code', 'handle_dialog', 'get_storage', 'get_storage_value',
	'upload', 'download', 'authenticate', 'purchase', 'publish', 'delete',
]);

const SENSITIVE_HINT = /(?:pass(?:word|code)?|secret|token|credential|auth|oauth|sign[-_ ]?in|login|payment|card|checkout|purchase|publish|delete|remove|upload|download|file)/i;

export function evaluateBrowserPolicy(input: BrowserPolicyInput): BrowserPolicyDecision {
	const access = classifyBrowserAccess(input);
	const origin = classifyBrowserOrigin(input.url, input.ownedLocalOrigin === true, input.trustedOrigin === true);
	if (origin === 'blocked') {
		return { access, origin, allowed: false, requiresConfirmation: false, reason: 'The target origin is blocked by browser policy.' };
	}
	if (access === 'sensitive') {
		return { access, origin, allowed: true, requiresConfirmation: true, reason: 'This browser action may disclose data or cause a consequential external effect.' };
	}
	if (access === 'interact' && origin !== 'local') {
		return { access, origin, allowed: true, requiresConfirmation: true, reason: 'Interaction with a remote origin requires user approval.' };
	}
	return { access, origin, allowed: true, requiresConfirmation: false, reason: access === 'view' ? 'Read-only browser action.' : 'Interaction with an owned local application.' };
}

export function classifyBrowserAccess(input: BrowserPolicyInput): BrowserAccessLevel {
	if (SENSITIVE_ACTIONS.has(input.action)) { return 'sensitive'; }
	if (input.action === 'type_in_page' || input.action === 'type') {
		return SENSITIVE_HINT.test(`${input.selector ?? ''} ${input.text ?? ''}`) ? 'sensitive' : 'interact';
	}
	if (input.action === 'click_element' || input.action === 'click') {
		return SENSITIVE_HINT.test(input.selector ?? '') ? 'sensitive' : 'interact';
	}
	if (VIEW_ACTIONS.has(input.action)) { return 'view'; }
	return 'interact';
}

export function classifyBrowserOrigin(rawUrl: string | undefined, ownedLocalOrigin: boolean, trustedOrigin: boolean): BrowserOriginTrust {
	if (!rawUrl || rawUrl === 'about:blank') { return ownedLocalOrigin ? 'local' : 'public'; }
	let url: URL;
	try { url = new URL(rawUrl); } catch { return 'blocked'; }
	if (!['http:', 'https:', 'file:', 'about:'].includes(url.protocol)) { return 'blocked'; }
	if (ownedLocalOrigin && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { return 'local'; }
	return trustedOrigin ? 'trusted' : 'public';
}
