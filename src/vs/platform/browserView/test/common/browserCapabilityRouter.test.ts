/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { routeBrowserCapability } from '../../common/browserCapabilityRouter.js';

suite('BrowserCapabilityRouter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('routes each intent to a distinct capability', () => {
		assert.strictEqual(routeBrowserCapability({ purpose: 'discover' }), 'web_search');
		assert.strictEqual(routeBrowserCapability({ purpose: 'read_document', hasUrl: true }), 'web_fetch');
		assert.strictEqual(routeBrowserCapability({ purpose: 'interact', requiresRenderedDom: true }), 'integrated_browser');
		assert.strictEqual(routeBrowserCapability({ purpose: 'verify_local_ui', ownedLocalUrl: true }), 'isolated_verifier');
	});

	test('rejects verification against an unowned origin', () => {
		assert.throws(() => routeBrowserCapability({ purpose: 'verify_local_ui', ownedLocalUrl: false }), /owned local application/);
	});
});
