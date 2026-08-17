/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ErrorNoTelemetry } from '../../../base/common/errors.js';
import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ISupabaseAuthMainService, ISupabaseSessionTokens } from './supabaseAuth.js';

export class SupabaseAuthChannel implements IServerChannel<string> {
	constructor(private readonly service: ISupabaseAuthMainService) { }

	listen<T>(_context: string, event: string): Event<T> {
		switch (event) {
			case 'onDidChangeAuthState': return this.service.onDidChangeAuthState as Event<T>;
			case 'onDidFailAuthentication': return this.service.onDidFailAuthentication as Event<T>;
		}
		throw new ErrorNoTelemetry(`Event not found: ${event}`);
	}

	call<T>(_context: string, command: string, args?: unknown[]): Promise<T> {
		switch (command) {
			case 'getAuthState':
				this.assertArgumentCount(command, args, 0);
				return this.service.getAuthState() as Promise<T>;
			case 'beginOAuthSignIn': {
				this.assertArgumentCount(command, args, 1);
				if (args![0] !== 'google') {
					throw new ErrorNoTelemetry('Invalid OAuth provider.');
				}
				return this.service.beginOAuthSignIn('google') as Promise<T>;
			}
			case 'signInWithPassword': {
				this.assertArgumentCount(command, args, 2);
				if (typeof args![0] !== 'string' || typeof args![1] !== 'string') {
					throw new ErrorNoTelemetry('Invalid password authentication arguments.');
				}
				return this.service.signInWithPassword(args![0], args![1]) as Promise<T>;
			}
			case 'migrateSession': {
				this.assertArgumentCount(command, args, 1);
				const tokens = args![0] as Partial<ISupabaseSessionTokens> | undefined;
				if (!tokens || typeof tokens.accessToken !== 'string' || typeof tokens.refreshToken !== 'string') {
					throw new ErrorNoTelemetry('Invalid session migration arguments.');
				}
				return this.service.migrateSession({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }) as Promise<T>;
			}
			case 'signOut':
				this.assertArgumentCount(command, args, 0);
				return this.service.signOut() as Promise<T>;
		}
		throw new ErrorNoTelemetry(`Call not found: ${command}`);
	}

	private assertArgumentCount(command: string, args: unknown[] | undefined, count: number): void {
		if ((args?.length ?? 0) !== count) {
			throw new ErrorNoTelemetry(`Invalid argument count for ${command}.`);
		}
	}
}
