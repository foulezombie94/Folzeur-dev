/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BrowserPageOwnership } from '../../common/browserPageOwnership.js';

suite('BrowserPageOwnership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not leak a claimed page into another conversation', () => {
		const ownership = new BrowserPageOwnership();
		ownership.markShareable('tab-1');
		assert.strictEqual(ownership.claim('conversation-a', 'tab-1'), true);
		assert.strictEqual(ownership.owns('conversation-a', 'tab-1'), true);
		assert.strictEqual(ownership.owns('conversation-b', 'tab-1'), false);
		assert.deepStrictEqual(ownership.ownedPages('conversation-b'), []);
	});

	test('unsharing revokes every conversation and unknown pages cannot be claimed', () => {
		const ownership = new BrowserPageOwnership();
		assert.strictEqual(ownership.claim('conversation-a', 'unknown'), false);
		ownership.ownerCreatedPage('conversation-a', 'tab-1');
		ownership.claim('conversation-b', 'tab-1');
		ownership.stopSharing('tab-1');
		assert.strictEqual(ownership.owns('conversation-a', 'tab-1'), false);
		assert.strictEqual(ownership.owns('conversation-b', 'tab-1'), false);
	});
});
