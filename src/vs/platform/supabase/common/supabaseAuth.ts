/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const SUPABASE_AUTH_CHANNEL_NAME = 'supabaseAuth';

export type SupabaseAuthStatus = 'signedOut' | 'authenticated' | 'offline';
export type SupabaseOAuthProvider = 'google';

export interface ISupabaseAuthAccount {
	readonly email: string;
	readonly name: string;
	readonly avatarUrl?: string;
}

export interface ISupabaseAuthState {
	readonly status: SupabaseAuthStatus;
	readonly account?: ISupabaseAuthAccount;
}

export interface ISupabaseOAuthSignIn {
	readonly url: string;
	readonly flowId?: string;
}

export interface ISupabaseSessionTokens {
	readonly accessToken: string;
	readonly refreshToken: string;
}

export const ISupabaseAuthService = createDecorator<ISupabaseAuthService>('supabaseAuthService');

/**
 * Main-process Supabase authentication boundary. Session tokens never cross
 * back into the renderer; only the minimal account projection is returned.
 */
export interface ISupabaseAuthService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAuthState: Event<ISupabaseAuthState>;
	readonly onDidFailAuthentication: Event<string>;

	getAuthState(): Promise<ISupabaseAuthState>;
	beginOAuthSignIn(provider: SupabaseOAuthProvider): Promise<ISupabaseOAuthSignIn>;
	signInWithPassword(email: string, password: string): Promise<ISupabaseAuthState>;
	migrateSession(tokens: ISupabaseSessionTokens): Promise<ISupabaseAuthState>;
	signOut(): Promise<void>;
}

export const ISupabaseAuthMainService = createDecorator<ISupabaseAuthMainService>('supabaseAuthMainService');
export interface ISupabaseAuthMainService extends ISupabaseAuthService { }
