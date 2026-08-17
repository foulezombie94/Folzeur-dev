/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { AbstractCustomView } from '../../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';

export const SETTINGS_CUSTOM_VIEW_ID = 'sessions.customView.settings';

export class SettingsCustomView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('settingsTitle', "Paramètres"));
	override readonly description: IObservable<string | undefined> = constObservable(
		localize('settingsDescription', "Gérez la configuration, l'apparence et les options de votre environnement."));

	private container: HTMLElement | undefined;

	constructor(
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		this.container = container;
		container.classList.add('appica-settings-full-page');
		container.style.padding = '24px 32px';
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.gap = '20px';
		container.style.height = '100%';
		container.style.boxSizing = 'border-box';
		container.style.overflowY = 'auto';

		// Clean Top Back Bar
		const topBar = append(container, $('.appica-settings-back-bar'));
		topBar.style.display = 'flex';
		topBar.style.alignItems = 'center';
		topBar.style.justifyContent = 'space-between';
		topBar.style.paddingBottom = '16px';
		topBar.style.borderBottom = '1px solid var(--vscode-widget-border, rgba(255,255,255,0.1))';

		const backBtn = append(topBar, $('button.appica-settings-back-btn'));
		backBtn.style.display = 'inline-flex';
		backBtn.style.alignItems = 'center';
		backBtn.style.gap = '8px';
		backBtn.style.padding = '8px 16px';
		backBtn.style.borderRadius = '6px';
		backBtn.style.background = 'var(--vscode-button-secondaryBackground, #2d2d2d)';
		backBtn.style.color = 'var(--vscode-button-secondaryForeground, #ffffff)';
		backBtn.style.border = 'none';
		backBtn.style.cursor = 'pointer';
		backBtn.style.fontWeight = '600';
		backBtn.style.fontSize = '13px';
		backBtn.innerHTML = '<span class="codicon codicon-arrow-left"></span> Retour';

		this._register(addDisposableListener(backBtn, 'click', () => {
			this.customViewService.hideCustomView();
		}));

		const advancedSettingsBtn = append(topBar, $('button.appica-settings-advanced-btn'));
		advancedSettingsBtn.style.display = 'inline-flex';
		advancedSettingsBtn.style.alignItems = 'center';
		advancedSettingsBtn.style.gap = '6px';
		advancedSettingsBtn.style.padding = '8px 16px';
		advancedSettingsBtn.style.borderRadius = '6px';
		advancedSettingsBtn.style.background = 'var(--vscode-button-background, #0e639c)';
		advancedSettingsBtn.style.color = 'var(--vscode-button-foreground, #ffffff)';
		advancedSettingsBtn.style.border = 'none';
		advancedSettingsBtn.style.cursor = 'pointer';
		advancedSettingsBtn.style.fontSize = '13px';
		advancedSettingsBtn.innerHTML = '<span class="codicon codicon-settings-gear"></span> Éditeur Avancé';

		this._register(addDisposableListener(advancedSettingsBtn, 'click', () => {
			this.commandService.executeCommand('workbench.action.openSettings').catch(() => {});
		}));

		// Settings Content Body
		const body = append(container, $('.appica-settings-body'));
		body.style.display = 'flex';
		body.style.flexDirection = 'column';
		body.style.gap = '24px';
		body.style.maxWidth = '800px';
		body.style.width = '100%';

		// Search Input Box
		const searchBox = append(body, $('.appica-settings-search'));
		searchBox.style.display = 'flex';
		searchBox.style.alignItems = 'center';
		searchBox.style.gap = '10px';
		searchBox.style.padding = '10px 14px';
		searchBox.style.borderRadius = '8px';
		searchBox.style.background = 'var(--vscode-input-background, #1e1e1e)';
		searchBox.style.border = '1px solid var(--vscode-input-border, #3c3c3c)';

		const searchIcon = append(searchBox, $('span.codicon.codicon-search'));
		searchIcon.style.opacity = '0.7';

		const searchInput = append(searchBox, $('input.appica-settings-search-input')) as HTMLInputElement;
		searchInput.placeholder = localize('searchPlaceholder', "Rechercher dans les paramètres...");
		searchInput.style.background = 'transparent';
		searchInput.style.border = 'none';
		searchInput.style.outline = 'none';
		searchInput.style.color = 'var(--vscode-input-foreground, #cccccc)';
		searchInput.style.width = '100%';
		searchInput.style.fontSize = '14px';

		this._register(addDisposableListener(searchInput, 'keydown', (e) => {
			if (e.key === 'Enter' && searchInput.value.trim()) {
				this.commandService.executeCommand('workbench.action.openSettings', searchInput.value.trim()).catch(() => {});
			}
		}));

		// Sections
		const sections = [
			{
				title: "Général & Environnement",
				icon: "codicon-settings",
				desc: "Options d'affichage, thème et fenêtres d'exécution",
				action: () => this.commandService.executeCommand('workbench.action.openSettings', 'workbench')
			},
			{
				title: "IA & Agents",
				icon: "codicon-robot",
				desc: "Configuration des modèles, clés d'API et comportements des agents",
				action: () => this.commandService.executeCommand('workbench.action.openSettings', 'agent')
			},
			{
				title: "Clavier & Raccourcis",
				icon: "codicon-keyboard",
				desc: "Consultez, recherchez et personnalisez l'ensemble des raccourcis clavier de VS Code",
				action: () => this.commandService.executeCommand('workbench.action.openSettings', 'clavier')
			},
			{
				title: "Éditeur & Raccourcis",
				icon: "codicon-code",
				desc: "Taille de police, indentation, autocomplétion et raccourcis clavier",
				action: () => this.commandService.executeCommand('workbench.action.openSettings', 'editor')
			},
			{
				title: "Compte & Authentification",
				icon: "codicon-account",
				desc: "Gestion de votre session et préférences de connexion",
				action: () => this.commandService.executeCommand('workbench.action.openSettings', 'auth')
			}
		];

		const grid = append(body, $('.appica-settings-grid'));
		grid.style.display = 'grid';
		grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(360px, 1fr))';
		grid.style.gap = '16px';

		for (const sec of sections) {
			const card = append(grid, $('.appica-settings-card'));
			card.style.display = 'flex';
			card.style.flexDirection = 'column';
			card.style.gap = '8px';
			card.style.padding = '16px';
			card.style.borderRadius = '8px';
			card.style.background = 'var(--vscode-welcomePage-tileBackground, rgba(255,255,255,0.04))';
			card.style.border = '1px solid var(--vscode-welcomePage-tileBorder, rgba(255,255,255,0.08))';
			card.style.cursor = 'pointer';
			card.style.transition = 'background 0.2s';

			const cardHeader = append(card, $('.appica-settings-card-header'));
			cardHeader.style.display = 'flex';
			cardHeader.style.alignItems = 'center';
			cardHeader.style.gap = '10px';

			const iconSpan = append(cardHeader, $(`span.codicon.${sec.icon}`));
			iconSpan.style.fontSize = '18px';
			iconSpan.style.color = 'var(--vscode-textLink-foreground, #ffffff)';

			const titleSpan = append(cardHeader, $('span.appica-settings-card-title', undefined, sec.title));
			titleSpan.style.fontWeight = '600';
			titleSpan.style.fontSize = '14px';

			const descP = append(card, $('p.appica-settings-card-desc', undefined, sec.desc));
			descP.style.margin = '0';
			descP.style.fontSize = '12px';
			descP.style.opacity = '0.7';

			this._register(addDisposableListener(card, 'click', () => {
				sec.action().catch(() => {});
			}));
		}
	}

	layout(width: number, height: number): void {
		if (this.container) {
			this.container.style.width = `${width}px`;
			this.container.style.height = `${height}px`;
		}
	}
}

export class SettingsCustomViewContribution extends Disposable {
	static readonly ID = 'sessions.contrib.settingsCustomView';

	constructor(
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();

		this._register(customViewService.registerCustomView({
			id: SETTINGS_CUSTOM_VIEW_ID,
			ctor: new SyncDescriptor(SettingsCustomView),
		}));
	}
}

registerWorkbenchContribution2(SettingsCustomViewContribution.ID, SettingsCustomViewContribution, WorkbenchPhase.BlockRestore);
