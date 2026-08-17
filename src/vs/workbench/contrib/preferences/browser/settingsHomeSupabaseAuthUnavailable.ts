/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { ISettingsHomeSupabaseAuth, ISupabaseAccount } from './settingsHomeSupabaseAuth.js';

/** Browser fallback. Native Supabase authentication is registered by desktop entry points. */
export class SettingsHomeSupabaseAuthUnavailable implements ISettingsHomeSupabaseAuth {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeAccount = Event.None;
	readonly onDidFinishRestore = Event.None;
	readonly onDidFailAuth = Event.None;
	readonly onDidAuthenticate = Event.None;
	readonly isRestoreComplete = true;
	readonly canContinueOffline = true;
	readonly isOfflineMode = true;

	initialize(): void { }
	getAccount(): ISupabaseAccount | undefined { return undefined; }
	continueOffline(): void { }
	signOut(): Promise<void> { return Promise.resolve(); }
	signInWithGoogle(): Promise<void> { return Promise.reject(this.desktopOnlyError()); }
	signInWithPassword(_email: string, _password: string): Promise<void> { return Promise.reject(this.desktopOnlyError()); }

	private desktopOnlyError(): Error {
		return new Error(localize('appica.desktopAuthenticationRequired', 'Authentication is available in the desktop application.'));
	}
}
