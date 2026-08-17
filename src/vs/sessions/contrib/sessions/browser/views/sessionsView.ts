/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/sessionsViewPane.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { autorun } from '../../../../../base/common/observable.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { Orientation } from '../../../../../base/browser/ui/sash/sash.js';
import { IView, Sizing, SplitView } from '../../../../../base/browser/ui/splitview/splitview.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { Color } from '../../../../../base/common/color.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, IViewPaneLocationColors, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { localize } from '../../../../../nls.js';
import { SessionsList, SessionsGrouping, SessionsSorting } from './sessionsList.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { AgentHostShortcutsWidget } from '../agentHostShortcutsWidget.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { agentsBackground } from '../../../../common/theme.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { PANEL_SECTION_BORDER } from '../../../../../workbench/common/theme.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { MobileSessionFilterChips } from '../../../../browser/parts/mobile/mobileSessionFilterChips.js';
import { IMobileSortGroupSheetItem, showMobileSortGroupSheet } from '../../../../browser/parts/mobile/mobileSortGroupSheet.js';
import { isPhoneLayout } from '../../../../browser/parts/mobile/mobileLayout.js';
import { IsPhoneLayoutContext } from '../../../../common/contextkeys.js';
import { NewChatWidget } from '../../../chat/browser/newChatWidget.js';

const $ = DOM.$;
export const SessionsViewId = 'sessions.workbench.view.sessionsView';
const GROUPING_STORAGE_KEY = 'sessionsViewPane.grouping';
const SORTING_STORAGE_KEY = 'sessionsViewPane.sorting';
const SESSIONS_SECTION_MIN_HEIGHT = 120;

/**
 * Place the given session in the sessions grid to the right of the last
 * currently-visible session (as a non-sticky entry) and make it active. If
 * the session is already the last visible one, this is a no-op aside from
 * activation.
 */
export async function openSessionToTheSide(sessionsService: ISessionsService, session: ISession, options?: { preserveFocus?: boolean }): Promise<void> {
	const visible = sessionsService.visibleSessions.get();
	const lastVisible = visible[visible.length - 1];
	if (lastVisible && lastVisible.sessionId !== session.sessionId) {
		sessionsService.insertAt(session, lastVisible.sessionId, 'right');
	}
	await sessionsService.openSession(session.resource, options);
}

export const SessionsViewFilterSubMenu = new MenuId('SessionsViewPaneFilterSubMenu');
export const SessionsViewFilterOptionsSubMenu = new MenuId('SessionsViewPaneFilterOptionsSubMenu');
export const SessionsViewGroupingContext = new RawContextKey<string>('sessionsViewPane.grouping', SessionsGrouping.Workspace);
export const SessionsViewSortingContext = new RawContextKey<string>('sessionsViewPane.sorting', SessionsSorting.Created);
export const IsWorkspaceGroupCappedContext = new RawContextKey<boolean>('sessionsViewPane.workspaceGroupCapped', true);

export class SessionsView extends ViewPane {

	private viewPaneContainer: HTMLElement | undefined;
	private sidebarSplitViewContainer: HTMLElement | undefined;
	private sidebarSplitView: SplitView | undefined;
	private sessionsControlContainer: HTMLElement | undefined;
	private findWidgetContainer: HTMLElement | undefined;
	private headerRow: HTMLElement | undefined;
	private headerLabel: HTMLElement | undefined;
	private headerActions: HTMLElement | undefined;
	private isFindWidgetOpen = false;
	sessionsControl: SessionsList | undefined;
	private currentGrouping: SessionsGrouping = SessionsGrouping.Workspace;
	private currentSorting: SessionsSorting = SessionsSorting.Created;
	private groupingContextKey: IContextKey | undefined;
	private sortingContextKey: IContextKey | undefined;
	private workspaceGroupCappedContextKey: IContextKey<boolean> | undefined;
	private readonly filterContextKeys = new Map<string, { key: IContextKey<boolean>; getDefault: () => boolean }>();
	private currentBodyHeight = 0;
	private currentBodyWidth = 0;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IHostService private readonly hostService: IHostService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Restore persisted grouping
		const storedGrouping = this.storageService.get(GROUPING_STORAGE_KEY, StorageScope.PROFILE);
		if (storedGrouping && Object.values(SessionsGrouping).includes(storedGrouping as SessionsGrouping)) {
			this.currentGrouping = storedGrouping as SessionsGrouping;
		}

		// Restore persisted sorting
		const storedSorting = this.storageService.get(SORTING_STORAGE_KEY, StorageScope.PROFILE);
		if (storedSorting && Object.values(SessionsSorting).includes(storedSorting as SessionsSorting)) {
			this.currentSorting = storedSorting as SessionsSorting;
		}

		// Ensure context keys reflect restored state immediately
		this.groupingContextKey = SessionsViewGroupingContext.bindTo(contextKeyService);
		this.groupingContextKey.set(this.currentGrouping);
		this.sortingContextKey = SessionsViewSortingContext.bindTo(contextKeyService);
		this.sortingContextKey.set(this.currentSorting);

		// Bind workspace group capped context key (will be synced with persisted state in renderBody)
		this.workspaceGroupCappedContextKey = IsWorkspaceGroupCappedContext.bindTo(contextKeyService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		this.viewPaneContainer = parent;
		this.viewPaneContainer.classList.add('agent-sessions-viewpane');

		this.createControls(parent);
	}

	protected override getLocationBasedColors(): IViewPaneLocationColors {
		const colors = super.getLocationBasedColors();
		return {
			...colors,
			background: undefined!,
			listOverrideStyles: {
				...colors.listOverrideStyles,
				listBackground: undefined!,
				treeStickyScrollBackground: agentsBackground,
			}
		};
	}

	private createControls(parent: HTMLElement): void {
		const sessionsContainer = DOM.append(parent, $('.agent-sessions-container'));
		this.sidebarSplitViewContainer = DOM.append(sessionsContainer, $('.agent-sessions-sidebar-splitview-container'));

		// Sessions section (top, fills available space)
		const sessionsSection = DOM.append(this.sidebarSplitViewContainer, $('.agent-sessions-section'));

		// Sessions content container
		const sessionsContent = DOM.append(sessionsSection, $('.agent-sessions-content'));

		const phoneLayout = isPhoneLayout(this.layoutService);
		if (!phoneLayout) {
			const topActionsContainer = DOM.append(sessionsContent, $('.antigravity-top-actions'));
			topActionsContainer.style.padding = '18px 12px 14px 12px';
			topActionsContainer.style.display = 'flex';
			topActionsContainer.style.flexDirection = 'column';
			topActionsContainer.style.gap = '8px';

			// Top icons row (Sidebar toggle, Back, Forward)
			const topIconsRow = DOM.append(topActionsContainer, $('.antigravity-top-icons'));
			topIconsRow.style.display = 'flex';
			topIconsRow.style.alignItems = 'center';
			topIconsRow.style.gap = '16px';
			topIconsRow.style.padding = '0 4px';
			topIconsRow.style.marginBottom = '14px';
			topIconsRow.style.color = 'var(--vscode-icon-foreground, #cccccc)';
			topIconsRow.style.fontSize = '14px';

			const sidebarToggleIcon = DOM.append(topIconsRow, $('span.codicon.codicon-layout-sidebar-left'));
			sidebarToggleIcon.style.cursor = 'pointer';
			this._register(DOM.addDisposableListener(sidebarToggleIcon, DOM.EventType.CLICK, () => {
				this.instantiationService.invokeFunction(accessor => accessor.get(ICommandService).executeCommand('workbench.action.agentToggleSidebarVisibility'));
			}));

			const backIcon = DOM.append(topIconsRow, $('span.codicon.codicon-arrow-left'));
			backIcon.style.cursor = 'pointer';
			this._register(DOM.addDisposableListener(backIcon, DOM.EventType.CLICK, () => {
				this.instantiationService.invokeFunction(accessor => accessor.get(ICommandService).executeCommand('sessions.goBack'));
			}));

			const forwardIcon = DOM.append(topIconsRow, $('span.codicon.codicon-arrow-right'));
			forwardIcon.style.cursor = 'pointer';
			this._register(DOM.addDisposableListener(forwardIcon, DOM.EventType.CLICK, () => {
				this.instantiationService.invokeFunction(accessor => accessor.get(ICommandService).executeCommand('sessions.goForward'));
			}));

			// New Conversation Button
			const newConvBtn = DOM.append(topActionsContainer, $('.antigravity-new-conv-btn'));
			newConvBtn.style.display = 'flex';
			newConvBtn.style.alignItems = 'center';
			newConvBtn.style.gap = '10px';
			newConvBtn.style.padding = '8px 12px';
			newConvBtn.style.borderRadius = '6px';
			newConvBtn.style.border = '1px solid var(--vscode-widget-border, #333333)';
			newConvBtn.style.backgroundColor = 'var(--vscode-button-secondaryBackground, #1e1e1e)';
			newConvBtn.style.color = 'var(--vscode-button-secondaryForeground, #cccccc)';
			newConvBtn.style.cursor = 'pointer';
			newConvBtn.style.fontSize = '13px';
			newConvBtn.style.fontWeight = '500';
			
			DOM.append(newConvBtn, $('span.codicon.codicon-plus'));
			const newConvText = DOM.append(newConvBtn, $('span'));
			newConvText.textContent = localize('newConversation', "New Conversation");

			this._register(DOM.addDisposableListener(newConvBtn, DOM.EventType.CLICK, async () => {
				await this.sessionsService.openNewSession();
				NewChatWidget.activeInstance?.showView('create');
			}));

			// Conversation History Button
			const historyBtn = DOM.append(topActionsContainer, $('.antigravity-history-btn'));
			historyBtn.style.display = 'flex';
			historyBtn.style.alignItems = 'center';
			historyBtn.style.gap = '10px';
			historyBtn.style.padding = '6px 12px';
			historyBtn.style.borderRadius = '6px';
			historyBtn.style.color = 'var(--vscode-foreground, #cccccc)';
			historyBtn.style.cursor = 'pointer';
			historyBtn.style.fontSize = '13px';
			historyBtn.style.opacity = '0.9';
			historyBtn.style.transition = 'background-color 0.15s ease';

			this._register(DOM.addDisposableListener(historyBtn, DOM.EventType.MOUSE_ENTER, () => {
				historyBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
			}));
			this._register(DOM.addDisposableListener(historyBtn, DOM.EventType.MOUSE_LEAVE, () => {
				historyBtn.style.backgroundColor = 'transparent';
			}));

			DOM.append(historyBtn, $('span.codicon.codicon-history'));
			const historyText = DOM.append(historyBtn, $('span'));
			historyText.textContent = localize('conversationHistory', "Conversation History");

			this._register(DOM.addDisposableListener(historyBtn, DOM.EventType.CLICK, async () => {
				await this.sessionsService.openNewSession();
				NewChatWidget.activeInstance?.showView('history');
			}));
		}

		// Header row container (Projets label only)
		const headerRow = this.headerRow = DOM.append(sessionsContent, $('.agent-sessions-header-row'));
		if (phoneLayout) {
			headerRow.classList.add('phone-layout-empty');
		} else {
			const headerLabel = this.headerLabel = DOM.append(headerRow, $('.agent-sessions-header-label'));
			headerLabel.textContent = localize('projects', "Projets");
		}

		// Container for the tree's find widget (toggled by the toolbar's Find action)
		const findWidgetContainer = this.findWidgetContainer = DOM.append(headerRow, $('.agent-sessions-find-widget-container'));
		findWidgetContainer.style.display = 'none';

		// Reserve DOM slot for mobile filter chips (phone layout only).
		// The actual widget is created after sessionsControl is available.
		const filterChipsContainer = isPhoneLayout(this.layoutService)
			? DOM.append(sessionsContent, $('.mobile-session-filter-chips-slot'))
			: undefined;

		// Sessions List Control
		this.sessionsControlContainer = DOM.append(sessionsContent, $('.agent-sessions-control-container'));
		const sessionsControl = this.sessionsControl = this._register(this.instantiationService.createInstance(SessionsList, this.sessionsControlContainer, {
			overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			grouping: () => this.currentGrouping,
			sorting: () => this.currentSorting,
			findWidgetContainer,
			onSessionOpen: (resource, preserveFocus, sideBySide) => {
				const onOpened = () => {
					if (isWeb && isPhoneLayout(this.layoutService)) {
						this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
					}
				};
				if (sideBySide) {
					// Alt-click: open the session to the right of the last visible session in the grid.
					const session = this.sessionsManagementService.getSession(resource);
					if (session) {
						openSessionToTheSide(this.sessionsService, session, { preserveFocus }).then(onOpened).catch(onUnexpectedError);
						return;
					}
				}
				this.sessionsService.openSession(resource, { preserveFocus }).then(onOpened).catch(onUnexpectedError);
			},
		}));
		this._register(this.onDidChangeBodyVisibility(visible => sessionsControl.setVisible(visible)));

		// Toggle header label/actions visibility when find widget opens/closes
		this._register(sessionsControl.onDidChangeFindOpenState(open => {
			this.isFindWidgetOpen = open;
			findWidgetContainer.style.display = open ? '' : 'none';
			this.updateHeaderLayout();
		}));

		// Close find widget on Escape
		this._register(DOM.addDisposableListener(findWidgetContainer, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				sessionsControl.closeFind();
				e.stopPropagation();
			}
		}));

		// Sync workspace group capped context key with persisted state
		this.workspaceGroupCappedContextKey?.set(sessionsControl.isWorkspaceGroupCapped());

		// Register session type filter actions (re-register when session types change)
		this.registerSessionTypeFilters(sessionsControl);
		this._register(this.sessionsManagementService.onDidChangeSessionTypes(() => {
			this.registerSessionTypeFilters(sessionsControl);
		}));

		// Register status filter actions (static set, registered once)
		this.registerStatusFilters(sessionsControl);

		// Refresh sessions when window gets focus to compensate for missing events
		this._register(this.hostService.onDidChangeFocus(hasFocus => {
			if (hasFocus) {
				sessionsControl.refresh();
			}
		}));

		// Listen to list updates and restore selection if nothing is selected
		this._register(sessionsControl.onDidUpdate(() => {
			if (!sessionsControl.hasFocusOrSelection()) {
				this.restoreLastSelectedSession();
			}
		}));

		// Mobile filter chips (phone layout only) — created after sessionsControl
		// so we can wire it as the filter host.
		if (filterChipsContainer) {
			const chips = this._register(new MobileSessionFilterChips(filterChipsContainer, sessionsControl));
			this._register(chips.onDidRequestSortGroup(() => {
				this.openSortGroupSheet();
			}));
			this._register(chips.onDidRequestFind(() => {
				this.openFind();
			}));
		}

		// When the active session changes, reveal it in the sessions list.
		this._register(autorun(reader => {
			const activeSession = this.sessionsService.activeSession.read(reader);
			if (activeSession) {
				if (!sessionsControl.reveal(activeSession.resource)) {
					sessionsControl.clearFocus();
				}
			} else {
				sessionsControl.clearFocus();
			}
		}));

		const customizationsSection = DOM.append(this.sidebarSplitViewContainer, $('.agent-sessions-customizations-section'));
		customizationsSection.style.display = 'none';

		this.sidebarSplitView = this._register(new SplitView(this.sidebarSplitViewContainer, {
			orientation: Orientation.VERTICAL,
			proportionalLayout: false,
		}));

		const sessionsPane: IView = {
			element: sessionsSection,
			minimumSize: SESSIONS_SECTION_MIN_HEIGHT,
			maximumSize: Number.POSITIVE_INFINITY,
			onDidChange: Event.None,
			layout: height => {
				sessionsSection.style.height = `${height}px`;
				this.sessionsControl?.layout(this.sessionsControlContainer?.offsetHeight ?? 0, this.currentBodyWidth);
			},
		};

		this.sidebarSplitView.addView(sessionsPane, Sizing.Distribute, 0, true);

		const updateSplitViewStyles = () => {
			const borderColor = this.themeService.getColorTheme().getColor(PANEL_SECTION_BORDER);
			this.sidebarSplitView?.style({ separatorBorder: borderColor ?? Color.transparent });
		};
		updateSplitViewStyles();
		this._register(this.themeService.onDidColorThemeChange(updateSplitViewStyles));

		// Agent Host toolbar (bottom, below customizations). Only rendered
		// in the sessions window on web desktop layouts: electron has no
		// host picker today (gated out at the menu level), phone layout
		// uses the mobile titlebar pill instead, and auxiliary windows do
		// not contribute any host actions — without this gate they would
		// show an empty toolbar shell.
		if (isWeb && this.scopedContextKeyService.contextMatchesRules(ContextKeyExpr.and(
			IsSessionsWindowContext,
			IsAuxiliaryWindowContext.toNegated(),
			IsPhoneLayoutContext.negate(),
		))) {
			this._register(this.instantiationService.createInstance(AgentHostShortcutsWidget, sessionsContainer, {
				onDidChangeLayout: () => {
					this.layoutSidebarSplitView();
				},
			}));
		}

		this._register(DOM.scheduleAtNextAnimationFrame(DOM.getWindow(parent), () => this.layoutSidebarSplitView()));

		if (typeof ResizeObserver !== 'undefined' && parent) {
			const observer = new ResizeObserver(() => {
				this.layoutSidebarSplitView();
			});
			observer.observe(parent);
			this._register(toDisposable(() => observer.disconnect()));
		}
	}

	focusCustomizations(): void {
	}

	private restoreLastSelectedSession(): void {
		const activeSession = this.sessionsService.activeSession.get();
		if (activeSession && this.sessionsControl) {
			this.sessionsControl.reveal(activeSession.resource);
		}
	}

	private readonly registeredFilterTypeIds = new Set<string>();

	private registerSessionTypeFilters(sessionsControl: SessionsList): void {
		const sessionTypes = this.sessionsManagementService.getAllSessionTypes();
		for (let i = 0; i < sessionTypes.length; i++) {
			const type = sessionTypes[i];

			// Skip if already registered (action IDs are global and can't be re-registered)
			if (this.registeredFilterTypeIds.has(type.id)) {
				continue;
			}
			this.registeredFilterTypeIds.add(type.id);

			const contextKey = new RawContextKey<boolean>(`sessionsViewPane.filterType.${type.id}`, !sessionsControl.isSessionTypeExcluded(type.id));
			const contextKeyInstance = contextKey.bindTo(this.scopedContextKeyService);
			this.filterContextKeys.set(contextKey.key, { key: contextKeyInstance, getDefault: () => true });

			this._register(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `sessionsViewPane.filterType.${type.id}`,
						title: type.label,
						toggled: ContextKeyExpr.equals(contextKey.key, true),
						menu: [{
							id: SessionsViewFilterOptionsSubMenu,
							group: '1_types',
							order: i,
						}]
					});
				}
				override run() {
					const isExcluded = sessionsControl.isSessionTypeExcluded(type.id);
					sessionsControl.setSessionTypeExcluded(type.id, !isExcluded);
					contextKeyInstance.set(isExcluded); // was excluded, now included (toggle)
				}
			}));
		}
	}

	private registerStatusFilters(sessionsControl: SessionsList): void {
		const statusFilters: { status: SessionStatus; label: string }[] = [
			{ status: SessionStatus.Completed, label: localize('statusCompleted', "Completed") },
			{ status: SessionStatus.InProgress, label: localize('statusInProgress', "In Progress") },
			{ status: SessionStatus.NeedsInput, label: localize('statusNeedsInput', "Input Needed") },
			{ status: SessionStatus.Error, label: localize('statusFailed', "Failed") },
		];
		for (let i = 0; i < statusFilters.length; i++) {
			const { status, label } = statusFilters[i];
			const contextKey = new RawContextKey<boolean>(`sessionsViewPane.filterStatus.${status}`, !sessionsControl.isStatusExcluded(status));
			const contextKeyInstance = contextKey.bindTo(this.scopedContextKeyService);
			this.filterContextKeys.set(contextKey.key, { key: contextKeyInstance, getDefault: () => true });

			this._register(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `sessionsViewPane.filterStatus.${status}`,
						title: label,
						toggled: ContextKeyExpr.equals(contextKey.key, true),
						menu: [{
							id: SessionsViewFilterOptionsSubMenu,
							group: '2_status',
							order: i,
						}]
					});
				}
				override run() {
					const isExcluded = sessionsControl.isStatusExcluded(status);
					sessionsControl.setStatusExcluded(status, !isExcluded);
					contextKeyInstance.set(isExcluded);
				}
			}));
		}

		// Archived toggle
		const archivedContextKey = new RawContextKey<boolean>('sessionsViewPane.filter.showArchived', !sessionsControl.isExcludeArchived());
		const archivedContextKeyInstance = archivedContextKey.bindTo(this.scopedContextKeyService);
		this.filterContextKeys.set(archivedContextKey.key, { key: archivedContextKeyInstance, getDefault: () => false });

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'sessionsViewPane.filterArchived',
					title: localize('filterArchived', "Done"),
					toggled: ContextKeyExpr.equals(archivedContextKey.key, true),
					menu: [{
						id: SessionsViewFilterOptionsSubMenu,
						group: '3_props',
						order: 0,
					}]
				});
			}
			override run() {
				const excluding = sessionsControl.isExcludeArchived();
				sessionsControl.setExcludeArchived(!excluding);
				archivedContextKeyInstance.set(excluding); // was excluding → now showing
			}
		}));

		// Read toggle
		const readContextKey = new RawContextKey<boolean>('sessionsViewPane.filter.showRead', !sessionsControl.isExcludeRead());
		const readContextKeyInstance = readContextKey.bindTo(this.scopedContextKeyService);
		this.filterContextKeys.set(readContextKey.key, { key: readContextKeyInstance, getDefault: () => true });

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'sessionsViewPane.filterRead',
					title: localize('filterRead', "Read"),
					toggled: ContextKeyExpr.equals(readContextKey.key, true),
					menu: [{
						id: SessionsViewFilterOptionsSubMenu,
						group: '3_props',
						order: 1,
					}]
				});
			}
			override run() {
				const excluding = sessionsControl.isExcludeRead();
				sessionsControl.setExcludeRead(!excluding);
				readContextKeyInstance.set(excluding);
			}
		}));

		// Reset filter action
		const filterContextKeys = this.filterContextKeys;
		const workspaceGroupCappedContextKey = this.workspaceGroupCappedContextKey;
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'sessionsViewPane.resetFilters',
					title: localize('resetFilters', "Reset"),
					menu: [{
						id: SessionsViewFilterOptionsSubMenu,
						group: '4_reset',
						order: 0,
					}]
				});
			}
			override run() {
				sessionsControl.resetFilters();
				for (const { key, getDefault } of filterContextKeys.values()) {
					key.set(getDefault());
				}
				workspaceGroupCappedContextKey?.set(sessionsControl.isWorkspaceGroupCapped());
			}
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		this.currentBodyHeight = height;
		this.currentBodyWidth = width;
		this.updateHeaderLayout();
		this.layoutSidebarSplitView();

		if (this.sidebarSplitView || !this.sessionsControl || !this.sessionsControlContainer) {
			return;
		}

		this.sessionsControl.layout(this.sessionsControlContainer.offsetHeight, width);
	}

	private layoutSidebarSplitView(): void {
		if (!this.sidebarSplitView || !this.sidebarSplitViewContainer) {
			return;
		}

		let height = this.sidebarSplitViewContainer.offsetHeight || this.currentBodyHeight || this.viewPaneContainer?.offsetHeight || 0;
		if (height <= 0) {
			height = this.viewPaneContainer?.parentElement?.offsetHeight || 300;
		}

		if (this.sidebarSplitViewContainer.offsetHeight === 0 && height > 0) {
			this.sidebarSplitViewContainer.style.height = `${height}px`;
		}
		this.sidebarSplitView.layout(height);
	}

	override focus(): void {
		super.focus();

		this.sessionsControl?.focus();
	}

	refresh(): void {
		this.sessionsControl?.refresh();
	}

	openFind(): void {
		this.isFindWidgetOpen = true;
		if (this.findWidgetContainer) {
			// Show container before opening find so the widget can be focused
			this.findWidgetContainer.style.display = '';
		}
		this.updateHeaderLayout();
		this.sessionsControl?.openFind();
	}

	private updateHeaderLayout(): void {
		if (!this.headerRow || !this.headerLabel) {
			return;
		}

		// On phone the desktop header content is hidden; the row is only
		// visible when the find widget is open (so the user can search).
		if (isPhoneLayout(this.layoutService)) {
			this.headerRow.classList.toggle('phone-layout-empty', !this.isFindWidgetOpen);
			return;
		}

		if (this.isFindWidgetOpen) {
			this.headerLabel.style.display = 'none';
			if (this.headerActions) {
				this.headerActions.style.display = 'none';
			}
			return;
		}

		this.headerLabel.style.display = '';
		if (this.headerActions) {
			this.headerActions.style.display = '';
		}
	}

	/**
	 * Phone-only: present a bottom sheet with the four sort/group toggles.
	 * Filtering on phone is performed via the status filter chips, so the
	 * sheet intentionally omits "Filter", "Show Recent/All Sessions", and
	 * "Collapse All Groups" actions found in the desktop submenu.
	 */
	private openSortGroupSheet(): void {
		const sortTitle = localize('sortGroupSheet.sort', "Sort");
		const groupTitle = localize('sortGroupSheet.group', "Group");

		const items: IMobileSortGroupSheetItem[] = [
			{
				id: SessionsSorting.Created,
				label: localize('sortByCreated', "Sort by Created"),
				checked: this.currentSorting === SessionsSorting.Created,
				group: 'sort',
				groupTitle: sortTitle,
			},
			{
				id: SessionsSorting.Updated,
				label: localize('sortByUpdated', "Sort by Updated"),
				checked: this.currentSorting === SessionsSorting.Updated,
				group: 'sort',
			},
			{
				id: SessionsGrouping.Workspace,
				label: localize('groupByWorkspace', "Group by Workspace"),
				checked: this.currentGrouping === SessionsGrouping.Workspace,
				group: 'group',
				groupTitle: groupTitle,
			},
			{
				id: SessionsGrouping.Date,
				label: localize('groupByTime', "Group by Time"),
				checked: this.currentGrouping === SessionsGrouping.Date,
				group: 'group',
			},
		];

		showMobileSortGroupSheet(this.layoutService.mainContainer, localize('sortGroupSheet.title', "Sort"), items).then(selectedId => {
			if (!selectedId) {
				return;
			}
			if (selectedId === SessionsSorting.Created || selectedId === SessionsSorting.Updated) {
				this.setSorting(selectedId);
			} else if (selectedId === SessionsGrouping.Workspace || selectedId === SessionsGrouping.Date) {
				this.setGrouping(selectedId);
			}
		});
	}

	setGrouping(grouping: SessionsGrouping): void {
		if (this.currentGrouping === grouping) {
			return;
		}

		this.currentGrouping = grouping;
		this.storageService.store(GROUPING_STORAGE_KEY, this.currentGrouping, StorageScope.PROFILE, StorageTarget.USER);
		this.groupingContextKey?.set(this.currentGrouping);
		this.sessionsControl?.resetSectionCollapseState();
		this.sessionsControl?.update(true);
	}

	setSorting(sorting: SessionsSorting): void {
		if (this.currentSorting === sorting) {
			return;
		}

		this.currentSorting = sorting;
		this.storageService.store(SORTING_STORAGE_KEY, this.currentSorting, StorageScope.PROFILE, StorageTarget.USER);
		this.sortingContextKey?.set(this.currentSorting);
		this.sessionsControl?.update();
	}
}
