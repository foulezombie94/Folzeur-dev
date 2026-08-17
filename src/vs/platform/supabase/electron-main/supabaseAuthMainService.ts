/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';
import { createClient, type AuthChangeEvent, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IEncryptionMainService } from '../../encryption/common/encryptionService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IStateService } from '../../state/node/state.js';
import { IURLHandler, IURLService } from '../../url/common/url.js';
import { ISupabaseAuthAccount, ISupabaseAuthMainService, ISupabaseAuthState, ISupabaseOAuthSignIn, ISupabaseSessionTokens, SupabaseOAuthProvider } from '../common/supabaseAuth.js';

const AUTH_STORAGE_KEY = 'appica.supabase.auth';
const STATE_KEY_PREFIX = 'appica.supabase.auth.storage.';
const MAX_AUTH_CODE_LENGTH = 4096;
const MAX_TOKEN_LENGTH = 65_536;
const PKCE_FLOW_ID_PATTERN = /^[a-f0-9]{32}$/i;

class EncryptedStateStorage {
	private readonly memory = new Map<string, string>();
	private readonly encryptionAvailable: Promise<boolean>;

	constructor(
		private readonly encryptionService: IEncryptionMainService,
		private readonly stateService: IStateService,
		private readonly logService: ILogService,
	) {
		this.encryptionAvailable = this.resolveEncryptionAvailability();
	}

	async getItem(key: string): Promise<string | null> {
		if (this.memory.has(key)) {
			return this.memory.get(key) ?? null;
		}

		if (!await this.encryptionAvailable) {
			return null;
		}

		const stateKey = this.toStateKey(key);
		const encryptedValue = this.stateService.getItem<string>(stateKey);
		if (!encryptedValue) {
			return null;
		}

		try {
			const value = await this.encryptionService.decrypt(encryptedValue);
			this.memory.set(key, value);
			return value;
		} catch (error) {
			this.stateService.removeItem(stateKey);
			this.logService.warn(`[Appica Auth] Ignoring an unreadable encrypted session value: ${toErrorMessage(error, false)}`);
			return null;
		}
	}

	async setItem(key: string, value: string): Promise<void> {
		this.memory.set(key, value);
		if (!await this.encryptionAvailable) {
			return;
		}

		try {
			const encryptedValue = await this.encryptionService.encrypt(value);
			if (this.memory.get(key) === value) {
				this.stateService.setItem(this.toStateKey(key), encryptedValue);
			}
		} catch (error) {
			this.logService.warn(`[Appica Auth] Session persistence failed; using memory-only storage: ${toErrorMessage(error, false)}`);
		}
	}

	async removeItem(key: string): Promise<void> {
		this.memory.delete(key);
		this.stateService.removeItem(this.toStateKey(key));
	}

	private async resolveEncryptionAvailability(): Promise<boolean> {
		try {
			const available = await this.encryptionService.isEncryptionAvailable();
			if (!available) {
				this.logService.warn('[Appica Auth] OS encryption is unavailable; Supabase sessions will remain memory-only.');
			}
			return available;
		} catch (error) {
			this.logService.warn(`[Appica Auth] Could not initialize OS encryption; Supabase sessions will remain memory-only: ${toErrorMessage(error, false)}`);
			return false;
		}
	}

	private toStateKey(key: string): string {
		return `${STATE_KEY_PREFIX}${encodeURIComponent(key)}`;
	}
}

async function electronFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const resource = input instanceof URL ? input.toString() : input;
	return net.fetch(resource, init);
}

export class SupabaseAuthMainService extends Disposable implements ISupabaseAuthMainService, IURLHandler {
	declare readonly _serviceBrand: undefined;

	private readonly client: SupabaseClient | undefined;
	private readonly initialization: Promise<void>;
	private pendingOAuthFlowId: string | undefined;
	private authState: ISupabaseAuthState = { status: 'signedOut' };
	private readonly _onDidChangeAuthState = this._register(new Emitter<ISupabaseAuthState>());
	private readonly _onDidFailAuthentication = this._register(new Emitter<string>());
	readonly onDidChangeAuthState = this._onDidChangeAuthState.event;
	readonly onDidFailAuthentication = this._onDidFailAuthentication.event;

	constructor(
		@IEncryptionMainService encryptionService: IEncryptionMainService,
		@IStateService stateService: IStateService,
		@IProductService private readonly productService: IProductService,
		@IURLService urlService: IURLService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(urlService.registerHandler(this));

		const config = productService.appica;
		if (!config?.supabaseUrl || !config.supabasePublishableKey) {
			this.initialization = Promise.resolve();
			return;
		}

		let supabaseUrl: URL;
		try {
			supabaseUrl = new URL(config.supabaseUrl);
		} catch {
			this.logService.error('[Appica Auth] Invalid Supabase URL in product configuration.');
			this.initialization = Promise.resolve();
			return;
		}

		if (supabaseUrl.protocol !== 'https:') {
			this.logService.error('[Appica Auth] Supabase must use HTTPS in production.');
			this.initialization = Promise.resolve();
			return;
		}

		const storage = new EncryptedStateStorage(encryptionService, stateService, logService);
		this.client = createClient(supabaseUrl.toString(), config.supabasePublishableKey, {
			auth: {
				autoRefreshToken: true,
				detectSessionInUrl: false,
				flowType: 'pkce',
				persistSession: true,
				skipAutoInitialize: true,
				storage,
				storageKey: AUTH_STORAGE_KEY,
			},
			global: { fetch: electronFetch },
		});

		const subscription = this.client.auth.onAuthStateChange((event, session) => this.handleAuthStateChange(event, session)).data.subscription;
		this._register({ dispose: () => subscription.unsubscribe() });
		this._register({ dispose: () => { void this.client?.auth.dispose(); } });
		this.initialization = this.initializeClient();
	}

	async getAuthState(): Promise<ISupabaseAuthState> {
		await this.initialization;
		this.requireClient();
		return this.cloneState(this.authState);
	}

	async beginOAuthSignIn(provider: SupabaseOAuthProvider): Promise<ISupabaseOAuthSignIn> {
		await this.initialization;
		const client = this.requireClient();
		if (provider !== 'google') {
			throw this.authenticationError(localize('appica.unsupportedOAuthProvider', 'This authentication provider is not supported.'));
		}

		try {
			const { data, error } = await client.auth.signInWithOAuth({
				provider,
				options: {
					redirectTo: this.callbackUri().toString(),
					skipBrowserRedirect: true,
				},
			});
			if (error || !data.url) {
				throw error ?? new Error(localize('appica.oauthFailed', 'Google authentication failed or was cancelled.'));
			}

			const authUrl = new URL(data.url);
			const configuredOrigin = new URL(this.productService.appica!.supabaseUrl).origin;
			if (authUrl.protocol !== 'https:' || authUrl.origin !== configuredOrigin) {
				throw new Error(localize('appica.invalidOAuthUrl', 'The authentication service returned an invalid URL.'));
			}

			this.pendingOAuthFlowId = data.flowId ?? undefined;
			return { url: authUrl.toString(), flowId: this.pendingOAuthFlowId };
		} catch (error) {
			throw this.authenticationError(error);
		}
	}

	async handleURL(uri: URI): Promise<boolean> {
		const callback = this.callbackUri();
		if (uri.scheme !== callback.scheme || uri.authority !== callback.authority || uri.path !== callback.path) {
			return false;
		}

		if (uri.fragment) {
			this.pendingOAuthFlowId = undefined;
			this.fireAuthenticationFailure(localize('appica.invalidOAuthCallback', 'The authentication callback is invalid or expired.'));
			return true;
		}

		const query = new URLSearchParams(uri.query);
		const callbackError = query.get('error_description') ?? query.get('error');
		if (callbackError) {
			this.pendingOAuthFlowId = undefined;
			this.fireAuthenticationFailure(callbackError.slice(0, 1024));
			return true;
		}

		const code = query.get('code');
		if (!code) {
			this.pendingOAuthFlowId = undefined;
			this.fireAuthenticationFailure(localize('appica.invalidOAuthCallback', 'The authentication callback is invalid or expired.'));
			return true;
		}

		const callbackFlowId = query.get('sb_flow_id');
		const flowId = callbackFlowId && PKCE_FLOW_ID_PATTERN.test(callbackFlowId) ? callbackFlowId : this.pendingOAuthFlowId;
		try {
			await this.completeOAuthSignIn(code, flowId);
		} catch {
			// The authentication method already reported a sanitized failure.
		}
		this.pendingOAuthFlowId = undefined;
		return true;
	}

	private async completeOAuthSignIn(code: string, flowId?: string): Promise<ISupabaseAuthState> {
		await this.initialization;
		const client = this.requireClient();
		if (!code || code.length > MAX_AUTH_CODE_LENGTH) {
			throw this.authenticationError(localize('appica.invalidOAuthCallback', 'The authentication callback is invalid or expired.'));
		}
		if (flowId && !PKCE_FLOW_ID_PATTERN.test(flowId)) {
			throw this.authenticationError(localize('appica.invalidOAuthCallback', 'The authentication callback is invalid or expired.'));
		}

		try {
			const { data, error } = await client.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
			if (error || !data.session) {
				throw error ?? new Error(localize('appica.oauthExchangeFailed', 'The authentication session could not be created.'));
			}
			return this.setAuthenticatedSession(data.session);
		} catch (error) {
			throw this.authenticationError(error);
		}
	}

	async signInWithPassword(email: string, password: string): Promise<ISupabaseAuthState> {
		await this.initialization;
		const client = this.requireClient();
		const normalizedEmail = email.trim();
		if (!normalizedEmail || !password) {
			throw this.authenticationError(localize('appica.credentialsRequired', 'Email and password are required.'));
		}

		try {
			const { data, error } = await client.auth.signInWithPassword({ email: normalizedEmail, password });
			if (error || !data.session) {
				throw error ?? new Error(localize('appica.passwordSignInFailed', 'Email authentication failed.'));
			}
			return this.setAuthenticatedSession(data.session);
		} catch (error) {
			throw this.authenticationError(error);
		}
	}

	async migrateSession(tokens: ISupabaseSessionTokens): Promise<ISupabaseAuthState> {
		await this.initialization;
		const client = this.requireClient();
		if (!tokens.accessToken || !tokens.refreshToken || tokens.accessToken.length > MAX_TOKEN_LENGTH || tokens.refreshToken.length > MAX_TOKEN_LENGTH) {
			throw this.authenticationError(localize('appica.invalidStoredSession', 'The stored authentication session is invalid.'));
		}

		try {
			const { data, error } = await client.auth.setSession({
				access_token: tokens.accessToken,
				refresh_token: tokens.refreshToken,
			});
			if (error || !data.session) {
				throw error ?? new Error(localize('appica.sessionMigrationFailed', 'The stored authentication session could not be restored.'));
			}
			return await this.verifySession(data.session);
		} catch (error) {
			throw this.authenticationError(error);
		}
	}

	async signOut(): Promise<void> {
		await this.initialization;
		const client = this.requireClient();
		const { error } = await client.auth.signOut({ scope: 'local' });
		if (error) {
			throw this.authenticationError(error);
		}
		this.pendingOAuthFlowId = undefined;
		this.setState({ status: 'signedOut' });
	}

	private async initializeClient(): Promise<void> {
		const client = this.client;
		if (!client) {
			return;
		}

		try {
			const { error: initializeError } = await client.auth.initialize();
			if (initializeError) {
				this.fireAuthenticationFailure(initializeError);
			}

			const { data, error } = await client.auth.getSession();
			if (error) {
				throw error;
			}
			if (data.session) {
				await this.verifySession(data.session);
			} else {
				this.setState({ status: 'signedOut' });
			}
			await client.auth.startAutoRefresh();
		} catch (error) {
			this.fireAuthenticationFailure(error);
		}
	}

	private async verifySession(session: Session): Promise<ISupabaseAuthState> {
		const client = this.requireClient();
		const { data, error } = await client.auth.getUser(session.access_token);
		if (!error && data.user) {
			return this.setState(this.createState('authenticated', data.user));
		}

		if (error?.status === 401 || error?.status === 403) {
			await client.auth.signOut({ scope: 'local' });
			return this.setState({ status: 'signedOut' });
		}

		if (error) {
			this.fireAuthenticationFailure(error);
		}
		return this.setState(this.createState('offline', session.user));
	}

	private async handleAuthStateChange(event: AuthChangeEvent, session: Session | null): Promise<void> {
		if (event === 'INITIAL_SESSION') {
			return;
		}
		if (event === 'SIGNED_OUT' || !session) {
			this.setState({ status: 'signedOut' });
			return;
		}

		this.setAuthenticatedSession(session);
	}

	private setAuthenticatedSession(session: Session): ISupabaseAuthState {
		return this.setState(this.createState('authenticated', session.user));
	}

	private createState(status: 'authenticated' | 'offline', user: User): ISupabaseAuthState {
		const metadata = user.user_metadata;
		const fullName = this.readMetadataString(metadata, 'full_name');
		const name = this.readMetadataString(metadata, 'name');
		const avatarUrl = this.readMetadataString(metadata, 'avatar_url');
		const email = user.email ?? '';
		const account: ISupabaseAuthAccount = {
			email,
			name: fullName ?? name ?? (email || localize('appica.account', 'Account')),
			avatarUrl,
		};
		return { status, account };
	}

	private readMetadataString(metadata: User['user_metadata'], key: string): string | undefined {
		const value: unknown = metadata?.[key];
		return typeof value === 'string' && value.length > 0 ? value : undefined;
	}

	private setState(state: ISupabaseAuthState): ISupabaseAuthState {
		const next = this.cloneState(state);
		if (this.authState.status === next.status && this.authState.account?.email === next.account?.email && this.authState.account?.name === next.account?.name && this.authState.account?.avatarUrl === next.account?.avatarUrl) {
			return this.cloneState(this.authState);
		}
		this.authState = next;
		this._onDidChangeAuthState.fire(this.cloneState(next));
		return this.cloneState(next);
	}

	private cloneState(state: ISupabaseAuthState): ISupabaseAuthState {
		return state.account ? { status: state.status, account: { ...state.account } } : { status: state.status };
	}

	private callbackUri(): URI {
		return URI.from({ scheme: this.productService.urlProtocol, authority: 'auth', path: '/callback' });
	}

	private requireClient(): SupabaseClient {
		if (!this.client) {
			throw this.authenticationError(localize('appica.supabaseConfigurationMissing', 'Appica Supabase configuration is missing or invalid.'));
		}
		return this.client;
	}

	private authenticationError(error: unknown): Error {
		const message = typeof error === 'string' ? error : toErrorMessage(error, false);
		this.fireAuthenticationFailure(message);
		return new Error(message);
	}

	private fireAuthenticationFailure(error: unknown): void {
		const message = typeof error === 'string' ? error : toErrorMessage(error, false);
		this.logService.warn(`[Appica Auth] ${message}`);
		this._onDidFailAuthentication.fire(message);
	}
}
