/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { ISharedProcessService } from '../../../../../../platform/ipc/electron-browser/services.js';
import { LOCAL_APP_SERVER_CHANNEL, LocalAppServerChannelClient } from '../../../../../../platform/localApp/common/localAppServer.js';

/**
 * Renderer-side registry for static previews.
 *
 * The actual listener is owned by the Node shared process. Keeping this class
 * as a small registry preserves one stable URL per workspace while avoiding any
 * renderer dependency on `http`, `net` or other Node built-ins.
 */
export class LocalAppServerRegistry extends Disposable {
	private readonly servers = new Map<string, string>();
	private readonly service: LocalAppServerChannelClient;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.service = new LocalAppServerChannelClient(sharedProcessService.getChannel(LOCAL_APP_SERVER_CHANNEL));
	}

	public async launch(root: URI, entryFile: string, token: CancellationToken): Promise<string> {
		const key = root.toString();
		let url = this.servers.get(key);
		if (!url) {
			url = await this.service.launch(root.fsPath, entryFile, token);
			this.servers.set(key, url);
		}
		if (token.isCancellationRequested) {
			throw new Error('Local application launch was cancelled.');
		}
		const opened = await this.openerService.open(url, { openExternal: true, fromWorkspace: true });
		if (!opened) {
			throw new Error(`The browser could not open ${url}`);
		}
		return url;
	}

	public override dispose(): void {
		// The shared process owns the sockets and closes them with its lifecycle.
		// Do not stop a server merely because a renderer-side task completed.
		this.servers.clear();
		super.dispose();
	}
}
