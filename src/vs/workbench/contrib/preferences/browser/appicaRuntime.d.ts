/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IAppicaRuntimeButtonOptions {
	readonly variant?: string;
	readonly size?: string;
	readonly className?: string;
	readonly ariaLabel?: string;
}

export function mountAppicaButton(container: HTMLElement, label: string, onClick: ((event: MouseEvent) => void) | undefined, options?: IAppicaRuntimeButtonOptions): () => void;
export function mountAppicaInput(container: HTMLElement, value: string, placeholder: string, ariaLabel: string, onChange: (value: string) => void): () => void;
export function mountAppicaSettingsSpark(container: HTMLElement): () => void;
export function mountAppicaLoader(container: HTMLElement): () => void;
export function mountAppicaAccountMenu(container: HTMLElement, account: { readonly name: string; readonly email?: string }, onAction?: (action: string) => void): () => void;
