/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type BrowserAccessLevel = 'view' | 'interact' | 'sensitive';
export type BrowserRisk = 'safe' | 'sensitive' | 'dangerous' | 'blocked';
export type BrowserApprovalMode = 'manual' | 'trusted' | 'auto';
export type BrowserOriginTrust = 'local' | 'trusted' | 'public' | 'blocked';

export const BROWSER_SAFETY_LIMITS = Object.freeze({
	softActions: 150,
	hardActions: 250,
	softNavigations: 30,
	hardNavigations: 50,
	warnRepeatedActions: 3,
	hardRepeatedActions: 5,
	sessionLifetimeMs: 30 * 60_000,
	idleLifetimeMs: 10 * 60_000,
	actionTimeoutMs: 15_000,
	clickTimeoutMs: 10_000,
	typeTimeoutMs: 10_000,
	waitTimeoutMs: 15_000,
	navigationTimeoutMs: 30_000,
	networkIdleTimeoutMs: 5_000,
	playwrightCodeTimeoutMs: 5_000,
	maxToolOutputChars: 20_000,
	maxLogArchiveChars: 2_000_000,
	maxTabs: 10,
	maxScreenshots: 75,
	maxStorageKeys: 100,
	maxStorageKeyChars: 256,
	maxStorageValueChars: 4_000,
	maxStorageResponseChars: 20_000,
	maxPlaywrightCodeChars: 10_000,
	maxPlaywrightResultChars: 20_000,
});

export interface BrowserPolicyInput {
	readonly action: string;
	readonly url?: string;
	readonly selector?: string;
	readonly text?: string;
	readonly storageKey?: string;
	readonly trustedOrigin?: boolean;
	readonly ownedLocalOrigin?: boolean;
	readonly approvalMode?: BrowserApprovalMode;
}

export interface BrowserPolicyDecision {
	readonly access: BrowserAccessLevel;
	readonly risk: BrowserRisk;
	readonly origin: BrowserOriginTrust;
	readonly allowed: boolean;
	readonly requiresConfirmation: boolean;
	readonly reason: string;
}

const SAFE_ACTIONS = new Set([
	'read_page', 'screenshot_page', 'get_text', 'get_title', 'inspect_dom',
	'accessibility_snapshot', 'get_console_logs', 'list_storage_keys', 'wait_for', 'assert',
]);

const DANGEROUS_ACTIONS = new Set([
	'run_playwright_code', 'handle_dialog', 'get_storage', 'upload', 'download',
	'authenticate', 'purchase', 'publish', 'delete', 'send', 'merge', 'deploy',
]);

const SENSITIVE_STORAGE_KEY = /(?:token|access.?token|refresh.?token|secret|pass(?:word|wd)?|authorization|api.?key|session|credential|bearer|jwt|csrf|cookie)/i;
const DANGEROUS_HINT = /(?:delete|remove|cancel\s+(?:account|subscription)|unsubscribe|purchase|\bpay\b|payment|checkout|submit|publish|\bsend\b|merge|deploy|upload|download)/i;
const CREDENTIAL_HINT = /(?:pass(?:word|code)?|secret|token|credential|auth|oauth|sign[-_ ]?in|login|card)/i;

export function evaluateBrowserPolicy(input: BrowserPolicyInput): BrowserPolicyDecision {
	const risk = classifyBrowserRisk(input);
	const access = risk === 'safe' ? 'view' : risk === 'sensitive' ? 'interact' : 'sensitive';
	const origin = classifyBrowserOrigin(input.url, input.ownedLocalOrigin === true, input.trustedOrigin === true);
	if (origin === 'blocked' || risk === 'blocked') {
		return { access, risk: 'blocked', origin, allowed: false, requiresConfirmation: false, reason: 'The target origin or browser action is blocked by browser policy.' };
	}
	const approvalMode = input.approvalMode ?? 'trusted';
	if (risk === 'dangerous') {
		return { access, risk, origin, allowed: true, requiresConfirmation: true, reason: 'This browser action may disclose restricted data or cause a consequential external effect.' };
	}
	if (risk === 'sensitive') {
		const requiresConfirmation = approvalMode === 'manual' || (approvalMode === 'trusted' && origin !== 'local');
		return { access, risk, origin, allowed: true, requiresConfirmation, reason: requiresConfirmation ? 'Interaction with this origin requires user approval.' : 'Interaction is permitted by the active browser approval mode.' };
	}
	return { access, risk, origin, allowed: true, requiresConfirmation: false, reason: 'Read-only browser action.' };
}

export function classifyBrowserRisk(input: BrowserPolicyInput): BrowserRisk {
	if (DANGEROUS_ACTIONS.has(input.action)) { return 'dangerous'; }
	if (input.action === 'get_storage_value') { return input.storageKey && !SENSITIVE_STORAGE_KEY.test(input.storageKey) ? 'safe' : 'dangerous'; }
	if (input.action === 'get_network_logs') { return 'sensitive'; }
	if (input.action === 'type_in_page' || input.action === 'type') {
		const target = `${input.selector ?? ''} ${input.text ?? ''}`;
		return DANGEROUS_HINT.test(target) || CREDENTIAL_HINT.test(target) ? 'dangerous' : 'sensitive';
	}
	if (input.action === 'click_element' || input.action === 'click') {
		const target = `${input.selector ?? ''} ${input.text ?? ''}`;
		return DANGEROUS_HINT.test(target) ? 'dangerous' : 'sensitive';
	}
	if (input.action === 'navigate_page' || input.action === 'navigate' || input.action === 'launch') { return 'sensitive'; }
	if (SAFE_ACTIONS.has(input.action)) { return 'safe'; }
	return 'sensitive';
}

export function classifyBrowserAccess(input: BrowserPolicyInput): BrowserAccessLevel {
	const risk = classifyBrowserRisk(input);
	return risk === 'safe' ? 'view' : risk === 'sensitive' ? 'interact' : 'sensitive';
}

export function classifyBrowserOrigin(rawUrl: string | undefined, ownedLocalOrigin: boolean, trustedOrigin: boolean): BrowserOriginTrust {
	if (!rawUrl || rawUrl === 'about:blank') { return ownedLocalOrigin ? 'local' : 'public'; }
	let url: URL;
	try { url = new URL(rawUrl); } catch { return 'blocked'; }
	if (!['http:', 'https:'].includes(url.protocol)) { return 'blocked'; }
	if (ownedLocalOrigin && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { return 'local'; }
	return trustedOrigin ? 'trusted' : 'public';
}

export function isSensitiveBrowserStorageKey(key: string): boolean {
	return SENSITIVE_STORAGE_KEY.test(key);
}
