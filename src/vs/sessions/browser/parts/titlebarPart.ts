/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/titlebar/media/titlebarpart.css';
import './media/titlebarpart.css';
import { MultiWindowParts, Part } from '../../../workbench/browser/part.js';
import { ITitleService } from '../../../workbench/services/title/browser/titleService.js';
import { getZoomFactor, isWCOEnabled, getWCOTitlebarAreaRect, isFullscreen, onDidChangeFullscreen } from '../../../base/browser/browser.js';
import { hasCustomTitlebar, hasNativeTitlebar, DEFAULT_CUSTOM_TITLEBAR_HEIGHT, TitlebarStyle, getTitleBarStyle, getWindowControlsStyle, WindowControlsStyle } from '../../../platform/window/common/window.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { agentsBackground, agentsPanelForeground } from '../../common/theme.js';
import { isMacintosh, isWeb, isNative, platformLocale } from '../../../base/common/platform.js';
import { EventType, EventHelper, append, $, addDisposableListener, prepend, getWindow, getWindowId } from '../../../base/browser/dom.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { Parts, IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';

import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { IMenuService, MenuId } from '../../../platform/actions/common/actions.js';
import { IEditorGroupsContainer } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { CodeWindow, mainWindow } from '../../../base/browser/window.js';
import { safeIntl } from '../../../base/common/date.js';
import { ITitlebarPart, ITitleProperties, ITitleVariable, IAuxiliaryTitlebarPart } from '../../../workbench/browser/parts/titlebar/titlebarPart.js';
import { WindowTitle } from '../../../workbench/browser/parts/titlebar/windowTitle.js';
import { Menus } from '../menus.js';

/**
 * Simplified agent sessions titlebar part.
 *
 * Three sections driven entirely by menus:
 * - **Left**: `Menus.TitleBarLeft` toolbar
 * - **Center**: `Menus.CommandCenter` toolbar (renders session picker via IActionViewItemService)
 * - **Right**: `Menus.TitleBarRight` toolbar (includes account submenu)
 *
 * No menubar, no editor actions, no layout controls, no WindowTitle dependency.
 */
export class TitlebarPart extends Part implements ITitlebarPart {

	//#region IView

	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;

	get minimumHeight(): number {
		const wcoEnabled = isWeb && isWCOEnabled();
		let value = DEFAULT_CUSTOM_TITLEBAR_HEIGHT;
		if (wcoEnabled) {
			value = Math.max(value, getWCOTitlebarAreaRect(getWindow(this.element))?.height ?? 0);
		}

		return value / (this.preventZoom ? getZoomFactor(getWindow(this.element)) : 1);
	}

	get maximumHeight(): number { return this.minimumHeight; }

	//#endregion

	//#region Events

	private readonly _onMenubarVisibilityChange = this._register(new Emitter<boolean>());
	readonly onMenubarVisibilityChange = this._onMenubarVisibilityChange.event;

	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	//#endregion

	protected rootContainer!: HTMLElement;
	protected windowControlsContainer: HTMLElement | undefined;

	private leftContent!: HTMLElement;
	private leftToolbarContainer!: HTMLElement;
	private centerContent!: HTMLElement;
	private rightContent!: HTMLElement;

	get leftContainer(): HTMLElement { return this.leftContent; }
	get centerContainer(): HTMLElement { return this.centerContent; }
	get rightContainer(): HTMLElement { return this.rightContent; }
	get rightWindowControlsContainer(): HTMLElement | undefined { return this.windowControlsContainer; }

	private leftSpacerWidth: number = 0;

	private readonly titleBarStyle: TitlebarStyle;
	private isInactive: boolean = false;

	constructor(
		id: string,
		targetWindow: CodeWindow,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHostService private readonly hostService: IHostService,
	) {
		super(id, { hasTitle: false }, themeService, storageService, layoutService);

		this.titleBarStyle = getTitleBarStyle(this.configurationService);

		this.registerListeners(getWindowId(targetWindow));
	}

	private registerListeners(targetWindowId: number): void {
		this._register(this.hostService.onDidChangeFocus(focused => focused ? this.onFocus() : this.onBlur()));
		this._register(this.hostService.onDidChangeActiveWindow(windowId => windowId === targetWindowId ? this.onFocus() : this.onBlur()));
	}

	private onBlur(): void {
		this.isInactive = true;
		this.updateStyles();
	}

	private onFocus(): void {
		this.isInactive = false;
		this.updateStyles();
	}

	updateProperties(_properties: ITitleProperties): void {
		// No window title to update in simplified titlebar
	}

	registerVariables(_variables: ITitleVariable[]): void {
		// No window title variables in simplified titlebar
	}

	updateOptions(_options: { compact: boolean }): void {
		// No compact mode support in agent sessions titlebar
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.rootContainer = append(parent, $('.titlebar-container.sessions-titlebar-container.has-center'));

		// Draggable region
		prepend(this.rootContainer, $('div.titlebar-drag-region'));

		this.leftContent = append(this.rootContainer, $('.titlebar-left'));
		this.centerContent = append(this.rootContainer, $('.titlebar-center'));
		this.rightContent = append(this.rootContainer, $('.titlebar-right'));

		// Window Controls Container (must be before left toolbar for correct ordering)
		if (!hasNativeTitlebar(this.configurationService, this.titleBarStyle)) {
			let primaryWindowControlsLocation = isMacintosh ? 'left' : 'right';
			if (isMacintosh && isNative) {
				const localeInfo = safeIntl.Locale(platformLocale).value;
				const textInfo = (localeInfo as { textInfo?: { direction?: string } }).textInfo;
				if (textInfo?.direction === 'rtl') {
					primaryWindowControlsLocation = 'right';
				}
			}

			if (isMacintosh && isNative && primaryWindowControlsLocation === 'left') {
				// macOS native: traffic lights are rendered by the OS at the top-left corner.
				// Add a fixed-width spacer to push content past the traffic lights.
				const spacer = append(this.leftContent, $('div.window-controls-container'));

				// Hide spacer in fullscreen (traffic lights are not shown)
				const updateSpacerVisibility = () => {
					const fullscreen = isFullscreen(mainWindow);
					spacer.style.display = fullscreen ? 'none' : '';
					this.leftSpacerWidth = fullscreen ? 0 : 70;
				};
				updateSpacerVisibility();
				spacer.style.width = `${this.leftSpacerWidth}px`;
				spacer.style.flexShrink = '0';
				this._register(onDidChangeFullscreen(windowId => {
					if (windowId === getWindowId(mainWindow)) {
						updateSpacerVisibility();
					}
				}));
			} else if (getWindowControlsStyle(this.configurationService) === WindowControlsStyle.HIDDEN) {
				// controls explicitly disabled
			} else {
				this.windowControlsContainer = append(primaryWindowControlsLocation === 'left' ? this.leftContent : this.rightContent, $('div.window-controls-container'));
				if (isWeb) {
					append(primaryWindowControlsLocation === 'left' ? this.rightContent : this.leftContent, $('div.window-controls-container'));
				}

				if (isWCOEnabled()) {
					this.windowControlsContainer.classList.add('wco-enabled');
				}
			}
		}

		// Left toolbar / App Menubar (App Name, File, View, Window)
		const menuService = this.instantiationService.invokeFunction(accessor => accessor.get(IMenuService));

		this.leftToolbarContainer = append(this.leftContent, $('div.left-toolbar-container'));
		this.leftToolbarContainer.style.display = 'flex';
		this.leftToolbarContainer.style.alignItems = 'center';
		this.leftToolbarContainer.style.gap = '16px';
		this.leftToolbarContainer.style.paddingLeft = '12px';
		this.leftToolbarContainer.style.fontSize = '13px';

		// Sidebar toggle button (visible when sidebar is closed)
		const sidebarToggleBtn = append(this.leftToolbarContainer, $('span.codicon.codicon-layout-sidebar-left'));
		sidebarToggleBtn.style.cursor = 'pointer';
		sidebarToggleBtn.style.fontSize = '14px';
		sidebarToggleBtn.style.color = 'var(--vscode-icon-foreground, #cccccc)';
		sidebarToggleBtn.title = 'Toggle Side Bar';
		
		const updateSidebarToggleVisibility = () => {
			const isVisible = this.layoutService.isVisible(Parts.SIDEBAR_PART);
			sidebarToggleBtn.style.display = isVisible ? 'none' : 'inline-block';
		};
		updateSidebarToggleVisibility();

		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.SIDEBAR_PART) {
				updateSidebarToggleVisibility();
			}
		}));

		this._register(addDisposableListener(sidebarToggleBtn, EventType.CLICK, () => {
			this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		}));

		const appLogoContainer = append(this.leftToolbarContainer, $('span.app-name-menu-item'));
		appLogoContainer.style.display = 'inline-flex';
		appLogoContainer.style.alignItems = 'center';
		appLogoContainer.style.cursor = 'pointer';
		appLogoContainer.style.height = '22px';
		appLogoContainer.style.marginRight = '18px';
		appLogoContainer.style.color = '#ffffff';

		const svgNamespace = 'http://www.w3.org/2000/svg';
		const svgElem = document.createElementNS(svgNamespace, 'svg');
		svgElem.setAttribute('viewBox', '0 38 385 120');
		svgElem.style.height = '22px';
		svgElem.style.width = 'auto';
		svgElem.style.display = 'block';

		const pathElem = document.createElementNS(svgNamespace, 'path');
		pathElem.setAttribute('fill', 'currentColor');
		pathElem.setAttribute('fill-rule', 'evenodd');
		pathElem.setAttribute('stroke', 'currentColor');
		pathElem.setAttribute('stroke-width', '.25');
		pathElem.setAttribute('stroke-linejoin', 'round');
		pathElem.setAttribute('d', 'M111.5 44.33C112.66 49.56 111.63 56.43 111.54 61.83C111.52 63.28 112.25 66.47 111.04 67.54C109.99 68.46 101.68 67.97 99.83 68C91.61 68.14 83.39 68 75.17 68.06C72.64 68.08 69.66 67.52 67.19 68.07C65.48 68.45 64 70.75 62.72 71.88C58.39 75.72 54.42 80.06 50.3 84.14C45.78 88.61 41.38 93.21 36.86 97.7C35.11 99.44 32.25 101.15 31.48 103.61C29.29 110.69 33.87 131.48 31.19 137.71C30.15 140.14 20.92 145.57 18.38 147.55C15.62 149.69 11.75 154.19 8.17 154.52C6.62 152.78 7.47 148.11 7.48 145.83C7.52 138.06 7.45 130.28 7.44 122.5C7.44 118.48 6.43 104.55 7.87 101.71C8.84 99.78 11.34 98.57 12.78 96.94C17.76 91.34 23.53 86.31 28.85 81.02C37.01 72.9 45.63 65.05 53.45 56.61C56.21 53.63 63.02 45.3 66.46 43.92C69.82 42.59 87.38 43.68 92.17 43.69C96.53 43.7 108.08 42.34 111.5 44.33ZM152.53 62.5C154.02 64.26 153.37 75.73 153.17 78.55C151.94 79.33 150.4 79.58 149.07 80.23C143.14 83.12 141.49 88.49 140.24 94.5C144.3 94.79 148.35 95.08 152.41 95.37C152.41 98.46 152.41 101.54 152.41 104.63C148.44 104.85 144.47 105.07 140.5 105.29C139.37 114.18 143.86 124.14 146.29 132.5C144.96 133.3 143.02 132.94 141.5 132.94C139.9 132.94 136.47 133.59 135.13 132.7C133.81 131.83 133.29 128.61 132.98 127.17C131.92 122.19 130.52 117.26 130.06 112.17C128.68 97.1 127.74 75.65 142.39 66.22C145.6 64.15 148.99 63.63 152.53 62.5ZM229.9 95.5C231.62 96.64 234.76 95.91 236.82 96.1C240.94 96.5 256.95 100.07 257.21 105.52C257.31 107.67 255.01 110.34 253.7 111.87C252.23 113.6 250.52 115.15 248.81 116.65C246.33 118.84 243.36 120.38 240.85 122.5C245.19 128.48 254.76 127.7 261.1 129.29C261.1 134.8 261.1 140.3 261.1 145.81C255.55 146.83 244.15 140.84 239.44 137.72C236.79 135.97 234.35 133.43 231.5 132.05C231.28 136.29 231.06 140.52 230.83 144.76C228.5 145.17 224.66 143.27 222.61 142.22C215.67 138.65 204.95 129.98 204.01 121.5C207.17 120.07 210.34 118.64 213.5 117.2C217.78 121.42 218.66 125.17 224.59 128.24C225.82 128.88 227.94 130.24 229.25 129.5C227.21 127.14 225.22 124.63 224.68 121.5C227.97 117.94 240.64 112.96 241.45 108.5C237.4 106.53 231.7 108.05 227.5 108.66C226.83 106.95 226.17 105.24 225.5 103.53C219 113 209.05 119.05 198.01 121.17C195.96 121.57 194.46 122.23 192.3 121.72C192.3 117.94 192.3 114.16 192.3 110.39C194.91 109.76 197.51 109.13 200.12 108.5C198.25 96.23 197.43 80.11 208.06 71.23C215.5 65.01 227.7 67.76 230.87 77.26C233.02 83.71 231.72 89.27 229.9 95.5ZM210.5 103.44C215.93 100.55 220.58 92.63 220.87 86.49C220.98 84.23 220.98 80.19 218.34 79.18C215.18 77.96 212.86 81.28 211.93 83.79C209.96 89.11 208.2 98.03 210.5 103.44ZM258.6 115.5C258.6 111.96 258.6 108.41 258.6 104.87C259.68 104.87 260.76 104.87 261.84 104.87C264.45 100.28 263.73 96.3 268.27 92.11C275.78 85.16 292.87 85.83 295.83 97.33C300.28 114.58 278.59 117.38 266.83 116.28C264.16 116.03 261.12 116.42 258.6 115.5ZM89.79 88.33C89.79 96.16 89.79 104 89.79 111.83C82 115.04 67.51 110.08 59.57 112.75C54.29 114.52 45.47 129.15 40.5 129.84C39.45 127.4 40.21 123.18 40.24 120.5C40.29 116.58 39.18 110.96 40.44 107.26C41.46 104.28 49.16 98 51.71 95.54C53.88 93.43 56.58 89.36 59.39 88.22C61.91 87.2 65.51 87.95 68.17 87.96C74.87 87.99 83.33 86.54 89.79 88.33ZM352.83 96.04C352.54 98.54 350.19 102.03 351.5 104.46C358.79 92.65 374.7 94.29 376.3 109.5C376.57 112.13 376.59 115.52 375.66 118.03C371.61 118.03 367.55 118.03 363.5 118.03C363.46 115.52 364.88 112.36 363.57 109.93C360.36 103.98 353.75 111.42 352.36 114.85C350.29 119.95 352.19 123.97 352.96 128.95C349.81 128.95 346.65 128.95 343.5 128.95C338.94 120.3 338.21 105.44 340.17 96.04C344.39 96.04 348.61 96.04 352.83 96.04ZM317.5 97.03C317.82 100.28 306.75 114.16 313.66 116.82C315.29 117.45 317.29 116.94 318.76 116.25C326.56 112.56 320.91 105.13 324.41 99.25C325.28 97.8 335.59 98.13 337.54 98.5C337.72 102.1 335.22 106.01 335.12 109.83C334.97 115.26 337.52 122.12 337.17 126.21C333.94 126.21 330.72 126.21 327.5 126.21C326.61 124.16 325.72 122.11 324.83 120.06C322.64 121.13 321.15 123.77 318.7 124.85C312.88 127.4 303.37 128.16 300.24 121.24C298.07 116.44 300.36 100.33 304.93 97.11C306.14 96.26 315.86 96.53 317.5 97.03ZM272.17 106.54C275.92 108.52 289.1 105.88 284.8 99.36C280.04 92.17 271.81 100.62 272.17 106.54ZM170.25 98.81C191.5 96.94 194.86 125.12 174.48 127.91C152.68 130.89 146.92 100.86 170.25 98.81ZM169.56 108.12C160.79 110.16 167.11 121.94 175.2 117.71C182.01 114.16 176.01 106.62 169.56 108.12ZM287.85 127.45C287.85 131.46 287.85 135.48 287.85 139.5C278.97 140.16 263.08 127.64 263.17 118.22C264.46 117.58 266.37 117.97 267.83 118.01C277.08 118.25 273.16 119.92 279.66 123.83C282.24 125.39 285.45 125.71 287.85 127.45Z');

		svgElem.appendChild(pathElem);
		appLogoContainer.appendChild(svgElem);
		this._register(addDisposableListener(appLogoContainer, EventType.CLICK, () => {
			const menu = menuService.createMenu(MenuId.MenubarHelpMenu, this.contextKeyService);
			const actions: any[] = [];
			for (const group of menu.getActions()) {
				actions.push(...group[1]);
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => appLogoContainer,
				getActions: () => actions,
			});
			menu.dispose();
		}));

		const fileMenuLabel = append(this.leftToolbarContainer, $('span.file-menu-item'));
		fileMenuLabel.textContent = 'File';
		fileMenuLabel.style.color = 'var(--vscode-foreground, #cccccc)';
		fileMenuLabel.style.cursor = 'pointer';
		this._register(addDisposableListener(fileMenuLabel, EventType.CLICK, () => {
			const menu = menuService.createMenu(MenuId.MenubarFileMenu, this.contextKeyService);
			const actions: any[] = [];
			for (const group of menu.getActions()) {
				actions.push(...group[1]);
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => fileMenuLabel,
				getActions: () => actions,
			});
			menu.dispose();
		}));

		const viewMenuLabel = append(this.leftToolbarContainer, $('span.view-menu-item'));
		viewMenuLabel.textContent = 'View';
		viewMenuLabel.style.color = 'var(--vscode-foreground, #cccccc)';
		viewMenuLabel.style.cursor = 'pointer';
		this._register(addDisposableListener(viewMenuLabel, EventType.CLICK, () => {
			const menu = menuService.createMenu(MenuId.MenubarViewMenu, this.contextKeyService);
			const actions: any[] = [];
			for (const group of menu.getActions()) {
				actions.push(...group[1]);
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => viewMenuLabel,
				getActions: () => actions,
			});
			menu.dispose();
		}));

		const windowMenuLabel = append(this.leftToolbarContainer, $('span.window-menu-item'));
		windowMenuLabel.textContent = 'Window';
		windowMenuLabel.style.color = 'var(--vscode-foreground, #cccccc)';
		windowMenuLabel.style.cursor = 'pointer';
		this._register(addDisposableListener(windowMenuLabel, EventType.CLICK, () => {
			const menu = menuService.createMenu(MenuId.MenubarHelpMenu, this.contextKeyService);
			const actions: any[] = [];
			for (const group of menu.getActions()) {
				actions.push(...group[1]);
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => windowMenuLabel,
				getActions: () => actions,
			});
			menu.dispose();
		}));

		// Center toolbar removed per user request (keeps center clean)

		// Right toolbar (driven by Menus.TitleBarRightLayout - includes layout actions)
		const rightToolbarContainer = prepend(this.rightContent, $('div.titlebar-actions-container.titlebar-right-layout-container'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, rightToolbarContainer, Menus.TitleBarRightLayout, {
			contextMenu: Menus.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'titlePart.right',
			toolbarOptions: { primaryGroup: () => true },
		}));

		// Session title actions toolbar (before right toolbar)
		const sessionActionsContainer = prepend(this.rightContent, $('div.titlebar-actions-container.titlebar-session-actions-container'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, sessionActionsContainer, Menus.TitleBarSessionMenu, {
			contextMenu: Menus.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'titlePart.sessionActions',
			toolbarOptions: { primaryGroup: () => true },
		}));

		// Context menu on the titlebar
		this._register(addDisposableListener(this.rootContainer, EventType.CONTEXT_MENU, e => {
			EventHelper.stop(e);
			this.onContextMenu(e);
		}));

		this.updateStyles();

		return this.element;
	}

	override updateStyles(): void {
		super.updateStyles();

		if (this.element) {
			this.element.classList.toggle('inactive', this.isInactive);

			const titleBarBackground = this.getColor(agentsBackground); // transparent background not supported on some platforms
			this.element.style.backgroundColor = titleBarBackground || '';

			const titleForeground = this.getColor(agentsPanelForeground);
			this.element.style.color = titleForeground || '';
		}
	}

	protected onContextMenu(e: MouseEvent): void {
		const event = new StandardMouseEvent(getWindow(this.element), e);
		this.contextMenuService.showContextMenu({
			getAnchor: () => event,
			menuId: Menus.TitleBarContext,
			contextKeyService: this.contextKeyService,
			domForShadowRoot: isMacintosh && isNative ? event.target : undefined
		});
	}

	get hasZoomableElements(): boolean {
		return true; // sessions titlebar always has command center and toolbar actions
	}

	get preventZoom(): boolean {
		// Prevent zooming behavior if any of the following conditions are met:
		// 1. Shrinking below the window control size (zoom < 1)
		// 2. No custom items are present in the title bar
		return getZoomFactor(getWindow(this.element)) < 1 || !this.hasZoomableElements;
	}

	override layout(width: number, height: number): void {
		this.updateLayout();
		super.layoutContents(width, height);
	}

	private updateLayout(): void {
		if (!hasCustomTitlebar(this.configurationService, this.titleBarStyle)) {
			return;
		}

		const zoomFactor = getZoomFactor(getWindow(this.element));
		this.element.style.setProperty('--zoom-factor', zoomFactor.toString());
		this.rootContainer.classList.toggle('counter-zoom', this.preventZoom);
	}

	focus(): void {
		// eslint-disable-next-line no-restricted-syntax
		(this.element.querySelector('[tabindex]:not([tabindex="-1"])') as HTMLElement | null)?.focus();
	}

	toJSON(): object {
		return { type: Parts.TITLEBAR_PART };
	}

	override dispose(): void {
		this._onWillDispose.fire();
		super.dispose();
	}
}

/**
 * Main agent sessions titlebar part (for the main window).
 */
export class MainTitlebarPart extends TitlebarPart {

	constructor(
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
	) {
		super(Parts.TITLEBAR_PART, mainWindow, contextMenuService, configurationService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService);
	}
}

/**
 * Auxiliary agent sessions titlebar part (for auxiliary windows).
 */
export class AuxiliaryTitlebarPart extends TitlebarPart implements IAuxiliaryTitlebarPart {

	private static COUNTER = 1;

	get height() { return this.minimumHeight; }

	constructor(
		readonly container: HTMLElement,
		private readonly mainTitlebar: TitlebarPart,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
	) {
		const id = AuxiliaryTitlebarPart.COUNTER++;
		super(`workbench.parts.auxiliaryTitle.${id}`, getWindow(container), contextMenuService, configurationService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService);
	}

	override get preventZoom(): boolean {
		// Prevent zooming behavior if any of the following conditions are met:
		// 1. Shrinking below the window control size (zoom < 1)
		// 2. No custom items are present in the main title bar
		// The auxiliary title bar never contains any zoomable items itself,
		// but we want to match the behavior of the main title bar.
		return getZoomFactor(getWindow(this.element)) < 1 || !this.mainTitlebar.hasZoomableElements;
	}
}

/**
 * Agent Sessions title service - manages the titlebar parts.
 */
export class TitleService extends MultiWindowParts<TitlebarPart> implements ITitleService {

	declare _serviceBrand: undefined;

	readonly mainPart: TitlebarPart;

	constructor(
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService
	) {
		super('workbench.agentSessionsTitleService', themeService, storageService);

		this.mainPart = this._register(this.createMainTitlebarPart());
		this.onMenubarVisibilityChange = this.mainPart.onMenubarVisibilityChange;
		this._register(this.registerPart(this.mainPart));
	}

	protected createMainTitlebarPart(): TitlebarPart {
		return this.instantiationService.createInstance(MainTitlebarPart);
	}

	//#region Auxiliary Titlebar Parts

	createAuxiliaryTitlebarPart(container: HTMLElement, editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): IAuxiliaryTitlebarPart {
		const titlebarPartContainer = $('.part.titlebar', { role: 'none' });
		titlebarPartContainer.style.position = 'relative';
		container.insertBefore(titlebarPartContainer, container.firstChild);

		const disposables = new DisposableStore();

		const titlebarPart = this.doCreateAuxiliaryTitlebarPart(titlebarPartContainer, editorGroupsContainer, instantiationService);
		disposables.add(this.registerPart(titlebarPart));

		disposables.add(Event.runAndSubscribe(titlebarPart.onDidChange, () => titlebarPartContainer.style.height = `${titlebarPart.height}px`));
		titlebarPart.create(titlebarPartContainer);

		Event.once(titlebarPart.onWillDispose)(() => disposables.dispose());

		return titlebarPart;
	}

	protected doCreateAuxiliaryTitlebarPart(container: HTMLElement, _editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): TitlebarPart & IAuxiliaryTitlebarPart {
		return instantiationService.createInstance(AuxiliaryTitlebarPart, container, this.mainPart);
	}

	//#endregion

	//#region Service Implementation

	readonly onMenubarVisibilityChange: Event<boolean>;

	updateProperties(properties: ITitleProperties): void {
		for (const part of this.parts) {
			part.updateProperties(properties);
		}
	}

	registerVariables(variables: ITitleVariable[]): void {
		for (const part of this.parts) {
			part.registerVariables(variables);
		}
	}

	private _windowTitle: WindowTitle | undefined;

	get windowTitle(): WindowTitle {
		// The Agents window title bar does not render `window.title`, so we
		// lazily construct a `WindowTitle` only when a consumer (e.g. a custom
		// command center widget) actually asks for one.
		if (!this._windowTitle) {
			this._windowTitle = this._register(this.instantiationService.createInstance(WindowTitle, mainWindow));
		}
		return this._windowTitle;
	}

	//#endregion
}
