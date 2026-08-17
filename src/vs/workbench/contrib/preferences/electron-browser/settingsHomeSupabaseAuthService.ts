/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { ISupabaseAuthService, ISupabaseAuthState, ISupabaseSessionTokens } from '../../../../platform/supabase/common/supabaseAuth.js';
import { ISettingsHomeSupabaseAuth, ISupabaseAccount } from '../browser/settingsHomeSupabaseAuth.js';

const LEGACY_SESSION_SECRET = 'settingsHome.supabase.session';
const SDK_STORAGE_PREFIX = 'settingsHome.supabase.sdk.';
const CACHED_ACCOUNT_SECRET = 'settingsHome.supabase.cachedAccount';
const RESTORE_TIMEOUT = 15_000;

interface ILegacySessionTokens {
	readonly access_token?: unknown;
	readonly refresh_token?: unknown;
}

export class SettingsHomeSupabaseAuthService extends Disposable implements ISettingsHomeSupabaseAuth {
	declare readonly _serviceBrand: undefined;

	private account: ISupabaseAccount | undefined;
	private authenticationPending = false;
	private offlineAvailable = false;
	private offlineMode = false;
	private restoreComplete = false;
	private initialized = false;
	private readonly _onDidChangeAccount = this._register(new Emitter<ISupabaseAccount | undefined>());
	private readonly _onDidFinishRestore = this._register(new Emitter<void>());
	private readonly _onDidFailAuth = this._register(new Emitter<string>());
	private readonly _onDidAuthenticate = this._register(new Emitter<void>());
	readonly onDidChangeAccount: Event<ISupabaseAccount | undefined> = this._onDidChangeAccount.event;
	readonly onDidFinishRestore: Event<void> = this._onDidFinishRestore.event;
	readonly onDidFailAuth: Event<string> = this._onDidFailAuth.event;
	readonly onDidAuthenticate: Event<void> = this._onDidAuthenticate.event;
	get isRestoreComplete(): boolean { return this.restoreComplete; }
	get canContinueOffline(): boolean { return this.offlineAvailable; }
	get isOfflineMode(): boolean { return this.offlineMode; }

	constructor(
		@ISupabaseAuthService private readonly mainService: ISupabaseAuthService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.mainService.onDidChangeAuthState(state => {
			void this.handleStateChange(state).catch(error => this.reportFailure(error));
		}));
		this._register(this.mainService.onDidFailAuthentication(message => {
			this.authenticationPending = false;
			this._onDidFailAuth.fire(message);
		}));
	}

	initialize(): void {
		if (this.initialized) {
			return;
		}
		this.initialized = true;
		void raceTimeout(this.restore().then(() => true), RESTORE_TIMEOUT).then(completed => {
			if (!completed && !this.account) {
				this.logService.warn('[Appica Auth] Session restore timed out; continuing without blocking the workbench.');
			}
		}).finally(() => {
			this.restoreComplete = true;
			this._onDidFinishRestore.fire();
		});
	}

	getAccount(): ISupabaseAccount | undefined {
		return this.account;
	}

	continueOffline(): void {
		if (!this.offlineAvailable) {
			return;
		}
		this.offlineMode = true;
		this._onDidChangeAccount.fire(this.account);
	}

	async signInWithGoogle(): Promise<void> {
		this.authenticationPending = true;
		try {
			const signIn = await this.mainService.beginOAuthSignIn('google');
			const authUri = URI.parse(signIn.url);
			if (authUri.scheme !== 'https') {
				throw new Error(localize('appica.invalidOAuthUrl', 'The authentication service returned an invalid URL.'));
			}
			await this.openerService.open(authUri, { openExternal: true });
		} catch (error) {
			this.authenticationPending = false;
			throw error;
		}
	}

	async signInWithPassword(email: string, password: string): Promise<void> {
		const state = await this.mainService.signInWithPassword(email, password);
		await this.applyState(state);
		this._onDidAuthenticate.fire();
	}

	async signOut(): Promise<void> {
		this.authenticationPending = false;
		await this.mainService.signOut();
		await this.applyState({ status: 'signedOut' });
		await this.clearLegacySession();
	}

	private async restore(): Promise<void> {
		try {
			let state = await this.mainService.getAuthState();
			if (state.status === 'signedOut') {
				state = await this.migrateLegacySession() ?? state;
			}
			await this.applyState(state);
		} catch (error) {
			await this.restoreCachedAccount();
			this.offlineAvailable = !!this.account;
			this.offlineMode = !!this.account;
			this.reportFailure(error);
		}
	}

	private async handleStateChange(state: ISupabaseAuthState): Promise<void> {
		await this.applyState(state);
		if (this.authenticationPending && state.status === 'authenticated') {
			this.authenticationPending = false;
			await this.clearLegacySession();
			this._onDidAuthenticate.fire();
		}
	}

	private async migrateLegacySession(): Promise<ISupabaseAuthState | undefined> {
		for (const secretKey of this.legacySessionKeys()) {
			const raw = await this.secretStorageService.get(secretKey);
			const tokens = this.parseLegacySession(raw);
			if (!tokens) {
				continue;
			}

			try {
				const state = await this.mainService.migrateSession(tokens);
				await this.clearLegacySession();
				return state;
			} catch (error) {
				this.logService.warn(`[Appica Auth] Legacy session migration failed: ${toErrorMessage(error, false)}`);
			}
		}
		return undefined;
	}

	private parseLegacySession(raw: string | undefined): ISupabaseSessionTokens | undefined {
		if (!raw) {
			return undefined;
		}
		try {
			const value: unknown = JSON.parse(raw);
			if (!value || typeof value !== 'object') {
				return undefined;
			}
			const session = value as ILegacySessionTokens;
			if (typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string') {
				return undefined;
			}
			return { accessToken: session.access_token, refreshToken: session.refresh_token };
		} catch {
			return undefined;
		}
	}

	private async applyState(state: ISupabaseAuthState): Promise<void> {
		this.offlineAvailable = state.status === 'offline' && !!state.account;
		this.offlineMode = this.offlineAvailable;
		const account = state.account ? { ...state.account } : undefined;

		if (account) {
			try {
				await this.secretStorageService.set(CACHED_ACCOUNT_SECRET, JSON.stringify(account));
			} catch (error) {
				this.logService.warn(`[Appica Auth] Could not cache the account profile: ${toErrorMessage(error, false)}`);
			}
		} else if (state.status === 'signedOut') {
			try {
				await this.secretStorageService.delete(CACHED_ACCOUNT_SECRET);
			} catch (error) {
				this.logService.warn(`[Appica Auth] Could not remove the cached account profile: ${toErrorMessage(error, false)}`);
			}
		}

		if (this.account?.email === account?.email && this.account?.name === account?.name && this.account?.avatarUrl === account?.avatarUrl) {
			return;
		}
		this.account = account;
		this._onDidChangeAccount.fire(account);
	}

	private async restoreCachedAccount(): Promise<void> {
		try {
			const raw = await this.secretStorageService.get(CACHED_ACCOUNT_SECRET);
			if (!raw) {
				return;
			}
			const value: unknown = JSON.parse(raw);
			if (!value || typeof value !== 'object') {
				return;
			}
			const account = value as Partial<ISupabaseAccount>;
			if (typeof account.email === 'string' && typeof account.name === 'string' && (account.avatarUrl === undefined || typeof account.avatarUrl === 'string')) {
				this.account = { email: account.email, name: account.name, avatarUrl: account.avatarUrl };
				this._onDidChangeAccount.fire(this.account);
			}
		} catch (error) {
			this.logService.warn(`[Appica Auth] Invalid cached account ignored: ${toErrorMessage(error, false)}`);
		}
	}

	private legacySessionKeys(): readonly string[] {
		const config = this.productService.appica;
		if (!config?.supabaseUrl) {
			return [LEGACY_SESSION_SECRET];
		}
		try {
			const projectReference = new URL(config.supabaseUrl).hostname.split('.')[0];
			return [`${SDK_STORAGE_PREFIX}sb-${projectReference}-auth-token`, LEGACY_SESSION_SECRET];
		} catch {
			return [LEGACY_SESSION_SECRET];
		}
	}

	private async clearLegacySession(): Promise<void> {
		await Promise.all(this.legacySessionKeys().map(async key => {
			try {
				await this.secretStorageService.delete(key);
			} catch (error) {
				this.logService.warn(`[Appica Auth] Could not remove a legacy session value: ${toErrorMessage(error, false)}`);
			}
		}));
	}

	private reportFailure(error: unknown): void {
		const message = toErrorMessage(error, false);
		this.logService.warn(`[Appica Auth] ${message}`);
		this._onDidFailAuth.fire(message);
	}
}
