/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { sanitizeBrowserStorageSnapshot } from '../../../browser/agentRuntime/tools/NativeBrowserActionTool.js';
import { resolveNativeToolPolicy } from '../../../browser/agentRuntime/tools/NativeToolPolicyRegistry.js';

suite('Native browser storage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('redacts secrets and requires confirmation before reading one value', () => {
		const sanitized = sanitizeBrowserStorageSnapshot({
			origin: 'https://example.test',
			localStorage: {
				access_token: 'eyJhbGciOiJIUzI1NiJ9.secret.signature',
				theme: 'dark',
				innocentKey: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz',
			},
			sessionStorage: {
				userEmail: 'person@example.test',
			},
		});
		assert.deepStrictEqual(sanitized, {
			origin: 'https://example.test',
			localStorage: {
				access_token: '[REDACTED]',
				innocentKey: '[REDACTED_TOKEN]',
				theme: 'dark',
			},
			sessionStorage: {
				userEmail: '[REDACTED]',
			},
		});
		assert.strictEqual(resolveNativeToolPolicy('browser_action', { action: 'get_storage_value', storageKey: 'theme' }).requiresConfirmation, true);
		assert.strictEqual(resolveNativeToolPolicy('browser_action', { action: 'list_storage_keys' }).requiresConfirmation, false);
	});

	test('bounds the number and size of returned storage values', () => {
		const entries = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`key-${index.toString().padStart(3, '0')}`, 'x'.repeat(5_000)]));
		const sanitized = sanitizeBrowserStorageSnapshot({ origin: 'https://example.test', localStorage: entries, sessionStorage: {} });
		assert.strictEqual(Object.keys(sanitized.localStorage).length, 100);
		assert.strictEqual(sanitized.localStorage['key-000'].length, 4_000);
	});
});
