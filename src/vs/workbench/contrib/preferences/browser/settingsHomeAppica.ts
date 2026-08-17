/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { mountAppicaAccountMenu, mountAppicaButton, mountAppicaInput, mountAppicaLoader, mountAppicaSettingsSpark } from './appicaRuntime.js';
import './media/appicaRuntime.css';

export interface IAppicaButtonOptions {
	readonly variant?: string;
	readonly size?: string;
	readonly className?: string;
	readonly ariaLabel?: string;
}

/** Mounts actual Appica UI components from the local ESM bundle. */
export function renderAppicaButton(container: HTMLElement, label: string, onClick: (event: MouseEvent) => void, options?: IAppicaButtonOptions): IDisposable {
	return toDisposable(mountAppicaButton(container, label, onClick, options));
}

/** Mounts the Appica input component from the local ESM bundle. */
export function renderAppicaInput(container: HTMLElement, value: string, placeholder: string, ariaLabel: string, onChange: (value: string) => void): IDisposable {
	return toDisposable(mountAppicaInput(container, value, placeholder, ariaLabel, onChange));
}

/** Mounts the actual Appica SettingsSpark React icon from the local ESM bundle. */
export function renderAppicaSettingsSpark(container: HTMLElement): IDisposable {
	return toDisposable(mountAppicaSettingsSpark(container));
}

/** Mounts the Appica loading indicator. */
export function renderAppicaLoader(container: HTMLElement): IDisposable {
	return toDisposable(mountAppicaLoader(container));
}

export function renderAppicaAccountMenu(container: HTMLElement, account: { name: string; email?: string }, onAction: (action: string) => void): IDisposable {
	return toDisposable(mountAppicaAccountMenu(container, account, onAction));
}
