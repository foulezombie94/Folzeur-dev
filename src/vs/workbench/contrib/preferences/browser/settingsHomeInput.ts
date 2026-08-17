/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import * as nls from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const settingsHomeIcon = registerIcon('settings-home-label-icon', Codicon.settingsGear, nls.localize('settingsHomeLabelIcon', 'Icon of the settings home editor label.'));

export class SettingsHomeInput extends EditorInput {

	static readonly ID = 'workbench.input.settingsHome';

	readonly resource = URI.from({ scheme: Schemas.vscodeSettings, path: 'settings-home' });

	override get typeId(): string {
		return SettingsHomeInput.ID;
	}

	override getName(): string {
		return nls.localize('settingsHomeInputName', "Settings");
	}

	override getIcon(): ThemeIcon {
		return settingsHomeIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof SettingsHomeInput;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
