/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getDelayedChannel, IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { folzeurAgentChannelName, IFolzeurAgentService } from '../../../../platform/folzeurAgent/common/folzeurAgent.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';

export class AgentServiceImpl implements IFolzeurAgentService {
	declare readonly _serviceBrand: undefined;
	readonly isSupported = true;
	private channel: IChannel | undefined;
	private proxy: IFolzeurAgentService | undefined;

	constructor(@IUtilityProcessWorkerWorkbenchService private readonly utilityProcessWorkerWorkbenchService: IUtilityProcessWorkerWorkbenchService) { }

	private getProxy(): IFolzeurAgentService {
		if (!this.channel) {
			this.channel = getDelayedChannel((async () => {
				const { client } = await this.utilityProcessWorkerWorkbenchService.createWorker({
					moduleId: 'vs/platform/folzeurAgent/node/folzeurAgentMain',
					type: 'folzeurAgent',
					name: 'folzeur-agent-runtime'
				});
				return client.getChannel(folzeurAgentChannelName);
			})());
		}
		return this.proxy ??= ProxyChannel.toService<IFolzeurAgentService>(this.channel);
	}

	get onEvent() { return this.getProxy().onEvent; }
	start(options?: Parameters<IFolzeurAgentService['start']>[0]) { return this.getProxy().start(options); }
	request(method: string, params?: Record<string, unknown>) { return this.getProxy().request(method, params); }
	stop() { return this.getProxy().stop(); }
}

registerSingleton(IFolzeurAgentService, AgentServiceImpl, InstantiationType.Delayed);
