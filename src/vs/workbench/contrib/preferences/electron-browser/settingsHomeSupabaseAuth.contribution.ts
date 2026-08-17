/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../../platform/supabase/electron-browser/supabaseAuthService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ISettingsHomeSupabaseAuth, SettingsHomeAuthGateContribution, SettingsHomePostAuthLayoutContribution } from '../browser/settingsHomeSupabaseAuth.js';
import { SettingsHomeSupabaseAuthService } from './settingsHomeSupabaseAuthService.js';

registerSingleton(ISettingsHomeSupabaseAuth, SettingsHomeSupabaseAuthService, InstantiationType.Eager);
registerWorkbenchContribution2(SettingsHomeAuthGateContribution.ID, SettingsHomeAuthGateContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(SettingsHomePostAuthLayoutContribution.ID, SettingsHomePostAuthLayoutContribution, WorkbenchPhase.AfterRestored);
