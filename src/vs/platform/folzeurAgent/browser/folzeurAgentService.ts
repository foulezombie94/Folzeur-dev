/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IFolzeurAgentService } from '../common/folzeurAgent.js';

export class NullFolzeurAgentService implements IFolzeurAgentService {
	declare readonly _serviceBrand: undefined;
	readonly isSupported = false;
	readonly onEvent = Event.None;
	async start(): Promise<void> { }
	async request(): Promise<string> { throw new Error('Folzeur native agent runtime is unavailable in web workbench.'); }
	async stop(): Promise<void> { }
}
