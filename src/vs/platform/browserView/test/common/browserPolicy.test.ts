/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { classifyBrowserAccess, classifyBrowserOrigin, evaluateBrowserPolicy } from '../../common/browserPolicy.js';

suite('Browser action policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('separates view, interaction, and sensitive actions', () => {
		assert.strictEqual(classifyBrowserAccess({ action: 'read_page' }), 'view');
		assert.strictEqual(classifyBrowserAccess({ action: 'click_element', selector: '#menu' }), 'interact');
		assert.strictEqual(classifyBrowserAccess({ action: 'type_in_page', selector: 'input[type=password]', text: 'secret' }), 'sensitive');
		assert.strictEqual(classifyBrowserAccess({ action: 'handle_dialog' }), 'sensitive');
		assert.strictEqual(classifyBrowserAccess({ action: 'run_playwright_code' }), 'sensitive');
	});

	test('never auto-confirms sensitive actions and blocks unsupported schemes', () => {
		const sensitive = evaluateBrowserPolicy({ action: 'click_element', selector: 'button.delete', url: 'https://example.test' });
		assert.strictEqual(sensitive.allowed, true);
		assert.strictEqual(sensitive.requiresConfirmation, true);
		assert.strictEqual(sensitive.access, 'sensitive');
		assert.strictEqual(classifyBrowserOrigin('javascript:alert(1)', false, false), 'blocked');
		assert.strictEqual(evaluateBrowserPolicy({ action: 'read_page', url: 'javascript:alert(1)' }).allowed, false);
	});

	test('allows owned local verification interactions without remote approval', () => {
		const decision = evaluateBrowserPolicy({ action: 'click_element', selector: '#preview', url: 'http://127.0.0.1:3000', ownedLocalOrigin: true });
		assert.deepStrictEqual({ access: decision.access, origin: decision.origin, allowed: decision.allowed, requiresConfirmation: decision.requiresConfirmation }, {
			access: 'interact', origin: 'local', allowed: true, requiresConfirmation: false,
		});
	});
});
