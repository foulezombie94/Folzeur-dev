/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { renderAppicaButton, renderAppicaLoader } from './settingsHomeAppica.js';

export interface ISupabaseAccount { readonly email: string; readonly name: string; readonly avatarUrl?: string; }

export interface ISettingsHomeSupabaseAuth {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAccount: import('../../../../base/common/event.js').Event<ISupabaseAccount | undefined>;
	readonly onDidFinishRestore: import('../../../../base/common/event.js').Event<void>;
	readonly onDidFailAuth: import('../../../../base/common/event.js').Event<string>;
	readonly onDidAuthenticate: import('../../../../base/common/event.js').Event<void>;
	initialize(): void;
	readonly isRestoreComplete: boolean;
	readonly canContinueOffline: boolean;
	readonly isOfflineMode: boolean;
	getAccount(): ISupabaseAccount | undefined;
	continueOffline(): void;
	signInWithGoogle(): Promise<void>;
	signInWithPassword(email: string, password: string): Promise<void>;
	signOut(): Promise<void>;
}

export const ISettingsHomeSupabaseAuth = createDecorator<ISettingsHomeSupabaseAuth>('settingsHomeSupabaseAuth');

/** Keeps the existing sign-in gate UI; authentication itself is implemented by Supabase JS. */
export class SettingsHomeAuthGateContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'appica.authGate';
	private gate: HTMLElement | undefined;
	private readonly buttons = this._register(new DisposableStore());

	constructor(
		@ISettingsHomeSupabaseAuth private readonly authService: ISettingsHomeSupabaseAuth,
	) {
		super();
		document.body?.classList.add('appica-auth-pending');
		this._register(this.authService.onDidFinishRestore(() => this.update()));
		this._register(this.authService.onDidChangeAccount(() => this.update()));
		this._register(this.authService.onDidFailAuth(message => this.showError(message)));
		authService.initialize();
		if (this.authService.isRestoreComplete) { this.update(); }
	}

	private update(): void {
		if (!this.authService.isRestoreComplete) { return; }
		if (this.authService.getAccount() || this.authService.isOfflineMode) { this.hide(); } else { this.show(); }
	}

	private show(): void {
		if (this.gate || !document.body) { return; }
		document.body.classList.add('appica-auth-active');
		this.gate = append(document.body, $('.appica-auth-gate', { role: 'dialog', 'aria-modal': 'true' }));
		const panel = append(this.gate, $('.appica-auth-gate-panel'));
		append(panel, $('div.appica-auth-gate-brand', undefined, 'A'));
		append(panel, $('h1', undefined, localize('appica.welcomeTitle', 'Welcome to Appica')));
		append(panel, $('p', undefined, localize('appica.signInDescription', 'Connect to continue to your workspace, agents and tools.')));
		const actions = append(panel, $('.appica-auth-gate-actions'));
		const signIn = append(actions, $('.appica-auth-gate-action-host'));
		const signUp = append(actions, $('.appica-auth-gate-action-host'));
		const offline = append(panel, $('.appica-auth-gate-offline-host'));
		const loading = append(panel, $('.appica-auth-gate-loading'));
		const loaderHost = append(loading, $('.appica-auth-gate-loader'));
		const status = append(panel, $('p.appica-auth-gate-status', { role: 'status', 'aria-live': 'polite' }));
		loading.hidden = true;
		const start = () => {
			actions.hidden = true;
			loading.hidden = false;
			status.textContent = localize('appica.openingGoogle', 'Opening Google…');
			const loader = renderAppicaLoader(loaderHost);
			void this.authService.signInWithGoogle().catch(error => { loader.dispose(); loading.hidden = true; actions.hidden = false; this.showError(error instanceof Error ? error.message : String(error)); });
		};
		this.buttons.add(renderAppicaButton(signIn, localize('appica.signIn', 'Sign in'), start, { className: 'appica-auth-gate-action appica-auth-gate-action-primary', size: 'lg' }));
		this.buttons.add(renderAppicaButton(signUp, localize('appica.signUp', 'Sign up'), start, { className: 'appica-auth-gate-action appica-auth-gate-action-secondary', size: 'lg' }));
		if (this.authService.canContinueOffline) { this.buttons.add(renderAppicaButton(offline, localize('appica.continueOffline', 'Continue in local mode'), () => this.authService.continueOffline(), { className: 'appica-auth-gate-action appica-auth-gate-action-secondary', size: 'sm' })); }
		document.body.classList.remove('appica-auth-pending');
	}

	private showError(message: string): void {
		const status = this.gate?.querySelector<HTMLElement>('.appica-auth-gate-status');
		if (status) { status.textContent = message; status.classList.add('appica-auth-error'); }
	}
	private hide(): void {
		const wasVisible = !!this.gate;
		this.buttons.clear();
		this.gate?.remove();
		this.gate = undefined;
		document.body.classList.remove('appica-auth-active', 'appica-auth-pending');
		if (!wasVisible) { return; }
	}
}

/** Handles application layout after authentication without coupling the login UI to navigation. */
export class SettingsHomePostAuthLayoutContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'appica.postAuthLayout';
	constructor(
		@ISettingsHomeSupabaseAuth authService: ISettingsHomeSupabaseAuth,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this._register(authService.onDidAuthenticate(() => {
			this.layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
			this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
			this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			void this.commandService.executeCommand('workbench.action.chat.open');
		}));
	}
}
