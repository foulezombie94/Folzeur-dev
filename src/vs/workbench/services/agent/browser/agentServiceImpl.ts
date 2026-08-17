/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { NullFolzeurAgentService } from '../../../../platform/folzeurAgent/browser/folzeurAgentService.js';
import { IFolzeurAgentService } from '../../../../platform/folzeurAgent/common/folzeurAgent.js';

registerSingleton(IFolzeurAgentService, NullFolzeurAgentService, InstantiationType.Delayed);
