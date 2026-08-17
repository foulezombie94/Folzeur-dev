/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { ISupabaseAuthService, SUPABASE_AUTH_CHANNEL_NAME } from '../common/supabaseAuth.js';

registerMainProcessRemoteService(ISupabaseAuthService, SUPABASE_AUTH_CHANNEL_NAME);
