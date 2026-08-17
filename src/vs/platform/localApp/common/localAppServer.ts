/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';

export const LOCAL_APP_SERVER_CHANNEL = 'localAppServer';

export interface ILocalAppServerService {
	launch(rootPath: string, entryFile: string, token: CancellationToken): Promise<string>;
}

export class LocalAppServerChannel implements IServerChannel<string> {
	constructor(private readonly service: ILocalAppServerService) { }

	listen<T>(_context: string, _event: string): Event<T> {
		throw new Error('Local app server events are not supported.');
	}

	call<T>(_context: string, command: string, args?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		if (command !== 'launch') {
			return Promise.reject(new Error(`Unknown local app server command: ${command}`));
		}
		const values = Array.isArray(args) ? args : [];
		const rootPath = values[0];
		const entryFile = values[1];
		if (typeof rootPath !== 'string' || typeof entryFile !== 'string') {
			return Promise.reject(new Error('Invalid local app server request.'));
		}
		return this.service.launch(rootPath, entryFile, cancellationToken ?? CancellationToken.None) as Promise<T>;
	}
}

export class LocalAppServerChannelClient implements ILocalAppServerService {
	constructor(private readonly channel: IChannel) { }

	launch(rootPath: string, entryFile: string, token: CancellationToken): Promise<string> {
		return this.channel.call<string>('launch', [rootPath, entryFile], token);
	}
}
