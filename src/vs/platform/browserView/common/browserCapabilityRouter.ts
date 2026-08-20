/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type BrowserCapability = 'web_search' | 'web_fetch' | 'integrated_browser' | 'isolated_verifier';

export interface BrowserRouteRequest {
	readonly purpose: 'discover' | 'read_document' | 'interact' | 'verify_local_ui';
	readonly hasUrl?: boolean;
	readonly requiresAuthentication?: boolean;
	readonly requiresRenderedDom?: boolean;
	readonly ownedLocalUrl?: boolean;
}

/** Deterministic capability selection; callers enforce the selected boundary. */
export function routeBrowserCapability(request: BrowserRouteRequest): BrowserCapability {
	if (request.purpose === 'verify_local_ui') {
		if (!request.ownedLocalUrl) { throw new Error('The isolated verifier requires an owned local application URL.'); }
		return 'isolated_verifier';
	}
	if (request.purpose === 'discover') { return 'web_search'; }
	if (request.purpose === 'interact' || request.requiresAuthentication || request.requiresRenderedDom) { return 'integrated_browser'; }
	if (request.purpose === 'read_document' && request.hasUrl) { return 'web_fetch'; }
	return 'web_search';
}
