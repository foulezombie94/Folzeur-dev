/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Pure ownership registry that prevents browser pages leaking across conversations. */
export class BrowserPageOwnership {
	private readonly shareable = new Set<string>();
	private readonly ownedBySession = new Map<string, Set<string>>();

	markShareable(pageId: string): boolean {
		const size = this.shareable.size;
		this.shareable.add(pageId);
		return this.shareable.size !== size;
	}

	isShareable(pageId: string): boolean { return this.shareable.has(pageId); }
	shareablePages(): readonly string[] { return [...this.shareable]; }

	claim(sessionId: string, pageId: string): boolean {
		if (!this.shareable.has(pageId)) { return false; }
		let owned = this.ownedBySession.get(sessionId);
		if (!owned) { owned = new Set<string>(); this.ownedBySession.set(sessionId, owned); }
		owned.add(pageId);
		return true;
	}

	ownerCreatedPage(sessionId: string, pageId: string): void {
		this.markShareable(pageId);
		this.claim(sessionId, pageId);
	}

	owns(sessionId: string, pageId: string): boolean { return this.ownedBySession.get(sessionId)?.has(pageId) ?? false; }
	ownedPages(sessionId: string): readonly string[] { return [...(this.ownedBySession.get(sessionId) ?? [])]; }
	releaseOwnedPage(sessionId: string, pageId: string): void { this.ownedBySession.get(sessionId)?.delete(pageId); }
	releaseSession(sessionId: string): void { this.ownedBySession.delete(sessionId); }

	stopSharing(pageId: string): boolean {
		const changed = this.shareable.delete(pageId);
		for (const pages of this.ownedBySession.values()) { pages.delete(pageId); }
		return changed;
	}
}
