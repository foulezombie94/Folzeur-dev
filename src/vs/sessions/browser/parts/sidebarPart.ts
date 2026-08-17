/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/sidebar/media/sidebarpart.css';
import './media/sidebarPart.css';
import { IWorkbenchLayoutService, Parts, Position as SideBarPosition } from '../../../workbench/services/layout/browser/layoutService.js';
import { SidebarFocusContext, ActiveViewletContext } from '../../../workbench/common/contextkeys.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { SIDE_BAR_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER, SIDE_BAR_FOREGROUND, SIDE_BAR_DRAG_AND_DROP_BACKGROUND, ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_ACTIVE_BORDER, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER } from '../../../workbench/common/theme.js';
import { agentsPanelForeground } from '../../common/theme.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { AnchorAlignment } from '../../../base/browser/ui/contextview/contextview.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { LayoutPriority } from '../../../base/browser/ui/grid/grid.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../workbench/common/views.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../workbench/browser/parts/paneCompositePart.js';
import { ICompositeTitleLabel } from '../../../workbench/browser/parts/compositePart.js';
import { ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { IPaneCompositeBarOptions } from '../../../workbench/browser/parts/paneCompositeBar.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { Separator } from '../../../base/common/actions.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { Extensions } from '../../../workbench/browser/panecomposite.js';
import { Menus } from '../menus.js';
import { $, addDisposableListener, append, getWindowId, prepend } from '../../../base/browser/dom.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { isFullscreen, onDidChangeFullscreen } from '../../../base/browser/browser.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { hasNativeTitlebar, getTitleBarStyle } from '../../../platform/window/common/window.js';
import { isMacintosh, isNative, isWeb } from '../../../base/common/platform.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { ISettingsHomeSupabaseAuth } from '../../../workbench/contrib/preferences/browser/settingsHomeSupabaseAuth.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { localize } from '../../../nls.js';

export interface IAppicaAccount {
	name?: string;
	email?: string;
}

/** Sessions list minimum width; shared with the docked details panel so both snap closed alike. */
export const SESSIONS_LIST_MINIMUM_WIDTH = isWeb ? 270 : 220;

/**
 * Sidebar part specifically for agent sessions workbench.
 * This is a simplified version of the SidebarPart for agent session contexts.
 */
export class SidebarPart extends AbstractPaneCompositePart {

	static readonly activeViewletSettingsKey = 'workbench.agentsession.sidebar.activeviewletid';
	static readonly pinnedViewContainersKey = 'workbench.agentsession.pinnedViewlets2';
	static readonly placeholderViewContainersKey = 'workbench.agentsession.placeholderViewlets';
	static readonly viewContainersWorkspaceStateKey = 'workbench.agentsession.viewletsWorkspaceState';

	/** Visual margin values - sidebar is flush (no card appearance) */
	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_BOTTOM = 0;
	static readonly MARGIN_LEFT = 0;
	private static readonly FOOTER_ITEM_HEIGHT = 26;
	private static readonly FOOTER_ITEM_GAP = 4;
	private static readonly FOOTER_VERTICAL_PADDING = 6;
	private static readonly FOOTER_BOTTOM_MARGIN = 2;
	private static readonly FOOTER_BORDER_TOP = 1;
	private static readonly DEFAULT_ACCOUNT_HEIGHT = 42;

	private footerContainer: HTMLElement | undefined;
	private sideBarTitleArea: HTMLElement | undefined;
	private footerToolbar: MenuWorkbenchToolBar | undefined;
	private appicaAccountRow: HTMLElement | undefined;
	private readonly appicaAccountMenuDisposable = this._register(new MutableDisposable());
	private activeAccountPopup: { element: HTMLElement; store: DisposableStore } | undefined;
	private readonly appicaNotificationService: INotificationService;
	private previousLayoutDimensions: { width: number; height: number; top: number; left: number } | undefined;
	private _authServiceWithListeners: ISettingsHomeSupabaseAuth | undefined;
	private _isLayoutRunning = false;

	//#region IView

	readonly minimumWidth: number = SESSIONS_LIST_MINIMUM_WIDTH;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	override get snap(): boolean { return true; }

	readonly priority: LayoutPriority = LayoutPriority.Low;

	get preferredWidth(): number | undefined {
		const viewlet = this.getActivePaneComposite();

		if (!viewlet) {
			return undefined;
		}

		const width = viewlet.getOptimalWidth();
		if (typeof width !== 'number') {
			return undefined;
		}

		return Math.max(width, 300);
	}

	//#endregion

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@ISettingsHomeSupabaseAuth private readonly appicaAuthService: ISettingsHomeSupabaseAuth,
	) {
		super(
			Parts.SIDEBAR_PART,
			{ hasTitle: false, trailingSeparator: false, borderWidth: () => 0 },
			SidebarPart.activeViewletSettingsKey,
			ActiveViewletContext.bindTo(contextKeyService),
			SidebarFocusContext.bindTo(contextKeyService),
			'sideBar',
			'viewlet',
			SIDE_BAR_TITLE_FOREGROUND,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.Sidebar,
			Extensions.Viewlets,
			Menus.SidebarTitle,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
			configurationService,
		);
		this.appicaNotificationService = notificationService;
	}

	override dispose(): void {
		this.closeAccountPopup();
		super.dispose();
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		this.createFooter(parent);
	}

	protected override createTitleArea(parent: HTMLElement): HTMLElement | undefined {
		const titleArea = super.createTitleArea(parent);
		this.sideBarTitleArea = titleArea;

		if (titleArea) {
			// Add a drag region so the sidebar title area can be used to move the window,
			// matching the titlebar's drag behavior.
			prepend(titleArea, $('div.titlebar-drag-region'));
		}

		// macOS native: the sidebar spans full height and the traffic lights
		// overlay the top-left corner. Add a fixed-width spacer inside the
		// title area to push content horizontally past the traffic lights.
		if (titleArea && isMacintosh && isNative && !hasNativeTitlebar(this.configurationService, getTitleBarStyle(this.configurationService))) {
			const spacer = $('div.window-controls-container');
			spacer.style.width = '70px';
			spacer.style.height = '100%';
			spacer.style.flexShrink = '0';
			spacer.style.order = '-1'; // match global-actions-left order so DOM order is respected
			prepend(titleArea, spacer);

			// Hide spacer in fullscreen (traffic lights are not shown)
			const updateSpacerVisibility = () => {
				spacer.style.display = isFullscreen(mainWindow) ? 'none' : '';
			};
			updateSpacerVisibility();
			this._register(onDidChangeFullscreen(windowId => {
				if (windowId === getWindowId(mainWindow)) {
					updateSpacerVisibility();
				}
			}));
		}

		return titleArea;
	}

	private createFooter(parent: HTMLElement): void {
		const footer = append(parent, $('.sidebar-footer.sidebar-action-list'));
		this.footerContainer = footer;
		this.appicaAccountRow = append(footer, $('.appica-sidebar-account-row'));
		this.renderAppicaAccount();

		this.footerToolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, footer, Menus.SidebarFooter, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			toolbarOptions: { primaryGroup: () => true },
			telemetrySource: 'sidebarFooter',
		}));

		this._register(this.footerToolbar.onDidChangeMenuItems(() => {
			if (this.previousLayoutDimensions && !this._isLayoutRunning) {
				const { width, height, top, left } = this.previousLayoutDimensions;
				this.layout(width, height, top, left);
			}
		}));
	}

	private renderAppicaAccount(): void {
		this.closeAccountPopup();
		const row = this.appicaAccountRow;
		if (!row) {
			return;
		}
		this.appicaAccountMenuDisposable.clear();
		row.replaceChildren();
		const authService = this.appicaAuthService;
		if (authService && this._authServiceWithListeners !== authService) {
			this._authServiceWithListeners = authService;
			this._register(authService.onDidChangeAccount(() => this.renderAppicaAccount()));
			this._register(authService.onDidFinishRestore(() => this.renderAppicaAccount()));
		}
		const account = authService?.getAccount();
		row.style.display = account ? '' : 'none';

		if (account) {
			const displayName = account.name?.trim() || account.email?.trim() || localize('appica.account', 'Compte');
			const initials = displayName.split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase() || 'A';
			const avatar = append(row, $('.appica-sidebar-account-avatar'));
			avatar.textContent = initials;
			const name = append(row, $('.appica-sidebar-account-name'));
			name.textContent = displayName;

			// Accessibility attributes for trigger button
			row.setAttribute('role', 'button');
			row.setAttribute('aria-haspopup', 'menu');
			row.setAttribute('aria-expanded', this.activeAccountPopup ? 'true' : 'false');
			row.setAttribute('tabindex', '0');

			// Add click & keyboard listeners on the account row to show custom popup menu
			const store = new DisposableStore();
			store.add(addDisposableListener(row, 'click', (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				this.toggleAccountPopupMenu(row, account, initials);
			}));
			store.add(addDisposableListener(row, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					e.stopPropagation();
					this.toggleAccountPopupMenu(row, account, initials);
				}
			}));
			this.appicaAccountMenuDisposable.value = store;
		}

		// Single layout pass at the end
		if (this.previousLayoutDimensions && !this._isLayoutRunning) {
			const { width, height, top, left } = this.previousLayoutDimensions;
			this.layout(width, height, top, left);
		} else {
			this.updateFooterVisibility();
		}
	}

	private closeAccountPopup(restoreFocus = false): void {
		if (this.activeAccountPopup) {
			this.activeAccountPopup.store.dispose();
			this.activeAccountPopup.element.remove();
			this.activeAccountPopup = undefined;
			if (this.appicaAccountRow) {
				this.appicaAccountRow.setAttribute('aria-expanded', 'false');
				if (restoreFocus) {
					this.appicaAccountRow.focus();
				}
			}
		}
	}

	private createMenuItem(
		parent: HTMLElement,
		codiconClass: string,
		label: string,
		options: { disabled?: boolean; mutedText?: string } = {}
	): HTMLElement {
		const item = append(parent, $(`div.appica-custom-account-popup-item${options.disabled ? '.disabled' : ''}`));
		item.setAttribute('role', 'menuitem');
		item.setAttribute('tabindex', options.disabled ? '-1' : '0');
		item.setAttribute('aria-label', options.mutedText ? `${label} ${options.mutedText}` : label);

		const icon = append(item, $(`span.codicon.${codiconClass}`));
		icon.style.marginRight = '8px';

		const labelSpan = append(item, $('span', undefined, label));
		if (options.mutedText) {
			append(labelSpan, $('span.appica-custom-account-popup-muted', undefined, options.mutedText));
		}

		return item;
	}

	private toggleAccountPopupMenu(anchor: HTMLElement, account: IAppicaAccount, initials: string): void {
		if (this.activeAccountPopup) {
			this.closeAccountPopup(true);
			return;
		}

		const store = new DisposableStore();
		const popup = $('div.appica-custom-account-popup');
		popup.setAttribute('role', 'menu');
		popup.setAttribute('aria-label', localize('appica.accountMenu', "Menu compte"));
		popup.tabIndex = -1;

		// Header
		const header = append(popup, $('.appica-custom-account-popup-header'));
		const avatar = append(header, $('.appica-sidebar-account-avatar'));
		avatar.textContent = initials;
		const headerInfo = append(header, $('.appica-custom-account-popup-header-info'));
		const name = append(headerInfo, $('.appica-custom-account-popup-header-name'));
		const displayName = account.name?.trim() || account.email?.trim() || localize('appica.account', 'Compte');
		name.textContent = displayName;

		append(popup, $('.appica-custom-account-popup-divider'));

		// Crédits IA disponibles
		this.createMenuItem(popup, 'codicon-zap', localize('appica.accountQuota', "Crédits IA "), { disabled: true, mutedText: '100%' });

		// IDE (Ouvre la fenêtre d'IDE existante ou en crée une nouvelle)
		const itemIDE = this.createMenuItem(popup, 'codicon-window', localize('appica.accountIDE', "IDE"));
		store.add(addDisposableListener(itemIDE, 'click', (e) => {
			e.stopPropagation();
			this.closeAccountPopup();
			this.commandService.executeCommand('agents.openVSCodeWindow').catch(() => {
				this.commandService.executeCommand('workbench.action.openWindow').catch(() => {});
			});
		}));

		// Paramètres (Ouvre la page complète des Paramètres en 100% plein écran)
		const itemSettings = this.createMenuItem(popup, 'codicon-settings-gear', localize('appica.accountSettings', "Paramètres"));
		store.add(addDisposableListener(itemSettings, 'click', async (e) => {
			e.stopPropagation();
			this.closeAccountPopup();
			try {
				await this.commandService.executeCommand('workbench.action.openSettings');
				(this.layoutService as any).setEditorMaximized?.(true);
			} catch {
				this.appicaNotificationService.error(localize('appica.openSettingsError', 'Échec de l’ouverture des paramètres.'));
			}
		}));

		append(popup, $('.appica-custom-account-popup-divider'));

		// Documentation
		const itemDoc = this.createMenuItem(popup, 'codicon-book', localize('appica.accountDocumentation', "Documentation"));
		store.add(addDisposableListener(itemDoc, 'click', async (e) => {
			e.stopPropagation();
			this.closeAccountPopup();
			try {
				await this.commandService.executeCommand('workbench.action.openDocumentation');
			} catch {
				await this.commandService.executeCommand('workbench.action.openSettings');
			}
		}));

		// Déconnexion
		const itemSignOut = this.createMenuItem(popup, 'codicon-sign-out', localize('appica.accountSignOut', "Déconnexion"));
		store.add(addDisposableListener(itemSignOut, 'click', async (e) => {
			e.stopPropagation();
			this.closeAccountPopup();
			try {
				await this.appicaAuthService?.signOut();
			} catch {
				this.appicaNotificationService.error(localize('appica.signOutError', 'Échec de la déconnexion.'));
			}
		}));

		// Position popup directly above the anchor with boundary clamping
		const container = this.getContainer() ?? mainWindow.document.body;
		container.appendChild(popup);
		this.activeAccountPopup = { element: popup, store };
		anchor.setAttribute('aria-expanded', 'true');

		const positionPopup = () => {
			const rect = anchor.getBoundingClientRect();
			const popupWidth = popup.offsetWidth || 260;
			const maxLeft = Math.max(10, mainWindow.innerWidth - popupWidth - 10);
			popup.style.position = 'fixed';
			popup.style.left = `${Math.min(Math.max(10, rect.left), maxLeft)}px`;
			popup.style.bottom = `${Math.max(10, mainWindow.innerHeight - rect.top + 8)}px`;
		};
		positionPopup();

		// Keyboard navigation inside popup (ArrowUp / ArrowDown / Home / End / Tab / Escape)
		const getNavigableItems = () => Array.from(popup.querySelectorAll<HTMLElement>('.appica-custom-account-popup-item:not(.disabled)'));
		const navItems = getNavigableItems();
		if (navItems.length > 0) {
			navItems[0].focus();
		}

		store.add(addDisposableListener(popup, 'keydown', (e: KeyboardEvent) => {
			const items = getNavigableItems();
			const currentIndex = items.indexOf(mainWindow.document.activeElement as HTMLElement);
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				e.stopPropagation();
				const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
				items[nextIndex]?.focus();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				e.stopPropagation();
				const prevIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
				items[prevIndex]?.focus();
			} else if (e.key === 'Home') {
				e.preventDefault();
				e.stopPropagation();
				items[0]?.focus();
			} else if (e.key === 'End') {
				e.preventDefault();
				e.stopPropagation();
				items[items.length - 1]?.focus();
			} else if (e.key === 'Tab' || e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
				this.closeAccountPopup(true);
			}
		}));

		// Auto-close on window resize
		store.add(addDisposableListener(mainWindow, 'resize', () => this.closeAccountPopup()));

		// Click outside to close
		store.add(addDisposableListener(mainWindow.document.body, 'click', (e: MouseEvent) => {
			if (!popup.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
				this.closeAccountPopup();
			}
		}, true));
	}

	private getFooterHeight(): number {
		const actionCount = this.footerToolbar?.getItemsLength() ?? 0;
		const isAccountVisible = this.appicaAccountRow?.style.display !== 'none';
		const measuredHeight = this.appicaAccountRow?.offsetHeight;
		const accountHeight = isAccountVisible
			? ((measuredHeight && measuredHeight > 0 ? measuredHeight : SidebarPart.DEFAULT_ACCOUNT_HEIGHT) + 6)
			: 0;
		if (actionCount === 0 && accountHeight === 0) {
			return 0;
		}

		return accountHeight + SidebarPart.FOOTER_VERTICAL_PADDING * 2
			+ (actionCount * SidebarPart.FOOTER_ITEM_HEIGHT)
			+ (Math.max(0, actionCount - 1) * SidebarPart.FOOTER_ITEM_GAP)
			+ SidebarPart.FOOTER_BOTTOM_MARGIN
			+ SidebarPart.FOOTER_BORDER_TOP;
	}

	private updateFooterVisibility(): void {
		const footer = this.footerContainer;
		if (!footer) {
			return;
		}

		footer.style.display = this.getFooterHeight() > 0 ? '' : 'none';
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = this.getContainer();
		if (!container) {
			return;
		}

		container.style.backgroundColor = 'transparent';
		container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';
		container.style.outlineColor = this.getColor(SIDE_BAR_DRAG_AND_DROP_BACKGROUND) ?? '';

		// No right border in sessions sidebar
		container.style.borderRightWidth = '';
		container.style.borderRightStyle = '';
		container.style.borderRightColor = '';

		if (this.sideBarTitleArea) {
			this.sideBarTitleArea.style.backgroundColor = 'transparent';
			this.sideBarTitleArea.style.color = this.getColor(agentsPanelForeground) || '';
		}
	}

	override layout(width: number, height: number, top: number, left: number): void {
		this.closeAccountPopup();
		this.previousLayoutDimensions = { width, height, top, left };

		if (!this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
			return;
		}

		this._isLayoutRunning = true;
		try {
			const footerHeight = Math.min(height, this.getFooterHeight());
			if (this.footerContainer) {
				this.footerContainer.style.display = footerHeight > 0 ? '' : 'none';
			}

			// Layout composite content with reduced height to account for footer
			super.layout(
				width,
				Math.max(0, height - footerHeight),
				top, left
			);
		} finally {
			this._isLayoutRunning = false;
		}
	}

	protected override getTitleAreaDropDownAnchorAlignment(): AnchorAlignment {
		return this.layoutService.getSideBarPosition() === SideBarPosition.LEFT ? AnchorAlignment.LEFT : AnchorAlignment.RIGHT;
	}

	protected override createTitleLabel(_parent: HTMLElement): ICompositeTitleLabel {
		// No title label in agent sessions sidebar
		return {
			updateTitle: () => { },
			updateStyles: () => { }
		};
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'sidebar',
			pinnedViewContainersKey: SidebarPart.pinnedViewContainersKey,
			placeholderViewContainersKey: SidebarPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: SidebarPart.viewContainersWorkspaceStateKey,
			icon: false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => this.getCompositeBarPosition() === CompositeBarPosition.BOTTOM ? HoverPosition.ABOVE : HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: actions => {
				if (this.getCompositeBarPosition() === CompositeBarPosition.TITLE) {
					const viewsSubmenuAction = this.getViewsSubmenuAction();
					if (viewsSubmenuAction) {
						actions.push(new Separator());
						actions.push(viewsSubmenuAction);
					}
				}
			},
			compositeSize: 0,
			iconSize: 16,
			overflowActionSize: 30,
			colors: theme => ({
				activeBackgroundColor: undefined,
				inactiveBackgroundColor: undefined,
				activeBorderBottomColor: theme.getColor(ACTIVITY_BAR_TOP_ACTIVE_BORDER),
				activeForegroundColor: theme.getColor(ACTIVITY_BAR_TOP_FOREGROUND),
				inactiveForegroundColor: theme.getColor(ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND),
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				dragAndDropBorder: theme.getColor(ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER)
			}),
			compact: true
		};
	}

	protected shouldShowCompositeBar(): boolean {
		return false;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	async focusActivityBar(): Promise<void> {
		if (this.shouldShowCompositeBar()) {
			this.focusCompositeBar();
		}
	}

	toJSON(): object {
		return {
			type: Parts.SIDEBAR_PART
		};
	}
}
