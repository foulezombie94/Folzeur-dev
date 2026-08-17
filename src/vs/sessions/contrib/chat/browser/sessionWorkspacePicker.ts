/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import * as touch from '../../../../base/browser/touch.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IAction, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { ITabDescriptor, TabbedActionListWidget } from '../../../../platform/actionWidget/browser/tabbedActionListWidget.js';
import { IMenuService, MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IRemoteAgentHostService, RemoteAgentHostConnectionStatus, RemoteAgentHostsEnabledSettingId } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { TUNNEL_ADDRESS_PREFIX } from '../../../../platform/agentHost/common/tunnelAgentHost.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ISessionWorkspace, ISessionWorkspaceBrowseAction, SESSION_WORKSPACE_GROUP_LOCAL, SESSION_WORKSPACE_GROUP_REMOTE } from '../../../services/sessions/common/session.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsRecentWorkspacesService } from '../../../services/sessions/browser/sessionsRecentWorkspacesService.js';
import { IAgentHostSessionsProvider, isAgentHostProvider } from '../../../common/agentHostSessionsProvider.js';
import { SessionWorkspacePickerGroupContext } from '../../../common/contextkeys.js';
// eslint-disable-next-line local/code-import-patterns -- TODO: move remote host options out of providers
import { getStatusHover, getStatusLabel, removeRemoteHost, showRemoteHostOptions } from '../../providers/remoteAgentHost/browser/remoteHostOptions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { reportNewChatPickerClosed } from './newChatPickerTelemetry.js';
import { Menus } from '../../../browser/menus.js';
import { markOnboardingTarget } from '../../../../workbench/contrib/onboarding/browser/spotlight/onboardingTarget.js';

/**
 * Grace period for a restored remote workspace's provider to reach Connected
 * before we fall back to no selection. SSH tunnels typically connect within
 * a couple seconds; if it hasn't connected by then, we'd rather show no
 * selection than leave the user staring at an unreachable workspace.
 */
const RESTORE_CONNECT_GRACE_MS = 5000;

/**
 * A workspace as resolved from a folder URI for rendering. The `providerId`
 * is the provider that resolved the URI (first match in iteration order,
 * or the preferred hint when honored). For local URIs that any local
 * provider can resolve, this is the first registered local provider; for
 * remote URIs it is the remote provider for that authority.
 */
export interface IResolvedFolderWorkspace {
	readonly providerId: string;
	readonly workspace: ISessionWorkspace;
}

/**
 * Item type used in the action list.
 */
export interface IWorkspacePickerItem {
	readonly folderUri?: URI;
	/** The resolved workspace (used for unavailable-provider checks). */
	readonly providerId?: string;
	readonly browseActionIndex?: number;
	readonly checked?: boolean;
	/** Command to execute when this item is selected. */
	readonly commandId?: string;
	/** Inline action to run when this item is selected. */
	readonly run?: () => void;
}

export interface IWorkspacePickerOptions {
	readonly canSelectWorkspace?: (folderUri: URI, providerId: string | undefined) => Promise<boolean>;
}

interface IBrowsedWorkspaceSelection {
	readonly workspace: ISessionWorkspace;
	readonly providerId: string;
}

type IWorkspacePickerAction = IAction & { icon?: ThemeIcon; hoverContent?: string; onRemove?: () => void };

/**
 * A unified workspace picker that shows workspaces from all registered session
 * providers in a single dropdown.
 *
 * Browse actions from providers are appended at the bottom of the list.
 */
export class WorkspacePicker extends Disposable {

	protected readonly _onDidSelectWorkspace = this._register(new Emitter<URI | undefined>());
	readonly onDidSelectWorkspace: Event<URI | undefined> = this._onDidSelectWorkspace.event;
	protected readonly _onDidChangeSelection = this._register(new Emitter<void>());
	readonly onDidChangeSelection: Event<void> = this._onDidChangeSelection.event;

	private _selectedFolderUri: URI | undefined;
	private _selectedResolved: IResolvedFolderWorkspace | undefined;
	private _selectionGeneration = 0;

	/**
	 * Set to `true` once the user has explicitly picked or cleared a workspace.
	 * Until then, late-arriving provider registrations are allowed to upgrade
	 * the current (auto-restored) selection to the user's stored "checked"
	 * entry. After the user has acted, providers coming and going never move
	 * the selection out from under them.
	 */
	private _userHasPicked = false;

	/**
	 * Watches the connection status of a restored remote workspace. Cleared when
	 * the user explicitly picks, when the connection succeeds, or when it fails
	 * and we fall back.
	 */
	private readonly _connectionStatusWatch = this._register(new MutableDisposable());
	private readonly _localBrowseAction: ISessionWorkspaceBrowseAction = {
		label: localize('workspacePicker.browseSelectLocal', "Select..."),
		group: SESSION_WORKSPACE_GROUP_LOCAL,
		icon: Codicon.folderOpened,
		providerId: '',
		run: async () => (await this._browseForLocalFolder())?.workspace,
	};

	/**
	 * "Primary" trigger. This is the most recently created entry. Preserved for subclass
	 * read access (e.g. {@link WebWorkspacePicker} anchors its mobile sheet here) and for
	 * {@link showPicker} calls that do not supply an anchor.
	 */
	protected _triggerElement: HTMLElement | undefined;
	/** All live trigger elements. Label updates fan out to every entry. */
	private readonly _triggerElements = new Set<HTMLElement>();
	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _tabbedWidget: TabbedActionListWidget;
	private readonly _pickerGroupContext: IContextKey<string>;

	/**
	 * Currently active workspace tab (a group label contributed by a
	 * provider, e.g. `"Local"` / `"Cloud"` / `"Remote"`).
	 */
	private _activeTab: string | undefined;

	get selectedFolderUri(): URI | undefined {
		return this._selectedFolderUri;
	}

	/**
	 * Returns the currently selected folder resolved to a workspace via the
	 * first provider that can resolve it. Used internally for rendering
	 * (label, icon, group). The provider association is not part of the
	 * picker's public contract — callers should use {@link selectedFolderUri}
	 * and let the management service rediscover the provider.
	 */
	get selectedResolved(): IResolvedFolderWorkspace | undefined {
		return this._selectedResolved;
	}

	constructor(
		private readonly options: IWorkspacePickerOptions,
		@IActionWidgetService protected readonly actionWidgetService: IActionWidgetService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ISessionsProvidersService protected readonly sessionsProvidersService: ISessionsProvidersService,
		@ISessionsRecentWorkspacesService private readonly recentWorkspacesService: ISessionsRecentWorkspacesService,
		@IRemoteAgentHostService private readonly remoteAgentHostService: IRemoteAgentHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		this._tabbedWidget = this._register(this.instantiationService.createInstance(TabbedActionListWidget));
		this._pickerGroupContext = SessionWorkspacePickerGroupContext.bindTo(this.contextKeyService);
		this._register(this._tabbedWidget.onDidChangeTab(tab => {
			this._activeTab = tab;
			this._pickerGroupContext.set(tab);
		}));
		this._register(this._tabbedWidget.onDidHide(() => {
			this._pickerGroupContext.reset();
		}));

		// Restore selected workspace from storage
		const restored = this._restoreSelectedWorkspace();
		this._applySelection(restored);
		if (this._selectedResolved) {
			this._watchForConnectionFailure(this._selectedResolved);
		}

		// React to provider registrations/removals: re-validate the current
		// selection, and if the user hasn't explicitly picked yet, re-restore
		// from storage so we upgrade from any fallback to the user's actual
		// stored selection once its provider arrives.
		this._register(this.sessionsProvidersService.onDidChangeProviders(() => {
			if (this._selectedFolderUri) {
				// Re-resolve in case the previous resolving provider was removed.
				const reresolved = this._resolveFolder(this._selectedFolderUri);
				if (!reresolved) {
					this._selectedFolderUri = undefined;
					this._selectedResolved = undefined;
					this._connectionStatusWatch.clear();
					this._updateTriggerLabel();
					this._onDidChangeSelection.fire();
					this._onDidSelectWorkspace.fire(undefined);
				} else {
					this._selectedResolved = reresolved;
				}
			}
			if (!this._userHasPicked) {
				const restoredNow = this._restoreSelectedWorkspace();
				if (restoredNow && !this._isSelectedFolder(restoredNow.workspace.folders[0]?.root)) {
					this._applySelection(restoredNow);
					this._updateTriggerLabel();
					this._onDidChangeSelection.fire();
					this._onDidSelectWorkspace.fire(this._selectedFolderUri);
					this._watchForConnectionFailure(restoredNow);
				}
			}
		}));
	}

	/**
	 * Renders the project picker trigger button into the given container.
	 * Returns the container element.
	 *
	 * Calling it again replaces the trigger created by the previous
	 * {@link render} call.
	 */
	render(container: HTMLElement): HTMLElement {
		const slot = dom.append(container, dom.$('.sessions-chat-picker-slot.sessions-chat-workspace-picker'));
		this._renderDisposables.add({ dispose: () => slot.remove() });
		this._renderDisposables.add(this._addTrigger(slot));

		return slot;
	}

	/**
	 * Shared trigger-creation core for {@link render}. Wires up the click /
	 * keyboard / touch handlers and the per-trigger lifecycle.
	 */
	private _addTrigger(slot: HTMLElement): IDisposable {
		const triggerDisposables = new DisposableStore();

		const trigger = dom.append(slot, dom.$('a.action-label'));
		trigger.tabIndex = 0;
		trigger.role = 'button';
		trigger.setAttribute('aria-haspopup', 'listbox');
		trigger.setAttribute('aria-expanded', 'false');

		this._triggerElements.add(trigger);
		this._triggerElement = trigger;
		this._renderTriggerLabel(trigger);
		// Onboarding spotlight target — id is referenced by the "new session" tour
		// in vs/sessions/contrib/onboardingTours.
		triggerDisposables.add(markOnboardingTarget(trigger, 'sessions.newSession.workspacePicker', {
			open: () => this.showPicker(false, trigger),
		}));

		triggerDisposables.add(touch.Gesture.addTarget(trigger));
		[dom.EventType.CLICK, touch.EventType.Tap].forEach(eventType => {
			triggerDisposables.add(dom.addDisposableListener(trigger, eventType, (e) => {
				dom.EventHelper.stop(e, true);
				this.showPicker(false, trigger);
			}));
		});
		triggerDisposables.add(dom.addDisposableListener(trigger, dom.EventType.KEY_DOWN, (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				dom.EventHelper.stop(e, true);
				this.showPicker(false, trigger);
			}
		}));

		triggerDisposables.add({
			dispose: () => {
				this._triggerElements.delete(trigger);
				if (this._triggerElement === trigger) {
					// Demote to any other live trigger so subclasses that read
					// `_triggerElement` (e.g. WebWorkspacePicker's mobile sheet
					// path) don't dereference a removed node.
					this._triggerElement = this._triggerElements.values().next().value;
				}
			},
		});

		return triggerDisposables;
	}

	private _activeDropdown: IDisposable | undefined;

	private _hideCustomDropdown(): void {
		if (this._activeDropdown) {
			this._activeDropdown.dispose();
			this._activeDropdown = undefined;
		}
	}

	private _showCustomDropdown(triggerElement: HTMLElement): void {
		this._hideCustomDropdown();
		this._tabbedWidget.hide();
		if (this.actionWidgetService.isVisible) {
			this.actionWidgetService.hide();
		}

		const disposables = new DisposableStore();
		const doc = triggerElement.ownerDocument;
		const overlay = dom.append(doc.body, dom.$('.sessions-workspace-dropdown-overlay'));

		const menu = dom.append(overlay, dom.$('.sessions-workspace-dropdown-menu'));

		// Compute position
		const rect = triggerElement.getBoundingClientRect();
		const bottom = doc.documentElement.clientHeight - rect.top + 6;
		let left = rect.left;
		const maxRight = (doc.defaultView?.innerWidth ?? 1200);
		if (left + 240 > maxRight) {
			left = Math.max(10, maxRight - 250);
		}
		menu.style.bottom = `${bottom}px`;
		menu.style.left = `${left}px`;

		// Close on click outside or escape
		disposables.add(dom.addDisposableListener(overlay, dom.EventType.POINTER_DOWN, (e) => {
			if (!menu.contains(e.target as Node)) {
				this._hideCustomDropdown();
			}
		}));
		disposables.add(dom.addDisposableListener(doc, dom.EventType.KEY_DOWN, (e) => {
			if (e.key === 'Escape') {
				this._hideCustomDropdown();
			}
		}));

		// 1. Recent Workspaces
		const allProviders = this.sessionsProvidersService.getProviders();
		const providerIds = new Set(allProviders.map(p => p.id));
		const recentWorkspaces = this._getRecentWorkspaces().filter(w => providerIds.has(w.providerId));

		for (const { workspace, providerId } of recentWorkspaces) {
			const folderUri = workspace.folders[0]?.root;
			if (!folderUri) {
				continue;
			}
			const isSelected = this._isSelectedFolder(folderUri);
			const itemEl = dom.append(menu, dom.$('.sessions-workspace-dropdown-item'));
			if (isSelected) {
				itemEl.classList.add('selected');
			}

			const leftContent = dom.append(itemEl, dom.$('.item-left'));
			const iconEl = dom.append(leftContent, dom.$('.item-icon'));
			iconEl.appendChild(renderIcon(Codicon.folder));
			const labelEl = dom.append(leftContent, dom.$('.item-label'));
			labelEl.textContent = workspace.label;

			if (isSelected) {
				const checkEl = dom.append(itemEl, dom.$('.item-check'));
				checkEl.appendChild(renderIcon(Codicon.check));
			}

			disposables.add(dom.addDisposableListener(itemEl, dom.EventType.CLICK, () => {
				this._hideCustomDropdown();
				void this._selectFolder(folderUri, true, providerId);
			}));
		}

		// Separator
		dom.append(menu, dom.$('.sessions-workspace-dropdown-separator'));

		// 2. New Project
		const newProjectItem = dom.append(menu, dom.$('.sessions-workspace-dropdown-item'));
		const newProjectLeft = dom.append(newProjectItem, dom.$('.item-left'));
		const newProjectIcon = dom.append(newProjectLeft, dom.$('.item-icon'));
		newProjectIcon.appendChild(renderIcon(Codicon.newFolder));
		const newProjectLabel = dom.append(newProjectLeft, dom.$('.item-label'));
		newProjectLabel.textContent = localize('workspacePicker.newProject', "New Project");
		disposables.add(dom.addDisposableListener(newProjectItem, dom.EventType.CLICK, async () => {
			this._hideCustomDropdown();
			const browsed = await this._browseForLocalFolder();
			if (browsed) {
				const root = browsed.workspace.folders[0]?.root;
				if (root) {
					this._selectFolder(root, true, browsed.providerId);
				}
			}
		}));

		// 3. Quick Start
		const quickStartItem = dom.append(menu, dom.$('.sessions-workspace-dropdown-item'));
		const quickStartLeft = dom.append(quickStartItem, dom.$('.item-left'));
		const quickStartIcon = dom.append(quickStartLeft, dom.$('.item-icon'));
		quickStartIcon.appendChild(renderIcon(Codicon.folderLibrary));
		const quickStartLabel = dom.append(quickStartLeft, dom.$('.item-label'));
		quickStartLabel.textContent = localize('workspacePicker.quickStart', "Quick Start");
		disposables.add(dom.addDisposableListener(quickStartItem, dom.EventType.CLICK, () => {
			this._hideCustomDropdown();
			void this.commandService.executeCommand('workbench.action.quickOpen');
		}));

		// Separator
		dom.append(menu, dom.$('.sessions-workspace-dropdown-separator'));

		// 4. No Project
		const noProjectItem = dom.append(menu, dom.$('.sessions-workspace-dropdown-item'));
		const isNoProject = !this._selectedFolderUri;
		if (isNoProject) {
			noProjectItem.classList.add('selected');
		}
		const noProjectLeft = dom.append(noProjectItem, dom.$('.item-left'));
		const noProjectIcon = dom.append(noProjectLeft, dom.$('.item-icon'));
		noProjectIcon.appendChild(renderIcon(Codicon.circleSlash));
		const noProjectLabel = dom.append(noProjectLeft, dom.$('.item-label'));
		noProjectLabel.textContent = localize('workspacePicker.noProject', "No Project");

		if (isNoProject) {
			const checkEl = dom.append(noProjectItem, dom.$('.item-check'));
			checkEl.appendChild(renderIcon(Codicon.check));
		}

		disposables.add(dom.addDisposableListener(noProjectItem, dom.EventType.CLICK, () => {
			this._hideCustomDropdown();
			this.clearSelection();
		}));

		disposables.add({
			dispose: () => {
				overlay.remove();
			}
		});

		this._activeDropdown = disposables;
	}

	/**
	 * Shows the workspace picker dropdown anchored to a trigger element.
	 */
	showPicker(force = false, anchor?: HTMLElement): void {
		const triggerElement = anchor ?? this._triggerElement;
		if (!triggerElement) {
			return;
		}
		this._showCustomDropdown(triggerElement);
	}

	/**
	 * Subclasses may opt out of the categorical tab bar (e.g. when scoped to
	 * a single host).
	 */
	protected _showTabs(): boolean {
		return true;
	}

	protected _getAvailableTabs(): ITabDescriptor[] {
		const byLabel = new Map<string, ITabDescriptor>();
		const remoteAgentHostsEnabled = this.configurationService.getValue<boolean>(RemoteAgentHostsEnabledSettingId);
		if (remoteAgentHostsEnabled) {
			byLabel.set(SESSION_WORKSPACE_GROUP_REMOTE, {
				id: SESSION_WORKSPACE_GROUP_REMOTE,
				icon: Codicon.beaker,
				tooltip: `${SESSION_WORKSPACE_GROUP_REMOTE} (${localize('workspacePicker.experimental', "Experimental")})`,
			});
		}
		for (const provider of this.sessionsProvidersService.getProviders()) {
			if (provider.supportsLocalWorkspaces && !byLabel.has(SESSION_WORKSPACE_GROUP_LOCAL)) {
				byLabel.set(SESSION_WORKSPACE_GROUP_LOCAL, { id: SESSION_WORKSPACE_GROUP_LOCAL });
			}
			for (const action of provider.browseActions) {
				if (action.group === SESSION_WORKSPACE_GROUP_REMOTE && !remoteAgentHostsEnabled) {
					continue;
				}
				if (action.group && !byLabel.has(action.group)) {
					byLabel.set(action.group, { id: action.group });
				}
			}
		}
		return Array.from(byLabel.values()).sort((a, b) =>
			a.id === SESSION_WORKSPACE_GROUP_LOCAL ? -1
				: b.id === SESSION_WORKSPACE_GROUP_LOCAL ? 1
					: a.id.localeCompare(b.id));
	}



	/**
	 * Dispatch logic for a picker item once the user picks it. Shared
	 * between the desktop action-widget delegate and any mobile sheet
	 * subclass that opts to render a different UI but reuse the
	 * selection semantics. Treats unavailable workspaces as a no-op.
	 */
	protected async _dispatchPickerItem(item: IWorkspacePickerItem): Promise<boolean> {
		const generation = ++this._selectionGeneration;
		this._reportPickerClosed(item);
		if (item.run) {
			item.run();
			return true;
		} else if (item.commandId) {
			void this.commandService.executeCommand(item.commandId);
			return true;
		} else if (item.folderUri && item.providerId && this._isProviderUnavailable(item.providerId)) {
			// Workspace belongs to an unavailable remote — ignore selection
			return false;
		}
		if (item.browseActionIndex !== undefined) {
			const selection = await this._executeBrowseAction(item.browseActionIndex);
			const folderUri = selection?.workspace.folders[0]?.root;
			if (!folderUri || generation !== this._selectionGeneration) {
				return false;
			}
			if (!await this._canSelectWorkspace(folderUri, selection.providerId)) {
				return false;
			}
			if (generation !== this._selectionGeneration) {
				return false;
			}
			this._selectFolder(folderUri);
			return true;
		} else if (item.folderUri) {
			if (item.providerId && !await this._connectProviderOnDemand(item.providerId)) {
				return false;
			}
			if (generation !== this._selectionGeneration) {
				return false;
			}
			if (!await this._canSelectWorkspace(item.folderUri, item.providerId)) {
				return false;
			}
			if (generation !== this._selectionGeneration) {
				return false;
			}
			this._selectFolder(item.folderUri);
			return true;
		}
		return false;
	}

	/**
	 * Emits `newChatPickerClosed` telemetry on user selection. The
	 * "before" value is read from storage (the currently-checked recent
	 * workspace) if available, otherwise from the in-memory selection.
	 * The "after" value comes from the item the user picked — undefined
	 * when the item is a browse action or command rather than a workspace.
	 */
	private _reportPickerClosed(item: IWorkspacePickerItem): void {
		const beforeFromStorage = this._restoreCheckedWorkspace();
		const before = beforeFromStorage ?? this._selectedResolved;
		const afterUri = item.folderUri;
		const afterResolved = afterUri ? this._resolveFolder(afterUri) : undefined;
		reportNewChatPickerClosed(this.telemetryService, {
			id: 'NewChatWorkspacePicker',
			name: 'NewChatWorkspacePicker',
			optionIdBefore: before?.workspace?.uri.toString(),
			optionIdAfter: afterResolved?.workspace?.uri.toString(),
			optionLabelBefore: before?.workspace?.label,
			optionLabelAfter: afterResolved?.workspace?.label,
			isPII: true,
		});
	}

	/**
	 * Programmatically set the selected workspace by folder URI.
	 * @param folderUri The folder URI to select.
	 * @param options.fireEvent Whether to fire the onDidSelectWorkspace event. Defaults to true.
	 * @param options.providerId Optional providerId hint that wins over any historical
	 *        recent entry's provider. Use when the caller knows which provider should
	 *        own the resulting session (e.g. "New Session" invoked from a workspace
	 *        section in the sessions list, where the existing sessions for the
	 *        workspace were created by a specific provider).
	 * @param options.persist Whether to persist the selection as a recent workspace. Defaults to true.
	 */
	setSelectedWorkspace(folderUri: URI, options?: { fireEvent?: boolean; providerId?: string; persist?: boolean }): void {
		this._selectFolder(folderUri, options?.fireEvent ?? true, options?.providerId, options?.persist ?? true);
	}

	/**
	 * Hides whichever popup variant is currently visible — the shared
	 * action-widget-service flat picker or our own context-view-driven
	 * tabbed picker.
	 */
	private _hidePicker(): void {
		this._tabbedWidget.hide();
		if (this.actionWidgetService.isVisible) {
			this.actionWidgetService.hide();
		}
	}

	/**
	 * Clears the selected project.
	 */
	clearSelection(): void {
		this._selectionGeneration++;
		this._hidePicker();
		this._userHasPicked = true;
		this._connectionStatusWatch.clear();
		this._selectedFolderUri = undefined;
		this._selectedResolved = undefined;
		if (this._shouldPersistSelection()) {
			this.recentWorkspacesService.clearCheckedWorkspace();
		}
		this._updateTriggerLabel();
		this._onDidChangeSelection.fire();
	}

	/**
	 * Clears the selection if it matches the given URI.
	 */
	removeFromRecents(uri: URI): void {
		if (this._selectedFolderUri && this.uriIdentityService.extUri.isEqual(this._selectedFolderUri, uri)) {
			this.clearSelection();
		}
	}

	private _selectFolder(folderUri: URI, fireEvent = true, providerIdHint?: string, persist = true): void {
		this._selectionGeneration++;
		this._userHasPicked = true;
		this._connectionStatusWatch.clear();
		// Prefer the caller-supplied providerId hint, then the historical
		// providerId stored in the recents for this URI, so re-picking a
		// Local Agent Host folder restores the Local Agent Host association
		// even when another provider also resolves the URI.
		const storedProviderId = this.recentWorkspacesService.getRecentWorkspaces()
			.find(r => this.uriIdentityService.extUri.isEqual(r.workspace.folders[0]?.root, folderUri))
			?.providerId;
		const resolved = this._resolveFolder(folderUri, providerIdHint ?? storedProviderId);
		this._selectedFolderUri = folderUri;
		this._selectedResolved = resolved;
		if (persist && this._shouldPersistSelection()) {
			this.recentWorkspacesService.addRecentWorkspace(folderUri, resolved?.providerId, true);
		}
		this._updateTriggerLabel();
		this._onDidChangeSelection.fire();
		if (fireEvent) {
			this._onDidSelectWorkspace.fire(folderUri);
		}
	}

	protected _shouldPersistSelection(): boolean {
		return true;
	}

	/**
	 * Apply a restored selection without firing events or persisting. Used
	 * during construction and after provider list changes.
	 */
	private _applySelection(resolved: IResolvedFolderWorkspace | undefined): void {
		this._selectedResolved = resolved;
		this._selectedFolderUri = resolved?.workspace.folders[0]?.root;
	}

	/**
	 * Iterate providers and return the first resolution of the folder URI.
	 * When `preferredProviderId` is given, that provider is tried first so a
	 * user's historical pick survives provider iteration order changes.
	 */
	private _resolveFolder(folderUri: URI, preferredProviderId?: string): IResolvedFolderWorkspace | undefined {
		if (preferredProviderId) {
			const preferred = this.sessionsProvidersService.getProvider(preferredProviderId);
			const workspace = preferred?.resolveWorkspace(folderUri);
			if (workspace) {
				return { providerId: preferredProviderId, workspace };
			}
		}
		for (const provider of this.sessionsProvidersService.getProviders()) {
			const workspace = provider.resolveWorkspace(folderUri);
			if (workspace) {
				return { providerId: provider.id, workspace };
			}
		}
		return undefined;
	}

	/**
	 * Executes a browse action from a provider, identified by index.
	 */
	private async _executeBrowseAction(actionIndex: number): Promise<IBrowsedWorkspaceSelection | undefined> {
		const allActions = this._getAllBrowseActions();
		const action = allActions[actionIndex];
		if (!action) {
			return undefined;
		}

		try {
			if (action === this._localBrowseAction) {
				return await this._browseForLocalFolder();
			}
			const workspace = await action.run();
			return workspace ? { workspace, providerId: action.providerId } : undefined;
		} catch {
			// browse action was cancelled or failed
		}
		return undefined;
	}

	private async _canSelectWorkspace(folderUri: URI, providerId: string | undefined): Promise<boolean> {
		return !this.options.canSelectWorkspace
			|| await this.options.canSelectWorkspace(folderUri, providerId);
	}

	/**
	 * Collects browse actions from all registered providers, scoped to the
	 * currently active tab when tabs are shown.
	 */
	protected _getAllBrowseActions(): ISessionWorkspaceBrowseAction[] {
		const all = this.sessionsProvidersService.getProviders().flatMap(p => p.browseActions);
		const hasLocalSupport = this.sessionsProvidersService.getProviders().some(p => p.supportsLocalWorkspaces);
		if (hasLocalSupport) {
			all.unshift(this._localBrowseAction);
		}
		if (!this._isTabFiltered()) {
			return all;
		}
		return all.filter(a => a.group === this._activeTab);
	}

	/**
	 * Opens a folder picker dialog and returns the chosen URI. The folder's
	 * provider is rediscovered later by the management service when the
	 * session is created — no provider quick-pick is needed here.
	 */
	private async _browseForLocalFolder(): Promise<IBrowsedWorkspaceSelection | undefined> {
		const localProviders = this.sessionsProvidersService.getProviders().filter(p => p.supportsLocalWorkspaces);
		if (localProviders.length === 0) {
			return undefined;
		}

		const result = await this.fileDialogService.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
		});
		if (!result?.length) {
			return undefined;
		}

		// Resolve through any local provider so the returned ISessionWorkspace
		// carries a label/icon for the browse-action handshake; the actual
		// provider used to create the session is rediscovered at creation time.
		for (const provider of localProviders) {
			const workspace = provider.resolveWorkspace(result[0]);
			if (workspace) {
				return { workspace, providerId: provider.id };
			}
		}
		return undefined;
	}

	/** True when the picker is currently scoped to a single tab. */
	protected _isTabFiltered(): boolean {
		return this._showTabs() && !!this._activeTab && this._getAvailableTabs().length > 1;
	}

	/**
	 * Builds the picker items list from recent workspaces.
	 *
	 * Items are shown in a flat recency-sorted list (most recently used first)
	 * without source grouping. Own recents come first, followed by VS Code
	 * recent folders.
	 */
	protected _buildItems(): IActionListItem<IWorkspacePickerItem>[] {
		const items: IActionListItem<IWorkspacePickerItem>[] = [];

		// Collect recent workspaces from picker storage across all providers
		const allProviders = this.sessionsProvidersService.getProviders();
		const providerIds = new Set(allProviders.map(p => p.id));
		const tabFilter = this._isTabFiltered()
			? (w: IResolvedFolderWorkspace) => w.workspace.group === this._activeTab
			: undefined;
		// Own recents first, then VS Code recents (merged and deduplicated by the service)
		const recentWorkspaces = this._getRecentWorkspaces()
			.filter(w => providerIds.has(w.providerId))
			.filter(w => !tabFilter || tabFilter(w));

		// Build flat list in recency order (no source grouping)
		for (const { workspace, providerId } of recentWorkspaces) {
			const folderUri = workspace.folders[0]?.root;
			if (!folderUri) {
				continue;
			}
			const selected = this._isSelectedFolder(folderUri);
			items.push({
				kind: ActionListItemKind.Action,
				label: workspace.label,
				description: workspace.description,
				group: { title: '', icon: workspace.icon },
				disabled: this._isProviderUnavailable(providerId),
				item: { folderUri, providerId, checked: selected || undefined },
				onRemove: () => this._removeRecentWorkspace(folderUri),
			});
		}

		// Browse actions from all providers (filtered to the active tab)
		const allBrowseActions = this._getAllBrowseActions();
		// Remote providers with connection status — shown as dynamic rows
		// in the Manage submenu on the Remote tab.
		const remoteProviders = allProviders.filter(isAgentHostProvider).filter(p => p.connectionStatus !== undefined);
		const includeRemoteProviders = this._activeTab === SESSION_WORKSPACE_GROUP_REMOTE;

		if (items.length > 0 && (allBrowseActions.length > 0)) {
			items.push({ kind: ActionListItemKind.Separator, label: '' });
		}

		// Render each browse action individually. Within a tab, actions are
		// already constrained to a single category, so cross-provider
		// merging is no longer meaningful.
		allBrowseActions.forEach((action, index) => {
			const provider = allProviders.find(p => p.id === action.providerId);
			const agentHostProvider = provider && isAgentHostProvider(provider) ? provider : undefined;
			const connectionStatus = agentHostProvider?.connectionStatus?.get();
			// `incompatible` always disables the action — the user can't fix
			// a protocol mismatch by clicking. Otherwise, if the provider
			// supports connect-on-demand (e.g. WSL boots the distro on first
			// browse), keep the action live even while disconnected.
			const isIncompatible = RemoteAgentHostConnectionStatus.isIncompatible(connectionStatus);
			const isUnavailable = isIncompatible
				|| (!!connectionStatus
					&& !RemoteAgentHostConnectionStatus.isConnected(connectionStatus)
					&& !agentHostProvider?.canConnectOnDemand);
			items.push({
				kind: ActionListItemKind.Action,
				label: localize('workspacePicker.browseSelectAction', "Select..."),
				description: action.description,
				group: { title: '', icon: action.icon },
				disabled: isUnavailable,
				item: { browseActionIndex: index },
			});
		});

		items.push({ kind: ActionListItemKind.Separator, label: '' });
		items.push({
			kind: ActionListItemKind.Action,
			label: localize('workspacePicker.workOutsideProject', "Travailler hors d'un projet"),
			description: localize('workspacePicker.workOutsideProjectDesc', "Chat standalone sans projet"),
			group: { title: '', icon: Codicon.commentDiscussion },
			item: {
				run: () => {
					this.clearSelection();
				}
			}
		});

		// Inline "Manage" entries: dynamic remote provider rows (scoped to
		// the Remote tab) + menu-contributed actions (filtered by the
		// `sessionWorkspacePickerGroup` context key).
		const manageActions: IAction[] = [];
		if (includeRemoteProviders) {
			for (const provider of remoteProviders) {
				const status = provider.connectionStatus!.get();
				const isTunnel = provider.remoteAddress?.startsWith(TUNNEL_ADDRESS_PREFIX);
				const action = toAction({
					id: `workspacePicker.remote.${provider.id}`,
					label: provider.label,
					tooltip: getStatusLabel(status),
					enabled: true,
					run: () => {
						this._hidePicker();
						this._showRemoteHostOptionsDelayed(provider);
					},
				});
				const extended = action as IWorkspacePickerAction;
				extended.icon = RemoteAgentHostConnectionStatus.isIncompatible(status)
					? Codicon.warning
					: (isTunnel ? Codicon.cloud : Codicon.remote);
				extended.hoverContent = getStatusHover(status, provider.remoteAddress);
				if (provider.remoteAddress) {
					extended.onRemove = async () => {
						await removeRemoteHost(provider, this.remoteAgentHostService);
					};
				}
				manageActions.push(action);
			}
		}

		const menuActions = this.menuService.getMenuActions(Menus.SessionWorkspaceManage, this.contextKeyService, { renderShortTitle: true });
		for (const [, actions] of menuActions) {
			for (const menuAction of actions) {
				if (menuAction instanceof MenuItemAction) {
					const icon = ThemeIcon.isThemeIcon(menuAction.item.icon) ? menuAction.item.icon : undefined;
					manageActions.push(Object.assign(menuAction, { icon }));
				}
			}
		}

		if (manageActions.length > 0) {
			if (items.length > 0 && items[items.length - 1].kind !== ActionListItemKind.Separator) {
				items.push({ kind: ActionListItemKind.Separator, label: '' });
			}
			for (const action of manageActions) {
				const extended = action as IWorkspacePickerAction;
				items.push({
					kind: ActionListItemKind.Action,
					label: action.label,
					description: extended.onRemove ? action.tooltip || undefined : undefined,
					group: { title: '', icon: extended.icon ?? Codicon.settingsGear },
					item: { run: () => action.run(), commandId: action.id },
					onRemove: extended.onRemove,
				});
			}
		}

		return items;
	}

	private _showRemoteHostOptionsDelayed(provider: IAgentHostSessionsProvider): void {
		// Defer one tick so the action widget fully tears down (focus/DOM cleanup)
		// before the QuickPick opens and claims focus.
		const timeout = setTimeout(() => {
			this.instantiationService.invokeFunction(accessor => showRemoteHostOptions(accessor, provider));
		}, 1);
		this._renderDisposables.add({ dispose: () => clearTimeout(timeout) });
	}

	protected _updateTriggerLabel(): void {
		for (const trigger of this._triggerElements) {
			this._renderTriggerLabel(trigger);
		}
	}

	protected _renderTriggerLabel(trigger: HTMLElement): void {
		dom.clearNode(trigger);
		const workspace = this._selectedResolved?.workspace;
		const folderUri = this._selectedFolderUri ?? workspace?.folders[0]?.root;
		const label = workspace ? workspace.label : (folderUri ? (this.uriIdentityService.extUri.basename(folderUri) || localize('pickWorkspace', "workspace")) : localize('noProject', "No Project"));
		const icon = workspace?.icon ?? Codicon.folder;

		trigger.setAttribute('aria-label', workspace || folderUri
			? localize('workspacePicker.selectedAriaLabel', "New session in {0}", label)
			: localize('workspacePicker.pickAriaLabel', "No Project"));

		dom.append(trigger, renderIcon(icon));
		const labelSpan = dom.append(trigger, dom.$('span.sessions-chat-dropdown-label'));
		labelSpan.textContent = label;
		dom.append(trigger, renderIcon(Codicon.chevronDownCompact)).classList.add('sessions-chat-dropdown-chevron');
	}

	/**
	 * Returns whether the given provider is a remote that is currently unavailable
	 * (incompatible, or disconnected/still connecting without on-demand connect).
	 * Returns false for providers without connection status (e.g. local providers).
	 */
	protected _isProviderUnavailable(providerId: string): boolean {
		const provider = this.sessionsProvidersService.getProvider(providerId);
		if (!provider || !isAgentHostProvider(provider) || !provider.connectionStatus) {
			return false;
		}
		const connectionStatus = provider.connectionStatus.get();
		return RemoteAgentHostConnectionStatus.isIncompatible(connectionStatus)
			|| (!RemoteAgentHostConnectionStatus.isConnected(connectionStatus) && !provider.canConnectOnDemand);
	}

	private async _connectProviderOnDemand(providerId: string): Promise<boolean> {
		const provider = this.sessionsProvidersService.getProvider(providerId);
		if (!provider || !isAgentHostProvider(provider) || !provider.connectionStatus) {
			return true;
		}
		const connectionStatus = provider.connectionStatus.get();
		if (RemoteAgentHostConnectionStatus.isConnected(connectionStatus)) {
			return true;
		}
		if (RemoteAgentHostConnectionStatus.isIncompatible(connectionStatus) || !provider.canConnectOnDemand || !provider.connect) {
			return false;
		}
		const initialMessage = localize('workspacePicker.connectingRemoteAgentHost', "Connecting to {0}...", provider.label);
		const handle = this.notificationService.notify({
			severity: Severity.Info,
			message: initialMessage,
			progress: { infinite: true },
		});
		status(initialMessage);
		const progressListener = provider.onDidReportConnectProgress?.(progress => {
			if (!provider.remoteAddress || progress.connectionKey === provider.remoteAddress) {
				handle.updateMessage(progress.message);
				status(progress.message);
			}
		});
		let connected = false;
		try {
			await provider.connect();
			connected = RemoteAgentHostConnectionStatus.isConnected(provider.connectionStatus.get());
		} catch {
		} finally {
			progressListener?.dispose();
			handle.close();
		}
		if (connected) {
			return true;
		}
		const message = localize('workspacePicker.connectRemoteAgentHostFailed', "Failed to connect to {0}.", provider.label);
		this.notificationService.error(message);
		status(message);
		return false;
	}

	protected _isSelectedFolder(folderUri: URI | undefined): boolean {
		if (!this._selectedFolderUri || !folderUri) {
			return false;
		}
		return this.uriIdentityService.extUri.isEqual(this._selectedFolderUri, folderUri);
	}

	private _restoreSelectedWorkspace(): IResolvedFolderWorkspace | undefined {
		// Try the checked entry first
		const checked = this._restoreCheckedWorkspace();
		if (checked) {
			return checked;
		}

		// Fall back to the first resolvable recent workspace from a connected provider.
		// Fallbacks (vs. the user's explicit checked pick) require the provider
		// to be ready: we don't want to silently land on, e.g., a disconnected
		// remote workspace that the user never picked. Restrict to the sessions'
		// own recent history (not VS Code's global recents) so restoration never
		// seeds a new session from a folder merely opened in another window.
		try {
			for (const recent of this.recentWorkspacesService.getRecentWorkspaces(false)) {
				if (this._isProviderUnavailable(recent.providerId)) {
					continue;
				}
				return recent;
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Restore only the checked (previously selected) workspace if any
	 * provider can resolve its URI. The provider's connection status is
	 * intentionally NOT checked — we honor the user's explicit pick even
	 * if the remote is still connecting or currently disconnected. The
	 * trigger label reflects the connection state separately
	 * (spinner / grayed).
	 */
	private _restoreCheckedWorkspace(): IResolvedFolderWorkspace | undefined {
		try {
			return this.recentWorkspacesService.getRecentWorkspaces(false).find(recent => recent.checked);
		} catch {
			return undefined;
		}
	}

	/**
	 * When restoring a workspace whose provider isn't currently Connected,
	 * watch the connection status. Fires `onDidSelectWorkspace(undefined)`
	 * (which the view pane converts to `unsetNewSession()`) if:
	 *   - the status transitions to Disconnected after we start watching, or
	 *   - the status is still not Connected after a short grace period.
	 *
	 * The grace period covers a race: provider state can transition synchronously
	 * inside provider registration before our autorun's first read, so we may
	 * never observe an explicit Disconnected transition. The timer ensures we
	 * eventually fall back instead of leaving the picker showing an unreachable
	 * remote with no session.
	 *
	 * Has no effect once the user makes an explicit pick (`_userHasPicked`).
	 */
	private _watchForConnectionFailure(resolved: IResolvedFolderWorkspace): void {
		const provider = this.sessionsProvidersService.getProvider(resolved.providerId);
		if (!provider || !isAgentHostProvider(provider) || !provider.connectionStatus) {
			return;
		}
		const connStatus = provider.connectionStatus;
		if (RemoteAgentHostConnectionStatus.isConnected(connStatus.get())) {
			return;
		}

		const folderUri = resolved.workspace.folders[0]?.root;
		if (!folderUri) {
			return;
		}

		const store = new DisposableStore();
		this._connectionStatusWatch.value = store;

		const fallback = () => {
			this._connectionStatusWatch.clear();
			if (!this._userHasPicked && this._isSelectedFolder(folderUri)) {
				this._selectedFolderUri = undefined;
				this._selectedResolved = undefined;
				this._updateTriggerLabel();
				this._onDidChangeSelection.fire();
				this._onDidSelectWorkspace.fire(undefined);
			}
		};

		let isFirstRun = true;
		store.add(autorun(reader => {
			const status = connStatus.read(reader);
			if (RemoteAgentHostConnectionStatus.isConnected(status)) {
				this._connectionStatusWatch.clear();
			} else if ((RemoteAgentHostConnectionStatus.isDisconnected(status) || RemoteAgentHostConnectionStatus.isIncompatible(status)) && !isFirstRun) {
				fallback();
			}
			isFirstRun = false;
		}));

		// Safety net: if the connection hasn't succeeded by the grace period,
		// fall back. Catches the case where the provider's status flips before
		// our autorun subscribes (so we never observe a transition).
		disposableTimeout(() => {
			if (!RemoteAgentHostConnectionStatus.isConnected(connStatus.get())) {
				fallback();
			}
		}, RESTORE_CONNECT_GRACE_MS, store);
	}

	// -- Recent workspaces (sessions' own history) --

	protected _getRecentWorkspaces(): IResolvedFolderWorkspace[] {
		return this.recentWorkspacesService.getRecentWorkspaces();
	}

	protected _removeRecentWorkspace(folderUri: URI): void {
		this.recentWorkspacesService.removeRecentWorkspace(folderUri);

		// Clear current selection if it was the removed workspace
		if (this._isSelectedFolder(folderUri)) {
			this._hidePicker();
			this._selectedFolderUri = undefined;
			this._selectedResolved = undefined;
			this._updateTriggerLabel();
			this._onDidSelectWorkspace.fire(undefined);
		}
	}

}
