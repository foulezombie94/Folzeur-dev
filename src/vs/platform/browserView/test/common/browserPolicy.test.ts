/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BROWSER_SAFETY_LIMITS, classifyBrowserAccess, classifyBrowserOrigin, classifyBrowserRisk, evaluateBrowserPolicy } from '../../common/browserPolicy.js';

suite('Browser action policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('separates view, interaction, and sensitive actions', () => {
		assert.strictEqual(classifyBrowserAccess({ action: 'read_page' }), 'view');
		assert.strictEqual(classifyBrowserAccess({ action: 'click_element', selector: '#menu' }), 'interact');
		assert.strictEqual(classifyBrowserAccess({ action: 'type_in_page', selector: 'input[type=password]', text: 'secret' }), 'sensitive');
		assert.strictEqual(classifyBrowserAccess({ action: 'handle_dialog' }), 'sensitive');
		assert.strictEqual(classifyBrowserAccess({ action: 'run_playwright_code' }), 'sensitive');
	});

	test('uses commercial soft and hard budgets', () => {
		assert.deepStrictEqual({
			actions: [BROWSER_SAFETY_LIMITS.softActions, BROWSER_SAFETY_LIMITS.hardActions],
			navigations: [BROWSER_SAFETY_LIMITS.softNavigations, BROWSER_SAFETY_LIMITS.hardNavigations],
			repeated: [BROWSER_SAFETY_LIMITS.warnRepeatedActions, BROWSER_SAFETY_LIMITS.hardRepeatedActions],
			timeouts: [BROWSER_SAFETY_LIMITS.clickTimeoutMs, BROWSER_SAFETY_LIMITS.actionTimeoutMs, BROWSER_SAFETY_LIMITS.navigationTimeoutMs, BROWSER_SAFETY_LIMITS.playwrightCodeTimeoutMs],
			tabs: BROWSER_SAFETY_LIMITS.maxTabs,
			screenshots: BROWSER_SAFETY_LIMITS.maxScreenshots,
		}, { actions: [150, 250], navigations: [30, 50], repeated: [3, 5], timeouts: [10_000, 15_000, 30_000, 5_000], tabs: 10, screenshots: 75 });
	});

	test('never auto-confirms sensitive actions and blocks unsupported schemes', () => {
		const sensitive = evaluateBrowserPolicy({ action: 'click_element', selector: 'button.delete', url: 'https://example.test' });
		assert.strictEqual(sensitive.allowed, true);
		assert.strictEqual(sensitive.requiresConfirmation, true);
		assert.strictEqual(sensitive.access, 'sensitive');
		assert.strictEqual(sensitive.risk, 'dangerous');
		assert.strictEqual(classifyBrowserOrigin('javascript:alert(1)', false, false), 'blocked');
		assert.strictEqual(classifyBrowserOrigin('file:///tmp/secret', false, true), 'blocked');
		assert.strictEqual(classifyBrowserOrigin('chrome://settings', false, true), 'blocked');
		assert.strictEqual(evaluateBrowserPolicy({ action: 'read_page', url: 'javascript:alert(1)' }).allowed, false);
	});

	test('keeps consequential actions gated in every approval mode', () => {
		for (const approvalMode of ['manual', 'trusted', 'auto'] as const) {
			assert.strictEqual(evaluateBrowserPolicy({ action: 'click_element', selector: 'button:has-text("Delete account")', url: 'https://example.test', approvalMode }).requiresConfirmation, true);
			assert.strictEqual(evaluateBrowserPolicy({ action: 'run_playwright_code', url: 'http://localhost:3000', ownedLocalOrigin: true, approvalMode }).requiresConfirmation, true);
		}
		assert.strictEqual(classifyBrowserRisk({ action: 'get_storage_value', storageKey: 'theme' }), 'safe');
		assert.strictEqual(classifyBrowserRisk({ action: 'get_storage_value', storageKey: 'access_token' }), 'dangerous');
	});

	test('allows owned local verification interactions without remote approval', () => {
		const decision = evaluateBrowserPolicy({ action: 'click_element', selector: '#preview', url: 'http://127.0.0.1:3000', ownedLocalOrigin: true });
		assert.deepStrictEqual({ access: decision.access, origin: decision.origin, allowed: decision.allowed, requiresConfirmation: decision.requiresConfirmation }, {
			access: 'interact', origin: 'local', allowed: true, requiresConfirmation: false,
		});
	});
});
