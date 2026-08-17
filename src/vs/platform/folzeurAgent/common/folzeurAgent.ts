/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IFolzeurAgentService = createDecorator<IFolzeurAgentService>('folzeurAgentService');
export const folzeurAgentChannelName = 'folzeurAgent';

export interface IFolzeurAgentEvent {
	readonly requestId: string;
	readonly kind: 'started' | 'progress' | 'result' | 'error' | 'exited';
	readonly data?: string;
}

export interface IFolzeurAgentService {
	readonly _serviceBrand: undefined;
	readonly isSupported: boolean;
	readonly onEvent: Event<IFolzeurAgentEvent>;
	start(options?: { readonly workspacePath?: string }): Promise<void>;
	request(method: string, params?: Record<string, unknown>): Promise<string>;
	stop(): Promise<void>;
}
