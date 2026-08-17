/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatWidget.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { Action } from '../../../../base/common/actions.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { constObservable, derived, derivedObservableWithCache, autorun, IObservable, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { isWeb } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { localize } from '../../../../nls.js';
import { IActiveSession, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { IOpenNewSessionResult, ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IAquariumService, IMountedToggleHandle } from '../../aquarium/browser/aquariumOverlay.js';
import { WorkspacePicker } from './sessionWorkspacePicker.js';
import { WebWorkspacePicker } from './webWorkspacePicker.js';
import { IPreferredSessionType } from './sessionTypePicker.js';
import { NewChatInputWidget } from './newChatInput.js';
import { NoAgentHostEmptyState } from './noAgentHostEmptyState.js';
import { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { IAgentHostFilterService } from '../../../services/agentHostFilter/common/agentHostFilter.js';
import { IChatViewOptions } from '../../../browser/parts/chatView.js';
import { SessionWorkspacePickerVisibleContext } from '../../../common/contextkeys.js';
import { AGENT_FEEDBACK_NEW_SESSION_RESOURCE, AgentFeedbackState, IAgentFeedback, IAgentFeedbackService } from '../../agentFeedback/browser/agentFeedbackService.js';
import { buildNewSessionPrompt } from '../../agentFeedback/browser/agentFeedbackAttachmentEntry.js';
import { SessionInputBannerWidget } from '../../sessionInputBanners/browser/sessionInputBannerWidget.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { ChatTipContentPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/chatTipContentPart.js';
import { ChatContentMarkdownRenderer } from '../../../../workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { IChatPetService } from '../../../../workbench/contrib/chat/browser/chatPetService.js';
import { IChatTipService } from '../../../../workbench/contrib/chat/browser/chatTipService.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IFileService, FileKind } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { mainWindow } from '../../../../base/browser/window.js';

// #region --- New Chat Widget ---

export class NewChatWidget extends Disposable {

	public static activeInstance: NewChatWidget | undefined;
	private _showViewCallback?: (view: string) => void;

	public showView(view: string): void {
		this._showViewCallback?.(view);
	}

	private readonly _workspacePicker: WorkspacePicker;
	private readonly _newChatInput: NewChatInputWidget;
	private readonly _chatTipPart = this._register(new MutableDisposable<DisposableStore>());
	private _chatTipContainer: HTMLElement | undefined;
	private _isChatTipSessionInitialized = false;
	private _isInputOnboardingVisible = false;
	private _aquariumToggle: IMountedToggleHandle | undefined;

	/** Recreates the draft once a better/late-registering provider can serve the folder (see {@link _createNewSession}). */
	private readonly _pendingPreferredUpgrade = new MutableDisposable<IDisposable>();
	private readonly _newSessionCreation = new MutableDisposable<IDisposable>();

	/**
	 * The currently mounted no-agent-host empty state, if any. Set by
	 * {@link _renderEmptyStateGate} while the empty state replaces the
	 * workspace picker; consulted by {@link focusInput} to route focus to
	 * the visible heading instead of the (hidden) chat input.
	 */
	private _activeEmptyState: NoAgentHostEmptyState | undefined;

	/**
	 * Whether to render the session type ("harness") picker below the input
	 * (in the controls) instead of next to the workspace picker. Read once from
	 * the view options at construction time; the widget does not react to later
	 * changes of the source observable.
	 */
	private readonly _renderHarnessPickerInControls: boolean;

	private readonly _session: IObservable<IActiveSession | undefined>;

	/** Whether the active draft is a workspace-less quick chat (hides the workspace picker). */
	private readonly _isQuickChatComposer: IObservable<boolean>;

	/** Draft comments shared by every uncreated new-session composer. */
	private readonly _feedbackItems: IObservable<readonly IAgentFeedback[]>;

	/** In-flight background sends awaiting confirmation before their comments are cleared. */
	private readonly _pendingBackgroundSends = this._register(new DisposableMap<object>());

	/** The workspace-row container hosting the inline harness picker (desktop, non-quick-chat). */
	private _workspacePickerRow: HTMLElement | undefined;

	/** The quick-chat header row hosting the inline harness picker (desktop, quick chat). */
	private _quickChatHeaderPickerHost: HTMLElement | undefined;

	/**
	 * Tracks whether the workspace picker is currently rendered (vs replaced by
	 * the no-agent-host empty state on web). Consumed by the new-session-view
	 * onboarding tour to skip the workspace step when the picker is not shown.
	 */
	private readonly _workspacePickerVisibleKey: IContextKey<boolean>;

	private readonly _toolsTabs: { type: string, tabEl: HTMLElement, containerEl: HTMLElement, instance?: any, dispose: () => void, onBeforeContextMenu?: () => void, onAfterContextMenu?: () => void }[] = [];

	constructor(
		private readonly options: IChatViewOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IAquariumService private readonly aquariumService: IAquariumService,
		@IAgentHostFilterService private readonly agentHostFilterService: IAgentHostFilterService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IAgentFeedbackService private readonly agentFeedbackService: IAgentFeedbackService,
		@IChatPetService private readonly chatPetService: IChatPetService,
		@IChatTipService private readonly chatTipService: IChatTipService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();

		// Hide the top right global icons (Copilot, Layout, Profile, etc.)
		const style = document.createElement('style');
		style.textContent = `
			.monaco-workbench .part.titlebar .titlebar-right > *:not(.window-controls-container) {
				display: none !important;
			}
		`;
		document.head.appendChild(style);

		NewChatWidget.activeInstance = this;
		this._register(toDisposable(() => {
			if (NewChatWidget.activeInstance === this) {
				NewChatWidget.activeInstance = undefined;
			}
		}));
		this._workspacePickerVisibleKey = SessionWorkspacePickerVisibleContext.bindTo(contextKeyService);
		this._register(toDisposable(() => this._workspacePickerVisibleKey.reset()));
		this._renderHarnessPickerInControls = this.options.renderSessionTypePickerInControls.get();
		// On web (vscode.dev / insiders.vscode.dev), use {@link WebWorkspacePicker}
		// which scopes recents to the active host and renders as a bottom
		// sheet on phone-layout viewports. On Electron desktop, the regular
		// {@link WorkspacePicker} is fine — phones never run there.
		const PickerCtor = isWeb ? WebWorkspacePicker : WorkspacePicker;
		this._workspacePicker = this._register(this.instantiationService.createInstance(PickerCtor, {}));
		this._register(this._pendingPreferredUpgrade);
		this._register(this._newSessionCreation);

		// TODO: @sandy081 The session/chat should be passed down. There should not be sessionsService.activeSession read in the widget.
		this._session = derivedObservableWithCache<IActiveSession | undefined>(this, (reader, prev) => {
			const activeSession = this.sessionsService.activeSession.read(reader);
			if (activeSession && activeSession.isCreated.read(reader)) {
				return prev;
			}
			return activeSession;
		});

		// A quick chat is workspace-less; the composer hides the workspace picker
		// (nothing to pick) and surfaces the session-type picker in the controls.
		this._isQuickChatComposer = derived(this, reader => {
			const session = this._session.read(reader);
			return session?.isQuickChat?.read(reader) ?? false;
		});

		const feedbackChanged = observableSignalFromEvent(this, this.agentFeedbackService.onDidChangeFeedback);
		this._feedbackItems = derived(this, reader => {
			feedbackChanged.read(reader);
			return this.agentFeedbackService.getFeedback(AGENT_FEEDBACK_NEW_SESSION_RESOURCE)
				.filter(item => item.state === AgentFeedbackState.Accepted);
		});

		const canSendRequest = derived(reader => {
			const session = this._session.read(reader);
			if (!session) {
				return false;
			}
			if (session.loading.read(reader)) {
				return false;
			}
			return true;
		});

		const loading = derived(reader => {
			const session = this._session.read(reader);
			return session?.loading.read(reader) ?? false;
		});
		const hasFeedback = derived(this, reader => this._feedbackItems.read(reader).length > 0);
		const canSubmitWithoutSession = derived(this, reader => !this._session.read(reader) && hasFeedback.read(reader));

		const newChatInput = this.instantiationService.createInstance(NewChatInputWidget, {
			session: this._session,
			getContextFolderUri: () => this._getContextFolderUri(),
			sendRequest: async ({ query, attachments, background }) => this._send(query, attachments, background),
			canSendRequest,
			canSubmitWithoutSession,
			hasAdditionalSendContent: hasFeedback,
			loading,
			historyKey: constObservable(undefined), // no persisted history for the new-session view
			renderSessionTypePickerInControls: this._renderHarnessPickerInControls,
			supportsBackground: true,
			getInputOnboardingTipContainer: () => this._chatTipContainer,
			onDidChangeInputOnboardingVisible: visible => this.setInputOnboardingVisible(visible),
		});
		this._register(toDisposable(() => newChatInput.saveState()));
		this._newChatInput = this._register(newChatInput);

		// Comment 3: Bind Agent mode in the scoped context so that Agent-only tips
		// (messageQueueing, subagents, etc.) are eligible and chatModeKind-based
		// when-clauses evaluate correctly against this composer's actual mode.
		const chatModeKindKey = ChatContextKeys.chatModeKind.bindTo(contextKeyService);
		chatModeKindKey.set(ChatModeKind.Agent);
		this._register(toDisposable(() => chatModeKindKey.reset()));

		// Comment 4: Route tip command links to this composer's own pickers
		// so they do not fall through to IChatWidgetService.lastFocusedWidget
		// (which this composer is not registered with).
		this._register(this.openerService.registerOpener({
			open: async (resource: URI | string): Promise<boolean> => {
				if (!this._chatTipPart.value) {
					return false;
				}
				const link = typeof resource === 'string' ? resource : resource.toString();
				if (link === 'command:workbench.action.chat.openModelPicker') {
					this._newChatInput.openModelPicker();
					return true;
				}
				if (link === 'command:workbench.action.chat.openPlan') {
					// Plan mode is not available in the new-session composer; consume
					// the link without action so it does not misfire on a stale widget.
					return true;
				}
				return false;
			}
		}));

		this._register(this._workspacePicker.onDidSelectWorkspace(async folderUri => {
			await this._onWorkspaceSelected(folderUri);
			this._newChatInput.focus();

			// Reload terminal with new workspace folder
			const terminalTab = this._toolsTabs.find(t => t.type === 'terminal');
			if (terminalTab && terminalTab.instance) {
				terminalTab.instance.dispose();
				const newInst = await this.terminalService.createTerminal({ cwd: folderUri });
				terminalTab.instance = newInst;
				dom.clearNode(terminalTab.containerEl);
				newInst.attachToElement(terminalTab.containerEl);
				(terminalTab as any).attached = true;
				if (terminalTab.containerEl.style.display !== 'none') {
					newInst.setVisible(true);
				}
			}
		}));
		this._register(this._newChatInput.sessionTypePicker.onDidSelectSessionType(async pick => {
			// A quick chat has no folder: re-create the draft with the picked
			// type via openQuickChat (mirrors the folder path's draft recreation).
			if (this._isQuickChatComposer.get()) {
				this.sessionsService.openQuickChat(pick ? { providerId: pick.providerId, sessionTypeId: pick.sessionTypeId } : undefined);
				this._newChatInput.focus();
				return;
			}
			await this._onWorkspaceSelected(this._workspacePicker.selectedFolderUri);
			this._newChatInput.focus();
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration('chat.tips.enabled')) {
				return;
			}
			if (this.configurationService.getValue<boolean>('chat.tips.enabled')) {
				this._renderChatTip();
			} else {
				this._clearChatTip();
			}
		}));
		const foregroundSessionCountContextKeys = new Set([ChatContextKeys.foregroundSessionCount.key]);
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(foregroundSessionCountContextKeys)) {
				this._renderChatTip();
			}
		}));

		// Comment 2: Re-evaluate the tip when the selected model changes, because
		// some tips (e.g. tip.switchToAuto) are only eligible for specific models.
		let previousModelId: string | undefined;
		this._register(autorun(reader => {
			const modelId = this._newChatInput.selectedModelState.read(reader).currentModel?.identifier;
			if (previousModelId !== undefined && previousModelId !== modelId) {
				this._renderChatTip();
			}
			previousModelId = modelId;
		}));

		// Re-sync the picker's displayed selection when the session's workspace
		// changes externally (e.g. sessionsService.openNewSession({ folderUri })).
		this._register(autorun(reader => {
			const session = this._session.read(reader);
			const folderUri = session?.workspace.read(reader)?.folders[0]?.root;
			if (folderUri && !this.uriIdentityService.extUri.isEqual(folderUri, this._workspacePicker.selectedFolderUri)) {
				this._workspacePicker.setSelectedWorkspace(folderUri, { fireEvent: false });
			}
		}));
	}

	// --- Rendering ---

	render(parent: HTMLElement): void {
		const element = dom.append(parent, dom.$('.sessions-chat-widget'));
		element.style.display = 'flex';
		element.style.flexDirection = 'row';
		element.style.width = '100%';
		element.style.height = '100%';
		element.style.overflow = 'hidden';

		const leftPane = dom.append(element, dom.$('.sessions-chat-left-pane'));
		leftPane.style.position = 'relative';
		leftPane.style.flex = '1';
		leftPane.style.display = 'flex';
		leftPane.style.flexDirection = 'column';
		leftPane.style.minWidth = '0';
		leftPane.style.height = '100%';

		const chatWidgetContainer = dom.append(leftPane, dom.$('.new-chat-widget-container'));
		const chatWidgetContent = dom.append(chatWidgetContainer, dom.$('.new-chat-widget-content'));

		// --- Top Right Actions (Logo + Side Panel toggle) ---
		const topRightActions = dom.append(leftPane, dom.$('.new-chat-top-right-actions'));
		topRightActions.style.position = 'absolute';
		topRightActions.style.top = '14px';
		topRightActions.style.right = '18px';
		topRightActions.style.display = 'flex';
		topRightActions.style.alignItems = 'center';
		topRightActions.style.gap = '8px';
		topRightActions.style.zIndex = '30';

		const logoBtn = dom.append(topRightActions, dom.$('.new-chat-top-action-btn.logo-btn'));
		logoBtn.style.display = 'flex';
		logoBtn.style.alignItems = 'center';
		logoBtn.style.justifyContent = 'center';
		logoBtn.style.width = '30px';
		logoBtn.style.height = '30px';
		logoBtn.style.borderRadius = '6px';
		logoBtn.style.background = 'rgba(255, 255, 255, 0.04)';
		logoBtn.style.border = '1px solid rgba(255, 255, 255, 0.08)';
		logoBtn.style.cursor = 'pointer';
		logoBtn.style.color = '#ffffff';
		logoBtn.title = 'Antigravity';
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '16');
		svg.setAttribute('height', '16');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z');
		svg.appendChild(path);
		logoBtn.appendChild(svg);

		const panelBtn = dom.append(topRightActions, dom.$('.new-chat-top-action-btn.panel-btn'));
		panelBtn.style.display = 'flex';
		panelBtn.style.alignItems = 'center';
		panelBtn.style.justifyContent = 'center';
		panelBtn.style.width = '30px';
		panelBtn.style.height = '30px';
		panelBtn.style.borderRadius = '6px';
		panelBtn.style.background = 'rgba(255, 255, 255, 0.04)';
		panelBtn.style.border = '1px solid rgba(255, 255, 255, 0.08)';
		panelBtn.style.cursor = 'pointer';
		panelBtn.style.color = '#cccccc';
		panelBtn.title = 'Panneau latéral';
		panelBtn.appendChild(renderIcon(Codicon.layoutSidebarRight));

		// --- Conversation History Container ---
		const historyContainer = dom.append(leftPane, dom.$('.sessions-history-page-container'));
		historyContainer.style.display = 'none';
		historyContainer.style.flexDirection = 'column';
		historyContainer.style.width = '100%';
		historyContainer.style.height = '100%';
		historyContainer.style.alignItems = 'center';
		historyContainer.style.padding = '40px 20px';
		historyContainer.style.overflowY = 'auto';
		historyContainer.style.boxSizing = 'border-box';

		const renderHistory = () => {
			dom.clearNode(historyContainer);

			const styleEl = dom.append(historyContainer, dom.$('style'));
			styleEl.textContent = `
				.sessions-history-page-container::-webkit-scrollbar { width: 6px; }
				.sessions-history-page-container::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 3px; }
				.sessions-history-page-container::-webkit-scrollbar-track { background: transparent; }
			`;

			const wrapper = dom.append(historyContainer, dom.$('.custom-history-wrapper'));
			wrapper.style.width = '100%';
			wrapper.style.maxWidth = '700px';
			wrapper.style.display = 'flex';
			wrapper.style.flexDirection = 'column';
			
			const headerTitle = dom.append(wrapper, dom.$('h2'));
			headerTitle.textContent = 'Conversation History';
			headerTitle.style.fontSize = '16px';
			headerTitle.style.fontWeight = '600';
			headerTitle.style.marginBottom = '20px';
			headerTitle.style.color = '#e0e0e0';

			const searchRow = dom.append(wrapper, dom.$('.custom-history-search-row'));
			searchRow.style.display = 'flex';
			searchRow.style.gap = '8px';
			searchRow.style.marginBottom = '20px';
			
			const searchInputWrapper = dom.append(searchRow, dom.$('.custom-history-search-input-wrapper'));
			searchInputWrapper.style.flex = '1';
			searchInputWrapper.style.display = 'flex';
			searchInputWrapper.style.alignItems = 'center';
			searchInputWrapper.style.background = 'rgba(255, 255, 255, 0.04)';
			searchInputWrapper.style.borderRadius = '6px';
			searchInputWrapper.style.padding = '0 12px';
			searchInputWrapper.style.border = '1px solid rgba(255, 255, 255, 0.08)';
			
			const searchIcon = dom.append(searchInputWrapper, dom.$('span.codicon.codicon-search'));
			searchIcon.style.color = 'rgba(255, 255, 255, 0.4)';
			searchIcon.style.fontSize = '14px';
			searchIcon.style.marginRight = '8px';
			
			const searchInput = dom.append(searchInputWrapper, dom.$('input')) as HTMLInputElement;
			searchInput.type = 'text';
			searchInput.placeholder = 'Search conversations...';
			searchInput.style.flex = '1';
			searchInput.style.background = 'transparent';
			searchInput.style.border = 'none';
			searchInput.style.color = '#ffffff';
			searchInput.style.padding = '8px 0';
			searchInput.style.outline = 'none';
			
			const btnStyle = `
				display: flex;
				align-items: center;
				justify-content: center;
				width: 32px;
				height: 32px;
				border-radius: 6px;
				background: rgba(255, 255, 255, 0.04);
				border: 1px solid rgba(255, 255, 255, 0.08);
				color: rgba(255, 255, 255, 0.7);
				cursor: pointer;
			`;
			
			const filterBtn = dom.append(searchRow, dom.$('button'));
			filterBtn.style.cssText = btnStyle;
			dom.append(filterBtn, dom.$('span.codicon.codicon-filter'));
			
			const moreBtn = dom.append(searchRow, dom.$('button'));
			moreBtn.style.cssText = btnStyle;
			dom.append(moreBtn, dom.$('span.codicon.codicon-ellipsis'));
			
			const listContainer = dom.append(wrapper, dom.$('.custom-history-list'));
			listContainer.style.display = 'flex';
			listContainer.style.flexDirection = 'column';
			
			const sessions = this.sessionsManagementService.getSessions();
			const sortedSessions = sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
			
			const renderedItems: { element: HTMLElement, title: string }[] = [];

			for (const session of sortedSessions) {
				const item = dom.append(listContainer, dom.$('.custom-history-item'));
				item.style.display = 'flex';
				item.style.justifyContent = 'space-between';
				item.style.alignItems = 'center';
				item.style.padding = '12px 16px';
				item.style.cursor = 'pointer';
				item.style.borderRadius = '6px';
				item.style.borderBottom = '1px solid rgba(255, 255, 255, 0.03)';
				
				this._register(dom.addDisposableListener(item, dom.EventType.MOUSE_OVER, () => item.style.background = 'rgba(255, 255, 255, 0.05)'));
				this._register(dom.addDisposableListener(item, dom.EventType.MOUSE_OUT, () => item.style.background = 'transparent'));
				
				this._register(dom.addDisposableListener(item, dom.EventType.CLICK, () => {
					this.sessionsService.openSession(session.resource, { preserveFocus: false }).catch(onUnexpectedError);
				}));
				
				const titleSpan = dom.append(item, dom.$('span'));
				const titleText = session.title.get() || 'Untitled Conversation';
				titleSpan.textContent = titleText;
				titleSpan.style.color = '#cccccc';
				titleSpan.style.fontSize = '13px';
				
				const timeSpan = dom.append(item, dom.$('span'));
				const diffDays = Math.floor((Date.now() - session.createdAt.getTime()) / (1000 * 60 * 60 * 24));
				
				if (diffDays === 0) {
					timeSpan.style.width = '6px';
					timeSpan.style.height = '6px';
					timeSpan.style.borderRadius = '50%';
					timeSpan.style.background = '#007acc'; // blue dot
					timeSpan.style.marginRight = '8px';
				} else {
					let timeText = `${diffDays}d`;
					if (diffDays > 30) {
						timeText = `${Math.floor(diffDays / 30)}mo`;
					}
					timeSpan.textContent = timeText;
					timeSpan.style.color = 'rgba(255, 255, 255, 0.4)';
					timeSpan.style.fontSize = '12px';
				}

				renderedItems.push({ element: item, title: titleText });
			}

			this._register(dom.addDisposableListener(searchInput, 'input', () => {
				const filterText = searchInput.value.toLowerCase();
				for (const item of renderedItems) {
					if (item.title.toLowerCase().includes(filterText)) {
						item.element.style.display = 'flex';
					} else {
						item.element.style.display = 'none';
					}
				}
			}));
		};

		this._showViewCallback = (view: string) => {
			if (view === 'history') {
				chatWidgetContainer.style.setProperty('display', 'none', 'important');
				topRightActions.style.setProperty('display', 'none', 'important');
				historyContainer.style.setProperty('display', 'flex', 'important');
				renderHistory();
			} else {
				historyContainer.style.setProperty('display', 'none', 'important');
				topRightActions.style.setProperty('display', 'flex', 'important');
				chatWidgetContainer.style.setProperty('display', 'flex', 'important');
			}
		};

		// --- Agent Side Panel (Tools View) ---
		let agentSidePanel: HTMLElement | undefined;
		let toolsHeader: HTMLElement | undefined;
		let toolsTabsContainer: HTMLElement | undefined;
		let toolsContent: HTMLElement | undefined;
		let toolsViewContainer: HTMLElement | undefined;
		let resizeHandle: HTMLElement | undefined;
		
		const tabs = this._toolsTabs;

		const restoreMainView = () => {
			if (toolsViewContainer) {
				toolsViewContainer.style.display = 'none';
			}
			if (resizeHandle) {
				resizeHandle.style.display = 'none';
			}
		};

		this._register(dom.addDisposableListener(panelBtn, dom.EventType.CLICK, () => {
			if (toolsViewContainer && toolsViewContainer.style.display !== 'none') {
				restoreMainView();
			} else {
				showToolsView();
			}
		}));

		const showToolsView = () => {
			if (!toolsViewContainer) {
				resizeHandle = dom.append(element, dom.$('.agent-side-panel-resize-handle'));
				resizeHandle.style.width = '4px';
				resizeHandle.style.cursor = 'col-resize';
				resizeHandle.style.background = 'transparent';
				resizeHandle.style.zIndex = '100';

				toolsViewContainer = dom.append(element, dom.$('.agent-side-panel-wrapper'));
				toolsViewContainer.style.display = 'flex';
				toolsViewContainer.style.flex = 'none';
				toolsViewContainer.style.width = '50%';
				toolsViewContainer.style.minWidth = '250px';
				toolsViewContainer.style.maxWidth = '80%';
				toolsViewContainer.style.borderLeft = '1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08))';

				// Drag logic for resizer
				let startX = 0;
				let startWidth = 0;
				this._register(dom.addDisposableListener(resizeHandle, dom.EventType.MOUSE_DOWN, (e: MouseEvent) => {
					startX = e.clientX;
					startWidth = toolsViewContainer!.getBoundingClientRect().width;
					
					const onMouseMove = (e: MouseEvent) => {
						const diff = startX - e.clientX;
						let newWidth = startWidth + diff;
						const totalWidth = element.getBoundingClientRect().width;
						if (newWidth < 250) newWidth = 250;
						if (newWidth > totalWidth * 0.8) newWidth = totalWidth * 0.8;
						toolsViewContainer!.style.width = `${newWidth}px`;
					};
					
					const onMouseUp = () => {
						document.removeEventListener('mousemove', onMouseMove);
						document.removeEventListener('mouseup', onMouseUp);
					};
					
					document.addEventListener('mousemove', onMouseMove);
					document.addEventListener('mouseup', onMouseUp);
				}));

				agentSidePanel = dom.append(toolsViewContainer, dom.$('.agent-side-panel'));
				agentSidePanel.style.display = 'flex';
				agentSidePanel.style.flexDirection = 'column';
				agentSidePanel.style.width = '100%';
				agentSidePanel.style.height = '100%';
				agentSidePanel.style.background = 'var(--vscode-sideBar-background, var(--vscode-editor-background))';

				toolsHeader = dom.append(agentSidePanel, dom.$('.agent-side-panel-tools-header'));
				toolsHeader.style.display = 'flex';
				toolsHeader.style.alignItems = 'center';
				toolsHeader.style.justifyContent = 'space-between';
				toolsHeader.style.padding = '8px 16px';
				toolsHeader.style.borderBottom = '1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.05))';
				toolsHeader.style.marginBottom = '8px';
				
				toolsTabsContainer = dom.append(toolsHeader, dom.$('.agent-side-panel-tools-tabs'));
				toolsTabsContainer.style.display = 'flex';
				toolsTabsContainer.style.alignItems = 'center';
				toolsTabsContainer.style.overflowX = 'auto';
				
				const addBtn = dom.append(toolsHeader, dom.$('.agent-side-panel-tools-btn'));
				addBtn.style.cursor = 'pointer';
				addBtn.style.padding = '4px';
				addBtn.style.opacity = '0.7';
				const addIcon = dom.append(addBtn, dom.$('span.codicon.codicon-add'));
				addIcon.style.fontSize = '14px';
				this._register(dom.addDisposableListener(addBtn, dom.EventType.CLICK, (e) => {
					e.preventDefault();
					e.stopPropagation();
					
					const activeTab = tabs.find(t => t.containerEl.style.display !== 'none');
					if (activeTab && activeTab.onBeforeContextMenu) {
						activeTab.onBeforeContextMenu();
					}
					
					// Create custom popup overlay
					const popup = dom.$('.agent-side-panel-custom-popup');
					popup.style.position = 'fixed';
					popup.style.zIndex = '999999999'; // Very high z-index
					popup.style.background = '#252526';
					popup.style.border = '1px solid rgba(255, 255, 255, 0.1)';
					popup.style.borderRadius = '6px';
					popup.style.padding = '4px';
					popup.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
					popup.style.fontFamily = 'var(--vscode-font-family)';
					popup.style.fontSize = '11px';
					popup.style.color = '#cccccc';
					popup.style.display = 'flex';
					popup.style.alignItems = 'center';
					popup.style.gap = '4px';

					const rect = addBtn.getBoundingClientRect();
					// Position to the right of the + button
					popup.style.top = `${rect.top - 2}px`;
					popup.style.left = `${rect.right + 8}px`;

					const createItem = (iconClass: string, label: string, onClick: () => void) => {
						const item = dom.append(popup, dom.$('.agent-side-panel-custom-popup-item'));
						item.style.display = 'flex';
						item.style.alignItems = 'center';
						item.style.padding = '4px 8px';
						item.style.cursor = 'pointer';
						item.style.borderRadius = '4px';

						item.addEventListener('mouseenter', () => {
							item.style.background = 'var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.1))';
							item.style.color = 'var(--vscode-list-hoverForeground, #ffffff)';
						});
						item.addEventListener('mouseleave', () => {
							item.style.background = 'transparent';
							item.style.color = '#cccccc';
						});

						const icon = dom.append(item, dom.$(`span.codicon.codicon-${iconClass}`));
						icon.style.marginRight = '6px';
						icon.style.fontSize = '13px';
						
						const text = dom.append(item, dom.$('span'));
						text.textContent = label;

						item.addEventListener('click', (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							closePopup();
							onClick();
						});
					};

					createItem('terminal', 'Terminal', async () => {
						const newInst = await this.terminalService.createTerminal();
						addToolTab('terminal', newInst);
					});
					createItem('globe', 'Navigateur', () => addToolTab('browser'));
					createItem('folder', 'Fichiers', () => addToolTab('files'));

					document.body.appendChild(popup);

					let isClosed = false;
					const closePopup = () => {
						if (isClosed) return;
						isClosed = true;
						popup.remove();
						document.removeEventListener('click', outsideClickListener);
						window.removeEventListener('resize', closePopup);
						if (activeTab && activeTab.onAfterContextMenu) {
							activeTab.onAfterContextMenu();
						}
					};

					const outsideClickListener = (ev: MouseEvent) => {
						if (!popup.contains(ev.target as Node)) {
							closePopup();
						}
					};

					setTimeout(() => {
						document.addEventListener('click', outsideClickListener);
						window.addEventListener('resize', closePopup);
					}, 0);
				}));

				const closeAllBtn = dom.append(toolsHeader, dom.$('.agent-side-panel-tools-close'));
				closeAllBtn.style.cursor = 'pointer';
				closeAllBtn.style.padding = '4px';
				closeAllBtn.style.opacity = '0.7';
				closeAllBtn.style.marginLeft = 'auto';
				const closeIcon = dom.append(closeAllBtn, dom.$('span.codicon.codicon-close'));
				closeIcon.style.fontSize = '14px';
				this._register(dom.addDisposableListener(closeAllBtn, dom.EventType.CLICK, () => {
					for (const t of [...tabs]) {
						t.dispose();
						t.tabEl.remove();
						t.containerEl.remove();
					}
					tabs.length = 0;
					restoreMainView();
				}));

				toolsContent = dom.append(agentSidePanel, dom.$('.agent-side-panel-tools-content'));
				toolsContent.style.flex = '1';
				toolsContent.style.display = 'flex';
				toolsContent.style.flexDirection = 'column';
				toolsContent.style.width = '100%';
				toolsContent.style.minHeight = '0';
				toolsContent.style.overflow = 'hidden';
				toolsContent.style.position = 'relative';

				// --- Empty State for Side Panel ---
				const emptyState = dom.append(toolsContent, dom.$('.agent-side-panel-empty'));
				emptyState.style.display = 'flex';
				emptyState.style.flexDirection = 'column';
				emptyState.style.alignItems = 'center';
				emptyState.style.justifyContent = 'center';
				emptyState.style.height = '100%';
				emptyState.style.gap = '8px';
				emptyState.style.padding = '32px';

				const createBigBtn = (iconClass: string, label: string, shortcut: string, onClick: () => void) => {
					const btn = dom.append(emptyState, dom.$('.agent-side-panel-big-btn'));
					btn.style.display = 'flex';
					btn.style.alignItems = 'center';
					btn.style.justifyContent = 'space-between';
					btn.style.width = '100%';
					btn.style.maxWidth = '300px';
					btn.style.padding = '10px 14px';
					btn.style.background = '#1e1e1e';
					btn.style.border = '1px solid rgba(255, 255, 255, 0.04)';
					btn.style.borderRadius = '6px';
					btn.style.cursor = 'pointer';
					btn.style.color = '#cccccc';
					btn.style.transition = 'background-color 0.15s ease';

					const leftGroup = dom.append(btn, dom.$('.agent-side-panel-btn-left'));
					leftGroup.style.display = 'flex';
					leftGroup.style.alignItems = 'center';
					leftGroup.style.gap = '12px';

					const icon = dom.append(leftGroup, dom.$(`span.codicon.codicon-${iconClass}`));
					icon.style.fontSize = '16px';

					const text = dom.append(leftGroup, dom.$('span'));
					text.textContent = label;
					text.style.fontWeight = '400';
					text.style.fontSize = '13px';

					if (shortcut) {
						const shortcutBadge = dom.append(btn, dom.$('.agent-side-panel-btn-shortcut'));
						shortcutBadge.textContent = shortcut;
						shortcutBadge.style.fontSize = '11px';
						shortcutBadge.style.color = '#71717a';
						shortcutBadge.style.background = 'rgba(255, 255, 255, 0.05)';
						shortcutBadge.style.padding = '2px 6px';
						shortcutBadge.style.borderRadius = '4px';
						shortcutBadge.style.fontWeight = '500';
					}

					this._register(dom.addDisposableListener(btn, dom.EventType.MOUSE_OVER, () => {
						btn.style.background = '#252526';
						btn.style.color = '#ffffff';
					}));
					this._register(dom.addDisposableListener(btn, dom.EventType.MOUSE_OUT, () => {
						btn.style.background = '#1e1e1e';
						btn.style.color = '#cccccc';
					}));

					this._register(dom.addDisposableListener(btn, dom.EventType.CLICK, onClick));
				};

				createBigBtn('terminal', 'Terminal', 'Ctrl+`', async () => {
					const newInst = await this.terminalService.createTerminal();
					addToolTab('terminal', newInst);
				});
				createBigBtn('globe', 'Navigateur', 'Ctrl+T', () => addToolTab('browser'));
				createBigBtn('folder', 'Fichiers', 'Ctrl+P', () => addToolTab('files'));

				// Hide empty state when a tab is opened
				const observer = new MutationObserver(() => {
					if (tabs.length === 0) {
						emptyState.style.display = 'flex';
					} else {
						emptyState.style.display = 'none';
					}
				});
				observer.observe(toolsTabsContainer, { childList: true });
				this._register(toDisposable(() => observer.disconnect()));

			} else {
				toolsViewContainer.style.display = 'flex';
				if (resizeHandle) resizeHandle.style.display = 'block';
			}
		};

		const activateTab = (tabObj: any) => {
			for (const t of tabs) {
				t.tabEl.style.backgroundColor = 'transparent';
				t.containerEl.style.display = 'none';
				if (t.type === 'browser' && (t as any).hideBrowser) {
					(t as any).hideBrowser();
				}
				if (t.type === 'terminal' && t.instance) {
					t.instance.setVisible(false);
				}
			}
			tabObj.tabEl.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
			tabObj.containerEl.style.display = 'flex';
			
			if (tabObj.type === 'terminal' && tabObj.instance) {
				if (!tabObj.attached) {
					tabObj.instance.attachToElement(tabObj.containerEl);
					tabObj.attached = true;
				}
				tabObj.instance.setVisible(true);
			} else if (tabObj.type === 'browser' && tabObj.showBrowser) {
				tabObj.showBrowser();
			}
		};

		const addToolTab = (type: 'terminal' | 'browser' | 'files', instance?: any) => {
			showToolsView();

			const tabEl = dom.append(toolsTabsContainer!, dom.$('.agent-side-panel-tools-tab'));
			tabEl.style.display = 'flex';
			tabEl.style.alignItems = 'center';
			tabEl.style.padding = '4px 8px';
			tabEl.style.cursor = 'pointer';
			tabEl.style.borderRadius = '4px';
			tabEl.style.marginRight = '4px';

			let iconClass = 'terminal';
			let labelText = 'powershell';
			if (type === 'browser') {
				iconClass = 'globe';
				labelText = 'Browser';
			} else if (type === 'files') {
				iconClass = 'folder';
				labelText = 'Files';
			}

			let disposeFn: () => void = () => {
				if (type === 'terminal' && instance) {
					instance.dispose();
				}
			};
			let onBeforeContextMenu = () => {};
			let onAfterContextMenu = () => {};
			let hideBrowser = () => {};
			let showBrowser = () => {};

			const icon = dom.append(tabEl, dom.$(`span.codicon.codicon-${iconClass}`));
			icon.style.marginRight = '6px';
			icon.style.fontSize = '12px';
			
			const label = dom.append(tabEl, dom.$('span'));
			label.textContent = labelText;
			label.style.fontSize = '12px';
			
			const tabClose = dom.append(tabEl, dom.$('span.codicon.codicon-close'));
			tabClose.style.marginLeft = '6px';
			tabClose.style.fontSize = '12px';
			tabClose.style.opacity = '0';
			tabClose.style.transition = 'opacity 0.1s';

			this._register(dom.addDisposableListener(tabEl, dom.EventType.MOUSE_OVER, () => tabClose.style.opacity = '0.7'));
			this._register(dom.addDisposableListener(tabEl, dom.EventType.MOUSE_OUT, () => {
				if (tabEl.style.backgroundColor === 'transparent') {
					tabClose.style.opacity = '0';
				}
			}));
			this._register(dom.addDisposableListener(tabClose, dom.EventType.MOUSE_OVER, () => tabClose.style.opacity = '1'));
			
			const containerEl = dom.append(toolsContent!, dom.$('.agent-side-panel-tool-container'));
			containerEl.style.flex = '1';
			containerEl.style.display = 'none';
			containerEl.style.flexDirection = 'column';
			containerEl.style.width = '100%';
			containerEl.style.height = '100%';

			if (type === 'terminal' && instance) {
				// Terminal attachment is deferred to activateTab
			} else if (type === 'browser') {
				const bar = dom.append(containerEl, dom.$('.browser-bar'));
				bar.style.display = 'flex';
				bar.style.padding = '8px';
				bar.style.gap = '8px';
				bar.style.alignItems = 'center';

				const createBtn = (iconClass: string, title: string) => {
					const btn = dom.append(bar, dom.$('button'));
					btn.title = title;
					btn.style.background = 'transparent';
					btn.style.color = 'var(--vscode-icon-foreground)';
					btn.style.border = 'none';
					btn.style.cursor = 'pointer';
					btn.style.display = 'flex';
					btn.style.alignItems = 'center';
					btn.style.justifyContent = 'center';
					btn.style.width = '24px';
					btn.style.height = '24px';
					
					const icon = dom.append(btn, dom.$('i'));
					icon.className = `codicon ${iconClass}`;
					return btn;
				};

				const backBtn = createBtn('codicon-arrow-left', 'Back');
				const forwardBtn = createBtn('codicon-arrow-right', 'Forward');
				const reloadBtn = createBtn('codicon-refresh', 'Reload');

				const favoriteBtn = createBtn('codicon-star-empty', 'Add Bookmark');
				
				const getFavorites = (): Set<string> => {
					try {
						const data = localStorage.getItem('chatBrowserFavorites');
						return new Set(data ? JSON.parse(data) : []);
					} catch {
						return new Set();
					}
				};
				const saveFavorites = (favs: Set<string>) => {
					localStorage.setItem('chatBrowserFavorites', JSON.stringify(Array.from(favs)));
				};

				let currentFavorites = getFavorites();

				const updateFavoriteIcon = (url: string) => {
					const icon = favoriteBtn.querySelector('.codicon') as HTMLElement;
					if (icon) {
						icon.className = currentFavorites.has(url) ? 'codicon codicon-star-full' : 'codicon codicon-star-empty';
					}
				};

				const inputWrapper = dom.append(bar, dom.$('.browser-input-wrapper'));
				inputWrapper.style.flex = '1';
				inputWrapper.style.position = 'relative';
				inputWrapper.style.display = 'flex';
				inputWrapper.style.alignItems = 'center';
				
				const browserInput = dom.append(inputWrapper, dom.$('input')) as HTMLInputElement;
				browserInput.type = 'text';
				browserInput.placeholder = 'Saisir une URL';

				favoriteBtn.addEventListener('click', () => {
					const val = browserInput.value.trim();
					if (!val) return;
					if (currentFavorites.has(val)) {
						currentFavorites.delete(val);
					} else {
						currentFavorites.add(val);
					}
					saveFavorites(currentFavorites);
					updateFavoriteIcon(val);
				});
				browserInput.style.flex = '1';
				browserInput.style.background = 'rgba(255, 255, 255, 0.1)';
				browserInput.style.border = 'none';
				browserInput.style.color = 'inherit';
				browserInput.style.padding = '4px 28px 4px 8px';
				browserInput.style.borderRadius = '4px';
				browserInput.style.minWidth = '0';
				browserInput.style.outline = 'none';

				this._register(dom.addDisposableListener(browserInput, dom.EventType.CLICK, () => browserInput.select()));

				const chromeBtn = dom.append(inputWrapper, dom.$('.chrome-open-btn'));
				chromeBtn.style.position = 'absolute';
				chromeBtn.style.right = '4px';
				chromeBtn.style.width = '20px';
				chromeBtn.style.height = '20px';
				chromeBtn.style.display = 'none';
				chromeBtn.style.alignItems = 'center';
				chromeBtn.style.justifyContent = 'center';
				chromeBtn.style.cursor = 'pointer';
				// SVG using DOM API instead of innerHTML
				const svgNS = 'http://www.w3.org/2000/svg';
				const svg = document.createElementNS(svgNS, 'svg');
				svg.setAttribute('preserveAspectRatio', 'xMidYMid');
				svg.setAttribute('viewBox', '0 0 190.5 190.5');
				svg.setAttribute('width', '14');
				svg.setAttribute('height', '14');

				const paths = [
					{ fill: '#fff', d: 'M95.252 142.873c26.304 0 47.627-21.324 47.627-47.628s-21.323-47.628-47.627-47.628-47.627 21.324-47.627 47.628 21.323 47.628 47.627 47.628z' },
					{ fill: '#229342', d: 'm54.005 119.07-41.24-71.43a95.227 95.227 0 0 0-.003 95.25 95.234 95.234 0 0 0 82.496 47.61l41.24-71.43v-.011a47.613 47.613 0 0 1-17.428 17.443 47.62 47.62 0 0 1-47.632.007 47.62 47.62 0 0 1-17.433-17.437z' },
					{ fill: '#fbc116', d: 'm136.495 119.067-41.239 71.43a95.229 95.229 0 0 0 82.489-47.622A95.24 95.24 0 0 0 190.5 95.248a95.237 95.237 0 0 0-12.772-47.623H95.249l-.01.007a47.62 47.62 0 0 1 23.819 6.372 47.618 47.618 0 0 1 17.439 17.431 47.62 47.62 0 0 1-.001 47.633z' },
					{ fill: '#1a73e8', d: 'M95.252 132.961c20.824 0 37.705-16.881 37.705-37.706S116.076 57.55 95.252 57.55 57.547 74.431 57.547 95.255s16.881 37.706 37.705 37.706z' },
					{ fill: '#e33b2e', d: 'M95.252 47.628h82.479A95.237 95.237 0 0 0 142.87 12.76 95.23 95.23 0 0 0 95.245 0a95.222 95.222 0 0 0-47.623 12.767 95.23 95.23 0 0 0-34.856 34.872l41.24 71.43.011.006a47.62 47.62 0 0 1-.015-47.633 47.61 47.61 0 0 1 41.252-23.815z' }
				];
				for (const p of paths) {
					const pathEl = document.createElementNS(svgNS, 'path');
					pathEl.setAttribute('fill', p.fill);
					pathEl.setAttribute('d', p.d);
					svg.appendChild(pathEl);
				}
				chromeBtn.appendChild(svg);

				inputWrapper.addEventListener('mouseenter', () => chromeBtn.style.display = 'flex');
				inputWrapper.addEventListener('mouseleave', () => chromeBtn.style.display = 'none');

				chromeBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					const val = browserInput.value.trim();
					if (val) {
						let url = val;
						if (!val.startsWith('http://') && !val.startsWith('https://')) {
							if (val.includes('.') && !val.includes(' ')) {
								url = 'https://' + val;
							} else {
								url = 'https://www.google.com/search?q=' + encodeURIComponent(val);
							}
						}
						
						try {
							const parsedUrl = new URL(url);
							if (parsedUrl.hostname.includes('google.')) {
								parsedUrl.searchParams.delete('igu');
								url = parsedUrl.toString();
							}
						} catch (e) {
							// Ignore invalid URLs
						}
						
						this.openerService.open(URI.parse(url), { openExternal: true, skipValidation: true });
					}
				});

				const devToolsBtn = createBtn('codicon-inspect', 'Developer Tools');
				devToolsBtn.style.display = 'none';
				devToolsBtn.addEventListener('click', () => {
					if (browserModel) browserModel.toggleDevTools();
				});

				const moreBtn = createBtn('codicon-more', 'Plus');
				const historyBtn = createBtn('codicon-history', 'Historique');

				let updateBounds: () => void = () => {};

				const historyPopup = dom.append(containerEl, dom.$('.browser-history-menu'));
				historyPopup.style.position = 'absolute';
				historyPopup.style.top = '40px';
				historyPopup.style.right = '8px';
				historyPopup.style.width = '240px';
				historyPopup.style.backgroundColor = '#1e1e1e';
				historyPopup.style.border = '1px solid #454545';
				historyPopup.style.borderRadius = '6px';
				historyPopup.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
				historyPopup.style.zIndex = '1000';
				historyPopup.style.display = 'none';
				historyPopup.style.flexDirection = 'column';
				historyPopup.style.padding = '8px';
				historyPopup.style.fontSize = '12px';
				historyPopup.style.color = '#cccccc';

				const historySearchBox = dom.append(historyPopup, dom.$('.search-box'));
				historySearchBox.style.display = 'flex';
				historySearchBox.style.alignItems = 'center';
				historySearchBox.style.backgroundColor = '#252526';
				historySearchBox.style.padding = '4px 8px';
				historySearchBox.style.borderRadius = '4px';
				historySearchBox.style.border = '1px solid #454545';
				historySearchBox.style.marginBottom = '8px';
				
				const searchIcon = dom.append(historySearchBox, dom.$('i'));
				searchIcon.className = 'codicon codicon-search';
				searchIcon.style.color = '#888';
				searchIcon.style.marginRight = '6px';
				
				const historySearchInput = dom.append(historySearchBox, dom.$('input')) as HTMLInputElement;
				historySearchInput.type = 'text';
				historySearchInput.placeholder = 'Search';
				historySearchInput.style.background = 'transparent';
				historySearchInput.style.border = 'none';
				historySearchInput.style.color = '#cccccc';
				historySearchInput.style.outline = 'none';
				historySearchInput.style.flex = '1';

				const historyContent = dom.append(historyPopup, dom.$('.content'));
				historyContent.style.display = 'flex';
				historyContent.style.flexDirection = 'column';
				historyContent.style.overflowY = 'auto';
				historyContent.style.maxHeight = '350px';

				const menuPopup = dom.append(containerEl, dom.$('.browser-more-menu'));
				menuPopup.style.position = 'absolute';
				menuPopup.style.top = '40px';
				menuPopup.style.right = '8px';
				menuPopup.style.width = '240px';
				menuPopup.style.backgroundColor = '#1e1e1e';
				menuPopup.style.border = '1px solid #454545';
				menuPopup.style.borderRadius = '6px';
				menuPopup.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
				menuPopup.style.zIndex = '1000';
				menuPopup.style.display = 'none';
				menuPopup.style.flexDirection = 'column';
				menuPopup.style.padding = '4px 0';
				menuPopup.style.fontSize = '12px';
				menuPopup.style.color = '#cccccc';

				const createDivider = () => {
					const divider = dom.append(menuPopup, dom.$('.divider'));
					divider.style.height = '1px';
					divider.style.backgroundColor = '#454545';
					divider.style.margin = '4px 0';
				};

				const createMenuItem = (text: string, onClick?: (e: MouseEvent) => void, extraContent?: HTMLElement) => {
					const item = dom.append(menuPopup, dom.$('.menu-item'));
					item.style.display = 'flex';
					item.style.alignItems = 'center';
					item.style.padding = '6px 12px';
					item.style.cursor = 'pointer';
					item.style.userSelect = 'none';
					
					const label = dom.append(item, dom.$('span'));
					label.textContent = text;
					label.style.flex = '1';

					if (extraContent) {
						item.appendChild(extraContent);
					}

					item.addEventListener('mouseenter', () => item.style.backgroundColor = '#2a2d2e');
					item.addEventListener('mouseleave', () => item.style.backgroundColor = 'transparent');

					if (onClick) {
						item.addEventListener('click', (e) => {
							e.stopPropagation();
							onClick(e);
						});
					}
					return item;
				};

				const showImagePreview = (uint8: Uint8Array, mimeType: string) => {
					const dataUrl = (() => {
						let binary = '';
						for (let i = 0; i < uint8.byteLength; i++) {
							binary += String.fromCharCode(uint8[i]);
						}
						return `data:${mimeType};base64,${btoa(binary)}`;
					})();

					// Determine target: leftPane when browser panel is open, full screen when closed
					const browserOpen = containerEl.isConnected && containerEl.offsetParent !== null;
					const target: HTMLElement = browserOpen ? leftPane : document.body;
					const isFixed = !browserOpen;

					// Remove any existing preview
					const existing = target.querySelector('.screenshot-preview-overlay') as HTMLElement | null;
					if (existing) { existing.remove(); }

					const overlay = dom.append(target, dom.$('.screenshot-preview-overlay')) as HTMLElement;
					overlay.style.position = isFixed ? 'fixed' : 'absolute';
					overlay.style.top = '0';
					overlay.style.left = '0';
					overlay.style.width = isFixed ? '100vw' : '100%';
					overlay.style.height = isFixed ? '100vh' : '100%';
					overlay.style.backgroundColor = 'rgba(0,0,0,0.82)';
					overlay.style.zIndex = '9000';
					overlay.style.display = 'flex';
					overlay.style.flexDirection = 'column';
					overlay.style.alignItems = 'center';
					overlay.style.justifyContent = 'center';
					overlay.style.gap = '12px';
					overlay.style.backdropFilter = 'blur(6px)';

					const closeBtn = dom.append(overlay, dom.$('button')) as HTMLButtonElement;
					closeBtn.textContent = '✕';
					closeBtn.style.position = 'absolute';
					closeBtn.style.top = '12px';
					closeBtn.style.right = '14px';
					closeBtn.style.background = 'rgba(255,255,255,0.1)';
					closeBtn.style.border = 'none';
					closeBtn.style.color = '#fff';
					closeBtn.style.fontSize = '18px';
					closeBtn.style.width = '32px';
					closeBtn.style.height = '32px';
					closeBtn.style.borderRadius = '50%';
					closeBtn.style.cursor = 'pointer';
					closeBtn.style.lineHeight = '30px';
					closeBtn.style.textAlign = 'center';
					closeBtn.title = 'Fermer';

					const img = dom.append(overlay, dom.$('img')) as HTMLImageElement;
					img.src = dataUrl;
					img.style.maxWidth = '90%';
					img.style.maxHeight = 'calc(100% - 60px)';
					img.style.borderRadius = '8px';
					img.style.boxShadow = '0 8px 40px rgba(0,0,0,0.7)';
					img.style.objectFit = 'contain';

					const label = dom.append(overlay, dom.$('div')) as HTMLElement;
					label.textContent = 'Capture du navigateur';
					label.style.color = 'rgba(255,255,255,0.5)';
					label.style.fontSize = '12px';

					const closePreview = () => {
						overlay.remove();
						if (browserOpen && browserModel) {
							browserModel.setVisible(true);
							updateBounds();
						}
					};

					// Hide native browser view behind our preview
					if (browserOpen && browserModel) {
						browserModel.setVisible(false);
					}

					closeBtn.addEventListener('click', closePreview);
					overlay.addEventListener('click', (e) => {
						if (e.target === overlay) { closePreview(); }
					});
					const escHandler = (e: KeyboardEvent) => {
						if (e.key === 'Escape') { closePreview(); document.removeEventListener('keydown', escHandler); }
					};
					document.addEventListener('keydown', escHandler);
				};

				const screenshotItem = createMenuItem('Faire une capture', async () => {
					menuPopup.style.display = 'none';
					updateBounds();
					if (browserModel && browserInput.value.trim().length > 0) {
						try {
							const screenshotBuffer = await browserModel.captureScreenshot({ quality: 80 });
							const uint8 = new Uint8Array(screenshotBuffer.buffer);
							this._newChatInput.attachEntries({
								id: 'browser-screenshot-' + Date.now(),
								name: 'Browser Screenshot',
								fullName: 'Browser Screenshot',
								kind: 'image',
								value: uint8,
								mimeType: 'image/jpeg',
							});
							showImagePreview(uint8, 'image/jpeg');
						} catch (e) {
							console.error('Screenshot failed', e);
						}
					}
				});

				createDivider();
				createMenuItem('Hard Reload', () => {
					if (browserModel) {
						browserModel.reload(true).catch(() => navigate());
					}
					menuPopup.style.display = 'none';
					updateBounds();
				});
				createMenuItem('Copy Current URL', () => {
					navigator.clipboard.writeText(browserInput.value);
					menuPopup.style.display = 'none';
					updateBounds();
				});
				createDivider();

				const toggleContainer = dom.$('.toggle-switch');
				toggleContainer.style.width = '28px';
				toggleContainer.style.height = '14px';
				toggleContainer.style.backgroundColor = '#fff';
				toggleContainer.style.borderRadius = '7px';
				toggleContainer.style.position = 'relative';
				toggleContainer.style.border = '1px solid #454545';
				toggleContainer.style.transition = 'background-color 0.2s';
				toggleContainer.style.pointerEvents = 'none'; // let the row handle click

				const toggleKnob = dom.append(toggleContainer, dom.$('.toggle-knob'));
				toggleKnob.style.width = '10px';
				toggleKnob.style.height = '10px';
				toggleKnob.style.backgroundColor = '#3c3c3c';
				toggleKnob.style.borderRadius = '50%';
				toggleKnob.style.position = 'absolute';
				toggleKnob.style.top = '1px';
				toggleKnob.style.left = '15px'; // default ON based on screenshot
				toggleKnob.style.transition = 'transform 0.2s';

				let isBookmarkVisible = true;
				createMenuItem('Show Bookmark Bar', (e) => {
					isBookmarkVisible = !isBookmarkVisible;
					if (isBookmarkVisible) {
						toggleContainer.style.backgroundColor = '#fff';
						toggleKnob.style.left = '15px';
						toggleKnob.style.backgroundColor = '#3c3c3c';
					} else {
						toggleContainer.style.backgroundColor = '#3c3c3c';
						toggleKnob.style.left = '2px';
						toggleKnob.style.backgroundColor = '#cccccc';
					}
					// do not close popup on toggle
				}, toggleContainer);
				createDivider();

				createMenuItem('Clear Browsing History', () => {
					if (browserModel) browserModel.deleteHistory();
					menuPopup.style.display = 'none';
					updateBounds();
				});
				createMenuItem('Clear Cookies', () => {
					if (browserModel) browserModel.clearStorage();
					menuPopup.style.display = 'none';
					updateBounds();
				});
				createMenuItem('Clear Cache', () => {
					if (browserModel) browserModel.clearStorage();
					menuPopup.style.display = 'none';
					updateBounds();
				});

				moreBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					if (browserInput.value.trim().length > 0) {
						screenshotItem.style.display = 'flex';
					} else {
						screenshotItem.style.display = 'none';
					}
					historyPopup.style.display = 'none';
					menuPopup.style.display = menuPopup.style.display === 'none' ? 'flex' : 'none';
					updateBounds();
				});

				const showConfirmModal = (message: string, onConfirm: () => void) => {
					// Hide the native BrowserView (it always renders on top of HTML)
					if (browserModel) {
						browserModel.setVisible(false);
					}

					const overlay = dom.append(document.body, dom.$('.browser-confirm-overlay'));
					overlay.style.position = 'fixed';
					overlay.style.top = '0';
					overlay.style.left = '0';
					overlay.style.width = '100vw';
					overlay.style.height = '100vh';
					overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.65)';
					overlay.style.zIndex = '99999';
					overlay.style.display = 'flex';
					overlay.style.alignItems = 'center';
					overlay.style.justifyContent = 'center';
					overlay.style.backdropFilter = 'blur(4px)';

					const closeModal = () => {
						overlay.remove();
						// Restore the BrowserView — must setVisible(true) first since we explicitly hid it
						if (browserModel) {
							browserModel.setVisible(true);
						}
						updateBounds();
					};

					const modal = dom.append(overlay, dom.$('.browser-confirm-modal'));
					modal.style.backgroundColor = '#1e1e1e';
					modal.style.padding = '32px 40px';
					modal.style.borderRadius = '12px';
					modal.style.border = '1px solid #555';
					modal.style.boxShadow = '0 16px 48px rgba(0, 0, 0, 0.8)';
					modal.style.display = 'flex';
					modal.style.flexDirection = 'column';
					modal.style.gap = '24px';
					modal.style.minWidth = '420px';
					modal.style.maxWidth = '540px';
					modal.style.animation = 'modal-in 0.15s ease-out';

					const title = dom.append(modal, dom.$('div'));
					title.textContent = 'Confirmer la suppression';
					title.style.color = '#ffffff';
					title.style.fontSize = '16px';
					title.style.fontWeight = '600';
					title.style.letterSpacing = '0.02em';

					const msg = dom.append(modal, dom.$('div'));
					msg.textContent = message;
					msg.style.color = '#aaaaaa';
					msg.style.fontSize = '13px';
					msg.style.lineHeight = '1.6';

					const btnRow = dom.append(modal, dom.$('.btn-row'));
					btnRow.style.display = 'flex';
					btnRow.style.justifyContent = 'flex-end';
					btnRow.style.gap = '10px';
					btnRow.style.paddingTop = '8px';

					const cancelBtn = dom.append(btnRow, dom.$('button'));
					cancelBtn.textContent = 'Annuler';
					cancelBtn.style.padding = '8px 20px';
					cancelBtn.style.backgroundColor = '#3c3c3c';
					cancelBtn.style.color = '#cccccc';
					cancelBtn.style.border = '1px solid #555';
					cancelBtn.style.borderRadius = '6px';
					cancelBtn.style.cursor = 'pointer';
					cancelBtn.style.fontSize = '13px';
					cancelBtn.style.transition = 'background 0.15s';
					cancelBtn.onmouseenter = () => cancelBtn.style.backgroundColor = '#4a4a4a';
					cancelBtn.onmouseleave = () => cancelBtn.style.backgroundColor = '#3c3c3c';
					cancelBtn.onclick = () => closeModal();

					const confirmBtn = dom.append(btnRow, dom.$('button'));
					confirmBtn.textContent = 'Supprimer';
					confirmBtn.style.padding = '8px 20px';
					confirmBtn.style.backgroundColor = '#c72e1a';
					confirmBtn.style.color = '#fff';
					confirmBtn.style.border = 'none';
					confirmBtn.style.borderRadius = '6px';
					confirmBtn.style.cursor = 'pointer';
					confirmBtn.style.fontSize = '13px';
					confirmBtn.style.fontWeight = '600';
					confirmBtn.style.transition = 'background 0.15s';
					confirmBtn.onmouseenter = () => confirmBtn.style.backgroundColor = '#e51400';
					confirmBtn.onmouseleave = () => confirmBtn.style.backgroundColor = '#c72e1a';
					confirmBtn.onclick = () => {
						onConfirm();
						closeModal();
					};
				};

				const renderHistory = () => {
					historyContent.textContent = '';
					if (!browserModel || !browserModel.history || !browserModel.history.entries || !browserModel.history.entries.items || browserModel.history.entries.items.length === 0) {
						historyContent.textContent = 'Aucun historique pour le moment.';
						return;
					}
					
					let items = [...browserModel.history.entries.items];
					const filter = historySearchInput.value.toLowerCase().trim();
					if (filter) {
						items = items.filter(i => (i.title && i.title.toLowerCase().includes(filter)) || (i.url && i.url.toLowerCase().includes(filter)));
					}
					items.sort((a, b) => b.time - a.time);

					if (items.length === 0) {
						const empty = dom.append(historyContent, dom.$('div'));
						empty.textContent = 'Aucun résultat.';
						empty.style.color = '#888';
						empty.style.padding = '8px';
						return;
					}

					const now = new Date();
					const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
					const startOfYesterday = startOfToday - 86400000;

					const groups = [
						{ label: 'Today', condition: (time: number) => time >= startOfToday, items: [] as any[] },
						{ label: 'Yesterday', condition: (time: number) => time >= startOfYesterday && time < startOfToday, items: [] as any[] },
						{ label: 'Older', condition: (time: number) => time < startOfYesterday, items: [] as any[] }
					];

					for (const item of items) {
						for (const g of groups) {
							if (g.condition(item.time)) {
								g.items.push(item);
								break;
							}
						}
					}

					for (const g of groups) {
						if (g.items.length === 0) continue;

						const header = dom.append(historyContent, dom.$('.group-header'));
						header.style.display = 'flex';
						header.style.alignItems = 'center';
						header.style.padding = '6px 4px';
						header.style.color = '#cccccc';
						
						const chevron = dom.append(header, dom.$('i.codicon.codicon-chevron-down'));
						chevron.style.marginRight = '4px';
						chevron.style.fontSize = '14px';

						const title = dom.append(header, dom.$('span'));
						title.textContent = g.label;
						title.style.flex = '1';

						const deleteGroup = dom.append(header, dom.$('i.codicon.codicon-trash'));
						deleteGroup.style.cursor = 'pointer';
						deleteGroup.style.display = 'none';
						deleteGroup.title = 'Supprimer';
						
						header.addEventListener('mouseenter', () => deleteGroup.style.display = 'block');
						header.addEventListener('mouseleave', () => deleteGroup.style.display = 'none');
						deleteGroup.addEventListener('click', (e) => {
							e.stopPropagation();
							showConfirmModal(`Voulez-vous supprimer tout l'historique de "${g.label}" ?`, () => {
								if (browserModel) {
									browserModel.deleteHistory(g.items.map((i: any) => i.id));
									renderHistory();
								}
							});
						});

						const groupList = dom.append(historyContent, dom.$('.group-list'));

						for (const item of g.items) {
							const div = dom.append(groupList, dom.$('div'));
							div.style.display = 'flex';
							div.style.alignItems = 'center';
							div.style.padding = '6px 4px 6px 16px';
							div.style.cursor = 'pointer';
							
							const iconHash = item.icon;
							let iconSrc = 'https://www.google.com/favicon.ico';
							if (iconHash && browserModel && browserModel.history && browserModel.history.favicons) {
								const src = browserModel.history.favicons.get(iconHash);
								if (src) iconSrc = src;
							}
							const globe = dom.append(div, dom.$('img')) as HTMLImageElement;
							globe.src = iconSrc;
							globe.style.width = '14px';
							globe.style.height = '14px';
							globe.style.marginRight = '6px';
							globe.style.borderRadius = '50%';

							const itemTitle = dom.append(div, dom.$('span'));
							itemTitle.textContent = item.title || item.url;
							itemTitle.style.flex = '1';
							itemTitle.style.whiteSpace = 'nowrap';
							itemTitle.style.overflow = 'hidden';
							itemTitle.style.textOverflow = 'ellipsis';
							itemTitle.title = item.title || item.url;

							const delBtn = dom.append(div, dom.$('i.codicon.codicon-trash'));
							delBtn.style.cursor = 'pointer';
							delBtn.style.display = 'none';
							delBtn.title = 'Supprimer';
							
							div.addEventListener('mouseenter', () => {
								div.style.backgroundColor = '#2a2d2e';
								delBtn.style.display = 'block';
							});
							div.addEventListener('mouseleave', () => {
								div.style.backgroundColor = 'transparent';
								delBtn.style.display = 'none';
							});

							delBtn.addEventListener('click', (e) => {
								e.stopPropagation();
								showConfirmModal(`Voulez-vous supprimer "${item.title || item.url}" ?`, () => {
									if (browserModel) {
										browserModel.deleteHistory([item.id]);
										renderHistory();
									}
								});
							});

							div.addEventListener('click', () => {
								browserInput.value = item.url;
								navigate();
								historyPopup.style.display = 'none';
								updateBounds();
							});
						}
					}
				};

				historySearchInput.addEventListener('input', renderHistory);

				historyBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					menuPopup.style.display = 'none';
					historyPopup.style.display = historyPopup.style.display === 'none' ? 'flex' : 'none';
					
					if (historyPopup.style.display === 'flex') {
						historySearchInput.value = '';
						renderHistory();
					}
					updateBounds();
				});

				this._register(dom.addDisposableListener(document, dom.EventType.CLICK, (e) => {
					let changed = false;
					if (menuPopup.style.display !== 'none' && !menuPopup.contains(e.target as Node) && !moreBtn.contains(e.target as Node)) {
						menuPopup.style.display = 'none';
						changed = true;
					}
					if (historyPopup.style.display !== 'none' && !historyPopup.contains(e.target as Node) && !historyBtn.contains(e.target as Node)) {
						historyPopup.style.display = 'none';
						changed = true;
					}
					if (changed) updateBounds();
				}));

				const webviewContainer = dom.append(containerEl, dom.$('.browser-webview-container'));
				webviewContainer.style.flex = '1';
				webviewContainer.style.width = '100%';
				webviewContainer.style.minHeight = '0';
				webviewContainer.style.overflow = 'hidden';
				webviewContainer.style.position = 'relative';

				let browserModel: any;

				this.instantiationService.invokeFunction(async accessor => {
					const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
					const browserInputModel = browserViewWorkbenchService.getOrCreateLazy('chat-panel-browser');
					browserModel = await browserInputModel.resolve();
					
					updateBounds = () => {
						if (!browserModel || !webviewContainer.isConnected) return;
						const rect = webviewContainer.getBoundingClientRect();
						if (rect.width === 0 || rect.height === 0) {
							browserModel.setVisible(false);
							return;
						}
						const windowId = (dom.getWindow(webviewContainer) as any).vscodeWindowId ?? mainWindow.vscodeWindowId;
						
						let width = rect.width;
						if (menuPopup.style.display !== 'none' || historyPopup.style.display !== 'none') {
							width = Math.max(0, rect.width - 250);
						}

						browserModel.layout({
							windowId,
							x: rect.x,
							y: rect.y,
							width: width,
							height: rect.height,
							zoomFactor: 1,
							cornerRadius: 0
						});
					};

					const observer = new ResizeObserver(() => updateBounds());
					observer.observe(webviewContainer);
					this._register(toDisposable(() => observer.disconnect()));
					
					// Handle focus/visibility
					browserModel.setVisible(true);
					updateBounds();

					// If container is hidden, hide the browser too
					const mutationObserver = new MutationObserver(() => {
						if (webviewContainer.isConnected && webviewContainer.offsetParent !== null) {
							browserModel.setVisible(true);
							updateBounds();
						} else {
							browserModel.setVisible(false);
						}
					});
					mutationObserver.observe(containerEl, { attributes: true, attributeFilter: ['style', 'class'] });
					this._register(toDisposable(() => mutationObserver.disconnect()));

					disposeFn = () => {
						if (browserModel) {
							browserModel.dispose();
						}
					};

					onBeforeContextMenu = () => {};
					
					onAfterContextMenu = () => {};

					hideBrowser = () => {
						if (browserModel) browserModel.setVisible(false);
					};

					showBrowser = () => {
						if (browserModel && webviewContainer.isConnected && webviewContainer.offsetParent !== null) {
							browserModel.setVisible(true);
							updateBounds();
						}
					};

					this._register(toDisposable(() => {
						if (browserModel) {
							browserModel.setVisible(false);
						}
					}));

					this._register(browserModel.onDidNavigate((e: any) => {
						if (e.url && browserInput.value !== e.url) {
							browserInput.value = e.url;
						}
						updateFavoriteIcon(e.url);
						devToolsBtn.style.display = 'flex';
					}));
				});

				const navigate = () => {
					let url = browserInput.value.trim();
					if (!url) return;
					try {
						if (!url.includes(' ') && !url.startsWith('http://') && !url.startsWith('https://') && url.includes('.')) {
							url = 'https://' + url;
						}
						new URL(url);
					} catch {
						// Removed &igu=1 because it forces a dark/iframe theme. 
						// BrowserView doesn't have iframe restrictions.
						url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
					}
					if (browserModel) {
						browserModel.loadURL(url);
					}
				};

				this._register(dom.addDisposableListener(backBtn, dom.EventType.CLICK, () => browserModel?.goBack()));
				this._register(dom.addDisposableListener(forwardBtn, dom.EventType.CLICK, () => browserModel?.goForward()));
				
				// Using navigate() for reload to ensure it forces a load of the current input URL if reload is broken
				this._register(dom.addDisposableListener(reloadBtn, dom.EventType.CLICK, () => {
					if (browserModel) {
						browserModel.reload().catch(() => {
							navigate();
						});
					}
				}));

				this._register(dom.addDisposableListener(browserInput, dom.EventType.KEY_UP, (e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						browserInput.blur();
						navigate();
					}
				}));

				this._register(dom.addDisposableListener(browserInput, dom.EventType.FOCUS, () => {
					browserInput.select();
				}));
			} else if (type === 'files') {
				const splitContainer = dom.append(containerEl, dom.$('.files-split-container'));
				splitContainer.style.display = 'flex';
				splitContainer.style.height = '100%';
				splitContainer.style.width = '100%';
				splitContainer.style.flex = '1';

				// 1. Editor Pane (Left)
				const editorPane = dom.append(splitContainer, dom.$('.files-editor-pane'));
				editorPane.style.flex = '1';
				editorPane.style.display = 'flex';
				editorPane.style.flexDirection = 'column';
				editorPane.style.minWidth = '0';

				const editorHeader = dom.append(editorPane, dom.$('.files-editor-header'));
				editorHeader.style.height = '35px';
				editorHeader.style.display = 'flex';
				editorHeader.style.alignItems = 'center';
				editorHeader.style.padding = '0 12px';
				editorHeader.style.gap = '8px';
				editorHeader.style.borderBottom = '1px solid var(--vscode-editorGroup-border)';
				editorHeader.style.fontSize = '12px';
				editorHeader.style.color = 'var(--vscode-descriptionForeground)';

				const breadcrumb = dom.append(editorHeader, dom.$('span'));
				breadcrumb.textContent = 'Open a file to get started';

				const editorContent = dom.append(editorPane, dom.$('.files-editor-content'));
				editorContent.style.flex = '1';
				editorContent.style.position = 'relative';
				editorContent.style.height = '100%';
				editorContent.style.width = '100%';
				editorContent.style.minHeight = '0';
				editorContent.style.overflow = 'hidden';

				const emptyState = dom.append(editorContent, dom.$('.files-empty-state'));
				emptyState.style.position = 'absolute';
				emptyState.style.inset = '0';
				emptyState.style.display = 'flex';
				emptyState.style.flexDirection = 'column';
				emptyState.style.alignItems = 'center';
				emptyState.style.justifyContent = 'center';
				emptyState.style.gap = '16px';
				
				const emptyText = dom.append(emptyState, dom.$('div'));
				emptyText.textContent = 'Open a file to get started';
				emptyText.style.color = 'var(--vscode-descriptionForeground)';
				
				const newFileBtn = dom.append(emptyState, dom.$('button'));
				newFileBtn.textContent = 'New File';
				newFileBtn.style.padding = '4px 12px';
				newFileBtn.style.background = 'transparent';
				newFileBtn.style.border = '1px solid var(--vscode-button-border, var(--vscode-focusBorder))';
				newFileBtn.style.color = 'var(--vscode-foreground)';
				newFileBtn.style.borderRadius = '4px';
				newFileBtn.style.cursor = 'pointer';

				const editorContainer = dom.append(editorContent, dom.$('.files-code-editor'));
				editorContainer.style.position = 'absolute';
				editorContainer.style.top = '0';
				editorContainer.style.left = '0';
				editorContainer.style.width = '100%';
				editorContainer.style.height = '100%';
				editorContainer.style.overflow = 'hidden';
				editorContainer.style.display = 'none';

				// 2. Resizer
				const filesResizer = dom.append(splitContainer, dom.$('.files-resizer'));
				filesResizer.style.width = '5px';
				filesResizer.style.marginLeft = '-2px';
				filesResizer.style.marginRight = '-3px';
				filesResizer.style.cursor = 'ew-resize';
				filesResizer.style.zIndex = '10';

				// 3. Tree Pane (Right)
				const treePane = dom.append(splitContainer, dom.$('.files-tree-pane.show-file-icons'));
				treePane.style.width = '200px';
				treePane.style.display = 'flex';
				treePane.style.flexDirection = 'column';
				treePane.style.flexShrink = '0';
				treePane.style.borderLeft = '1px solid var(--vscode-editorGroup-border)';

				const title = dom.append(treePane, dom.$('div'));
				title.style.fontWeight = '600';
				title.style.padding = '10px 20px';
				title.style.fontSize = '11px';
				title.style.letterSpacing = '1px';
				title.style.color = 'var(--vscode-sideBarTitle-foreground)';
				title.style.opacity = '1';

				const treeContent = dom.append(treePane, dom.$('.files-tree-content'));
				treeContent.style.flex = '1';
				treeContent.style.overflow = 'auto';
				treeContent.style.padding = '8px 0';

				let isFilesResizing = false;
				let filesStartX = 0;
				let filesStartWidth = 0;

				this._register(dom.addDisposableListener(filesResizer, dom.EventType.MOUSE_DOWN, (e) => {
					isFilesResizing = true;
					filesStartX = e.clientX;
					filesStartWidth = treePane.clientWidth;
					document.body.style.cursor = 'ew-resize';
					e.preventDefault();
					e.stopPropagation();
				}));

				this._register(dom.addDisposableListener(mainWindow, dom.EventType.MOUSE_MOVE, (e) => {
					if (!isFilesResizing) return;
					const dx = filesStartX - e.clientX;
					const newWidth = Math.max(100, Math.min(filesStartWidth + dx, splitContainer.clientWidth - 100));
					treePane.style.width = `${newWidth}px`;
				}));

				this._register(dom.addDisposableListener(mainWindow, dom.EventType.MOUSE_UP, () => {
					if (isFilesResizing) {
						isFilesResizing = false;
						document.body.style.cursor = '';
					}
				}));

				this.instantiationService.invokeFunction(accessor => {
					const fileService = accessor.get(IFileService);
					const contextService = accessor.get(IWorkspaceContextService);
					const textModelService = accessor.get(ITextModelService);
					const modelService = accessor.get(IModelService);
					const languageService = accessor.get(ILanguageService);
					const textFileService = accessor.get(ITextFileService);

					let codeEditorWidget: any = null;
					let currentModelRef: any = null;
					let autoSaveTimeout: any = null;

					const openFile = async (resource: any) => {
						try {
							emptyState.style.display = 'none';
							editorContainer.style.display = 'block';
							
							const rootUri = this._workspacePicker.selectedFolderUri || (contextService.getWorkspace().folders.length > 0 ? contextService.getWorkspace().folders[0].uri : undefined);
							
							let relPath = resource.path;
							if (rootUri && resource.path.startsWith(rootUri.path)) {
								relPath = resource.path.substring(rootUri.path.length);
							}
							if (relPath.startsWith('/')) relPath = relPath.substring(1);
							
							const parts = relPath.split('/');
							
							breadcrumb.style.padding = '8px 16px';
							breadcrumb.style.fontSize = '12px';
							breadcrumb.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
							breadcrumb.style.backgroundColor = 'var(--vscode-editor-background)';
							breadcrumb.style.borderBottom = '1px solid var(--vscode-editorGroup-border)';
							dom.clearNode(breadcrumb);
							dom.append(breadcrumb, dom.$('span.codicon.codicon-arrow-left', { style: 'cursor:pointer;opacity:0.6;margin-right:4px;font-size:14px' }));
							dom.append(breadcrumb, dom.$('span.codicon.codicon-arrow-right', { style: 'cursor:pointer;opacity:0.6;margin-right:12px;font-size:14px' }));
							
							for (let i = 0; i < parts.length; i++) {
								const p = parts[i];
								const isLast = i === parts.length - 1;
								dom.append(breadcrumb, dom.$('span', { style: `opacity:${isLast ? '1' : '0.6'};font-weight:${isLast ? 'bold' : 'normal'}` }, p));
								if (!isLast) {
									dom.append(breadcrumb, dom.$('span.codicon.codicon-chevron-right', { style: 'font-size:14px;opacity:0.4;margin:0 4px' }));
								}
							}

							if (!codeEditorWidget) {
								codeEditorWidget = (this as any).instantiationService.createInstance(CodeEditorWidget, editorContainer, {
									readOnly: false,
									minimap: { enabled: false },
									scrollBeyondLastLine: false,
									automaticLayout: true,
									padding: { top: 16, bottom: 16 },
									lineNumbersMinChars: 3,
									roundedSelection: false,
									renderLineHighlight: 'all',
									cursorBlinking: 'smooth',
									cursorSmoothCaretAnimation: 'on',
									fontFamily: '"Geist Mono", "Geist", "Fira Code", Consolas, "Courier New", monospace',
									fontSize: 13,
									lineHeight: 1.5,
									hideCursorInOverviewRuler: true,
									overviewRulerBorder: false,
									renderIndentGuides: false,
									matchBrackets: 'always'
								}, {});
								
								this._register({
									dispose: () => {
										if (codeEditorWidget) codeEditorWidget.dispose();
										if (currentModelRef) currentModelRef.dispose();
									}
								});
							}

							if (currentModelRef) {
								currentModelRef.dispose();
								currentModelRef = null;
							}

							const ref = await textModelService.createModelReference(resource);
							currentModelRef = ref;
							codeEditorWidget.setModel(ref.object.textEditorModel);
							
							// Auto-save logic
							if (autoSaveTimeout) {
								clearTimeout(autoSaveTimeout);
								autoSaveTimeout = null;
							}
							const disposable = codeEditorWidget.onDidChangeModelContent(() => {
								if (autoSaveTimeout) {
									clearTimeout(autoSaveTimeout);
								}
								autoSaveTimeout = setTimeout(() => {
									if (textFileService && resource) {
										textFileService.save(resource);
									}
								}, 750);
							});
							
							this._register({
								dispose: () => {
									disposable.dispose();
									if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
								}
							});
							
							const updateEditorLayout = () => {
								if (editorContainer.clientWidth > 0 && editorContainer.clientHeight > 0) {
									codeEditorWidget.layout({ width: editorContainer.clientWidth, height: editorContainer.clientHeight });
								}
							};
							
							if (!editorContainer.dataset.observed) {
								editorContainer.dataset.observed = 'true';
								const observer = new ResizeObserver(updateEditorLayout);
								observer.observe(editorContainer);
								this._register(toDisposable(() => observer.disconnect()));
							}
							
							updateEditorLayout();
							setTimeout(updateEditorLayout, 50);
							setTimeout(updateEditorLayout, 150);
						} catch (e: any) {
							console.error(e);
							emptyState.style.display = 'flex';
							editorContainer.style.display = 'none';
							emptyText.textContent = `Failed to open file: ${e.message || String(e)}`;
						}
					};

					const rootUri = this._workspacePicker.selectedFolderUri || (contextService.getWorkspace().folders.length > 0 ? contextService.getWorkspace().folders[0].uri : undefined);
					if (rootUri) {
						title.textContent = rootUri.path.split('/').pop()?.toUpperCase() || 'WORKSPACE';
						
						const renderFolder = async (uri: any, container: HTMLElement, level: number) => {
							const stat = await fileService.resolve(uri);
							if (stat.children) {
								stat.children.sort((a, b) => {
									if (a.isDirectory && !b.isDirectory) return -1;
									if (!a.isDirectory && b.isDirectory) return 1;
									return a.name.localeCompare(b.name);
								});
								for (const child of stat.children) {
									const item = dom.append(container, dom.$('.file-tree-item'));
									item.style.paddingLeft = `${16 + level * 16}px`;
									item.style.cursor = 'pointer';
									item.style.display = 'flex';
									item.style.alignItems = 'center';
									item.style.paddingTop = '4px';
									item.style.paddingBottom = '4px';
									item.style.gap = '6px';
									item.style.lineHeight = '22px';
									
									let chevron: HTMLElement | null = null;
									if (child.isDirectory) {
										chevron = dom.append(item, dom.$('span.codicon.codicon-chevron-right'));
										chevron.style.fontSize = '14px';
										chevron.style.marginRight = '4px';
									} else {
										const spacer = dom.append(item, dom.$('span'));
										spacer.style.width = '18px';
									}

									const icon = dom.append(item, dom.$('span'));
									const iconClasses = getIconClasses(modelService, languageService, child.resource, child.isDirectory ? FileKind.FOLDER : FileKind.FILE);
									icon.className = iconClasses.join(' ');
									icon.style.marginRight = '4px';
									
									const name = dom.append(item, dom.$('span'));
									name.textContent = child.name;
									name.style.fontSize = '13px';
									
									this._register(dom.addDisposableListener(item, dom.EventType.MOUSE_OVER, () => item.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'));
									this._register(dom.addDisposableListener(item, dom.EventType.MOUSE_OUT, () => item.style.backgroundColor = 'transparent'));
									
									if (child.isDirectory) {
										const childrenContainer = dom.append(container, dom.$('.file-tree-children'));
										childrenContainer.style.display = 'none';
										let loaded = false;
										
										this._register(dom.addDisposableListener(item, dom.EventType.CLICK, async (e) => {
											e.stopPropagation();
											const isExpanded = childrenContainer.style.display !== 'none';
											childrenContainer.style.display = isExpanded ? 'none' : 'block';
											if (chevron) {
												chevron.classList.toggle('codicon-chevron-right', isExpanded);
												chevron.classList.toggle('codicon-chevron-down', !isExpanded);
											}
											if (!isExpanded && !loaded) {
												loaded = true;
												await renderFolder(child.resource, childrenContainer, level + 1);
											}
										}));
									} else {
										this._register(dom.addDisposableListener(item, dom.EventType.CLICK, async (e) => {
											e.stopPropagation();
											await openFile(child.resource);
										}));
									}
								}
							}
						};

						renderFolder(rootUri, treeContent, 0);
					}
				});
			}

			const tabObj: any = {
				type,
				tabEl,
				containerEl,
				instance,
				hideBrowser: () => hideBrowser(),
				showBrowser: () => showBrowser(),
				onBeforeContextMenu: () => onBeforeContextMenu(),
				onAfterContextMenu: () => onAfterContextMenu(),
				dispose: () => disposeFn()
			};
			tabs.push(tabObj);

			this._register(dom.addDisposableListener(tabEl, dom.EventType.CLICK, () => activateTab(tabObj)));

			this._register(dom.addDisposableListener(tabClose, dom.EventType.CLICK, (e) => {
				e.stopPropagation();
				tabObj.dispose();
				tabEl.remove();
				containerEl.remove();
				
				const index = tabs.indexOf(tabObj);
				if (index > -1) {
					tabs.splice(index, 1);
				}
				
				if (tabs.length === 0) {
					restoreMainView();
				} else {
					activateTab(tabs[Math.max(0, index - 1)]);
				}
			}));

			activateTab(tabObj);
		};

		this._aquariumToggle = this._register(this.aquariumService.mountToggle(element));
		const aquariumAction = this._register(new Action(
			'sessions.aquarium.showAction',
			localize('aquariumAction', "Aquarium"),
			undefined,
			true,
			() => this.aquariumService.toggleActionVisibility()
		));
		const petAction = this._register(new Action(
			'sessions.chatPet.toggle',
			localize('petAction', "Pet (/vscode-pet)"),
			undefined,
			true,
			() => this.chatPetService.toggle()
		));
		this._register(dom.addDisposableListener(element, dom.EventType.CONTEXT_MENU, (e: MouseEvent) => {
			const target = e.target as Node | null;
			if (target && chatWidgetContent.contains(target)) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();
			aquariumAction.checked = this.aquariumService.actionVisible.get();
			petAction.checked = this.chatPetService.enabled.get();
			const anchor = new StandardMouseEvent(dom.getWindow(element), e);
			this.contextMenuService.showContextMenu({
				getAnchor: () => anchor,
				getActions: () => [aquariumAction, petAction],
				getCheckedActionsRepresentation: () => 'checkbox',
			});
		}));

		// Codex Hero Section (Cloud icon + Title + 4 Cards)
		const heroSection = dom.append(chatWidgetContent, dom.$('.codex-hero-section'));
		const cloudIcon = dom.append(heroSection, dom.$('.codex-hero-cloud-icon'));
		cloudIcon.appendChild(renderIcon(Codicon.cloud));

		const heroTitle = dom.append(heroSection, dom.$('.codex-hero-title'));
		heroTitle.textContent = "Que voulez-vous créer aujourd'hui ?";

		const cardsContainer = dom.append(heroSection, dom.$('.codex-action-cards-container'));
		const actionCards = [
			{ icon: Codicon.telescope, label: 'Explorer et comprendre le code', colorClass: 'card-icon-blue', prompt: 'Explore et explique ce projet' },
			{ icon: Codicon.tools, label: 'Créer une fonctionnalité, une application ou un outil', colorClass: 'card-icon-purple', prompt: 'Aide-moi à créer une nouvelle fonctionnalité' },
			{ icon: Codicon.sync, label: 'Vérifier le code et suggérer des modifications', colorClass: 'card-icon-green', prompt: 'Vérifie le code et suggère des améliorations' },
			{ icon: Codicon.bug, label: 'Corriger les problèmes et les échecs', colorClass: 'card-icon-orange', prompt: 'Corrige les erreurs et bugs dans le code' },
		];

		for (const card of actionCards) {
			const cardEl = dom.append(cardsContainer, dom.$('.codex-action-card'));
			const cardIcon = dom.append(cardEl, dom.$(`.codex-card-icon.${card.colorClass}`));
			cardIcon.appendChild(renderIcon(card.icon));
			const cardLabel = dom.append(cardEl, dom.$('.codex-card-label'));
			cardLabel.textContent = card.label;

			this._register(dom.addDisposableListener(cardEl, dom.EventType.CLICK, () => {
				this._newChatInput.inputEditor?.setValue(card.prompt);
				this._newChatInput.focus();
			}));
		}

		const workspacePickerContainer = dom.append(chatWidgetContent, dom.$('.new-session-workspace-picker-container.new-chat-top-workspace-header'));
		this._register(isWeb
			? this._renderEmptyStateGate(workspacePickerContainer, chatWidgetContent)
			: this._renderWorkspacePicker(workspacePickerContainer));

		// Quick-chat composer header (workspace-less): a top-of-input "New Chat"
		// label plus the inline session-type picker. Shown only in quick-chat
		// mode via the `.quick-chat` class on the content (see CSS). On web the
		// composer is never a quick chat, so it stays empty/hidden there.
		if (!isWeb && !this._renderHarnessPickerInControls) {
			const quickChatHeaderRow = dom.append(chatWidgetContent, dom.$('.new-session-quick-chat-header.session-workspace-picker'));
			const quickChatHeaderLabel = dom.append(quickChatHeaderRow, dom.$('.session-workspace-picker-label'));
			quickChatHeaderLabel.textContent = localize('newChatHeader', "New Chat");
			const quickChatWithLabel = dom.append(quickChatHeaderRow, dom.$('.session-workspace-picker-label.session-workspace-picker-with-label'));
			quickChatWithLabel.textContent = localize('newSessionWith', "with");
			this._quickChatHeaderPickerHost = dom.append(quickChatHeaderRow, dom.$('.new-chat-quick-chat-header-picker-host'));
		}

		this._renderFeedbackBanner(chatWidgetContent);
		this._chatTipContainer = dom.append(chatWidgetContent, dom.$('.chat-getting-started-tip-container'));
		this._renderChatTip();
		this._newChatInput.render(chatWidgetContent, parent);

		// Quick chat composer: hide the workspace picker for workspace-less
		// drafts (there is nothing to pick) and reflect it in the picker-visible
		// context key. Quick chats are only created on desktop (the local agent
		// host), so leave the web empty-state gate's key management untouched.
		this._register(autorun(reader => {
			const isQuickChat = this._isQuickChatComposer.read(reader);
			chatWidgetContent.classList.toggle('quick-chat', isQuickChat);
			if (!isWeb) {
				this._workspacePickerVisibleKey.set(!isQuickChat);
			}
		}));

		// Desktop harness-picker placement: a quick chat renders the session-type
		// picker in its top-of-input header row; otherwise (including after a
		// Cmd+N swap out of a quick chat) it re-parents into the workspace row.
		if (!isWeb && !this._renderHarnessPickerInControls) {
			this._register(autorun(reader => {
				const isQuickChat = this._isQuickChatComposer.read(reader);
				const target = isQuickChat ? this._quickChatHeaderPickerHost : this._workspacePickerRow;
				if (target) {
					this._newChatInput.sessionTypePicker.render(target, { className: 'sessions-chat-session-type-picker' });
				}
			}));
		}

		// Create initial session for any workspace already selected at construct time.
		// If the selection arrives later (provider registers asynchronously), the
		// picker fires onDidSelectWorkspace and our listener handles it.
		// Skip if an active session already exists (restored by openNewSession
		// from a new-session draft when navigating back from another session).
		this._seedWorkspaceDraft();

		// Re-seed the workspace draft when the composer swaps out of quick-chat
		// mode (e.g. Cmd+N discards a quick chat, leaving the reused composer
		// session-less): without an active session the session-type picker has no
		// folder types and hides itself, so restore the last folder to match a
		// freshly-opened new-session composer.
		if (!isWeb) {
			let wasQuickChat = this._isQuickChatComposer.get();
			this._register(autorun(reader => {
				const isQuickChat = this._isQuickChatComposer.read(reader);
				if (wasQuickChat && !isQuickChat && !this._session.read(reader)) {
					this._seedWorkspaceDraft();
				}
				wasQuickChat = isQuickChat;
			}));
		}

		chatWidgetContainer.classList.add('revealed');
	}

	private _renderChatTip(): void {
		if (!this._chatTipContainer) {
			return;
		}
		if (this.isInputOnboardingVisible()) {
			this._clearChatTip();
			return;
		}
		// Don't show a tip in the no-agent-host empty state — there is no usable composer.
		if (this._chatTipContainer.parentElement?.classList.contains('no-agent-host')) {
			return;
		}
		if (this.contextKeyService.getContextKeyValue<number>(ChatContextKeys.foregroundSessionCount.key) !== 0) {
			this._isChatTipSessionInitialized = false;
			this._clearChatTip();
			return;
		}
		if (!this._isChatTipSessionInitialized) {
			this._isChatTipSessionInitialized = true;
			this.chatTipService.resetSession();
		}

		const tip = this.chatTipService.getWelcomeTip(this.contextKeyService);
		if (!tip) {
			this._clearChatTip();
			return;
		}
		if (this._chatTipPart.value) {
			dom.setVisibility(true, this._chatTipContainer);
			return;
		}

		const store = new DisposableStore();
		const renderer = this.instantiationService.createInstance(ChatContentMarkdownRenderer);
		const tipPart = store.add(this.instantiationService.createInstance(ChatTipContentPart, tip, renderer));
		store.add(tipPart.onDidHide(() => {
			this._clearChatTip();
			// Restore focus to the input after the tip DOM is removed so keyboard
			// focus is not stranded on <body> (matches ChatWidget behaviour).
			this.focusInput();
		}));
		this._chatTipPart.value = store;
		dom.clearNode(this._chatTipContainer);
		this._chatTipContainer.appendChild(tipPart.domNode);
		dom.setVisibility(true, this._chatTipContainer);
	}

	private _clearChatTip(): void {
		this._chatTipPart.clear();
		if (this._chatTipContainer) {
			dom.clearNode(this._chatTipContainer);
			dom.setVisibility(false, this._chatTipContainer);
		}
	}

	private isInputOnboardingVisible(): boolean {
		return this._isInputOnboardingVisible;
	}

	private setInputOnboardingVisible(visible: boolean): void {
		this._isInputOnboardingVisible = visible;
		if (visible) {
			this._clearChatTip();
		} else {
			this._renderChatTip();
		}
	}

	/**
	 * Seed the new-session draft from the workspace picker's restored folder,
	 * unless an active session already exists (then just sync the picker to it).
	 */
	private _seedWorkspaceDraft(): void {
		const restoredFolderUri = this._workspacePicker.selectedFolderUri;
		if (!this._syncWorkspacePickerFromActiveSession() && restoredFolderUri) {
			void this._createNewSession(restoredFolderUri);
		}
	}

	/**
	 * If a new-session draft was restored by {@link openNewSession}, sync
	 * the workspace picker to match the session's workspace. The picker may
	 * have restored a workspace from a different provider (e.g. remote vs
	 * local), so overwrite it with the session's actual workspace without
	 * firing the event (which would trigger {@link _onWorkspaceSelected} and
	 * create a new session).
	 *
	 * @returns `true` if an active session was found and the picker was synced.
	 */
	private _syncWorkspacePickerFromActiveSession(): boolean {
		const activeSession = this._session.get();
		if (!activeSession) {
			return false;
		}

		const sessionWorkspace = activeSession.workspace.get();
		const folderUri = sessionWorkspace?.folders[0]?.root;
		if (folderUri) {
			this._workspacePicker.setSelectedWorkspace(folderUri, { fireEvent: false });
			this._replaceDraftOnUnservableHarness(folderUri, activeSession);
		}

		return true;
	}

	/**
	 * Replaces a restored draft whose harness the folder can no longer serve.
	 * A draft outlives navigation, so it can name a session type that has since
	 * stopped being advertised — e.g. the extension-host Copilot CLI once
	 * `chat.agents.copilotCli.hideExtensionHost` is on. Keeping it would leave
	 * the composer showing, and sending to, an agent the harness picker doesn't
	 * list. An empty type list means the folder's providers haven't reported yet
	 * (a late-connecting agent host), so the draft is left alone.
	 */
	private _replaceDraftOnUnservableHarness(folderUri: URI, draft: IActiveSession): void {
		if (draft.isCreated.get()) {
			return;
		}
		const pick = { providerId: draft.providerId, sessionTypeId: draft.sessionType };
		if (this.sessionsManagementService.getSessionTypesForFolder(folderUri).length === 0 || this._isPreferredServable(folderUri, pick)) {
			return;
		}
		void this._createNewSession(folderUri);
	}

	private _isPreferredServable(folderUri: URI, pick: IPreferredSessionType): boolean {
		return this.sessionsManagementService.getSessionTypesForFolder(folderUri).some(t =>
			(pick.providerId === undefined || t.providerId === pick.providerId)
			&& t.sessionType.id === pick.sessionTypeId);
	}

	private async _createNewSession(folderUri: URI): Promise<IOpenNewSessionResult> {
		this._pendingPreferredUpgrade.clear();
		const creationCts = new CancellationTokenSource();
		const creationLifecycle = toDisposable(() => creationCts.dispose(true));
		this._newSessionCreation.value = creationLifecycle;
		const userPick = this._newChatInput.sessionTypePicker.getUserPickedSessionType();
		// Session creation is async, so a provider can start serving the folder
		// (e.g. the local agent host finishing its handshake) between the call
		// below and the listener installed after it. That change would land in
		// the gap and be lost, leaving the composer without a draft — and with
		// the harness picker hidden — until the user re-picks the workspace.
		// Record it here so the listener can replay it.
		const pendingChange = new DisposableStore();
		let changedWhilePending = false;
		pendingChange.add(this.sessionsManagementService.onDidChangeSessionTypes(() => changedWhilePending = true));
		let result: IOpenNewSessionResult;
		try {
			result = await this._createSessionNow(folderUri, userPick, creationCts.token);
		} finally {
			pendingChange.dispose();
		}
		const isCurrentCreation = this._newSessionCreation.value === creationLifecycle;
		if (isCurrentCreation) {
			this._newSessionCreation.clear();
		} else {
			return result;
		}
		if (result.trustDeclined) {
			// The user explicitly declined trust: don't schedule a retry, which
			// would silently recreate (and possibly re-prompt) the draft once a
			// provider registers/changes without any further user action.
			this._pendingPreferredUpgrade.clear();
			return result;
		}
		// Keep the draft in sync with late-registering providers. Agent hosts
		// connect lazily, so there is no timeout — the listener lives until the
		// draft is sent or replaced. We watch when:
		//  - no provider can serve the folder yet (!result.session),
		//  - the user's explicit pick isn't servable yet (created with a
		//    fallback, upgrade once its provider connects), or
		//  - there is no explicit pick, so the draft tracks the preferred
		//    (first) type, which can change as the folder's session-type list
		//    grows.
		if (!result.session || !userPick || !this._isPreferredServable(folderUri, userPick)) {
			this._scheduleRecreateOnProviderChange(folderUri, userPick, result.session, changedWhilePending);
		}
		return result;
	}

	private async _createSessionNow(folderUri: URI, userPick: IPreferredSessionType | undefined, token: CancellationToken): Promise<IOpenNewSessionResult> {
		// Prefer the user's explicit pick when its provider can serve the
		// folder; otherwise fall back to the preferred (first) session type.
		const effectivePick = userPick && this._isPreferredServable(folderUri, userPick)
			? userPick
			: this._newChatInput.sessionTypePicker.getPreferredSessionType(folderUri);
		const fallbackProviderId = this._workspacePicker.selectedResolved?.providerId;
		try {
			return await this.sessionsService.openNewSession({
				folderUri,
				...(effectivePick
					? { providerId: effectivePick.providerId, sessionTypeId: effectivePick.sessionTypeId }
					: fallbackProviderId
						? { providerId: fallbackProviderId }
						: undefined),
			}, token);
		} catch (e) {
			this.logService.error('Failed to create new session:', e);
			return { session: undefined, trustDeclined: false };
		}
	}

	private _scheduleRecreateOnProviderChange(folderUri: URI, userPick: IPreferredSessionType | undefined, created: ISession | undefined, replayMissedChange: boolean): void {
		const store = new DisposableStore();
		store.add(this.sessionsManagementService.onDidChangeSessionTypes(() => this._recreateOnProviderChange(folderUri, userPick, created)));
		this._pendingPreferredUpgrade.value = store;
		if (replayMissedChange) {
			this._recreateOnProviderChange(folderUri, userPick, created);
		}
	}

	private _recreateOnProviderChange(folderUri: URI, userPick: IPreferredSessionType | undefined, created: ISession | undefined): void {
		if (created) {
			const active = this._session.get();
			if (active?.sessionId !== created.sessionId || active.isCreated.get()) {
				return; // the draft was sent or is no longer the active session
			}
			if (userPick) {
				if (!this._isPreferredServable(folderUri, userPick)) {
					return; // the preferred provider still cannot serve the folder
				}
			} else {
				// No explicit pick: keep the draft on the preferred (first)
				// type. Recreate only when that preferred actually changed.
				const preferred = this._newChatInput.sessionTypePicker.getPreferredSessionType(folderUri);
				if (!preferred || (preferred.providerId === active.providerId && preferred.sessionTypeId === active.sessionType)) {
					return;
				}
			}
		}
		void this._createNewSession(folderUri);
	}

	/**
	 * Returns the workspace URI for the context picker based on the current workspace selection.
	 */
	private _getContextFolderUri(): URI | undefined {
		return this._workspacePicker.selectedFolderUri;
	}

	private _renderWorkspacePicker(container: HTMLElement): IDisposable {
		this._workspacePickerVisibleKey.set(true);
		
		this._workspacePicker.render(container);

		const sessionTypePickerHost = dom.append(container, dom.$('.new-chat-session-type-picker-host'));
		this._workspacePickerRow = sessionTypePickerHost;
		this._newChatInput.sessionTypePicker.render(sessionTypePickerHost, { className: 'sessions-chat-session-type-picker' });

		const petSlot = dom.append(container, dom.$('.new-chat-top-pet-slot'));
		petSlot.style.marginLeft = 'auto';
		petSlot.style.display = 'flex';
		petSlot.style.alignItems = 'center';
		this._register(this.aquariumService.mountToggle(petSlot));

		return this._workspacePicker.onDidSelectWorkspace(() => {});
	}

	private _renderEmptyState(container: HTMLElement): IDisposable {
		this._workspacePickerVisibleKey.set(false);
		const emptyState = this.instantiationService.createInstance(NoAgentHostEmptyState);
		emptyState.render(container);
		this._activeEmptyState = emptyState;
		return {
			dispose: () => {
				if (this._activeEmptyState === emptyState) {
					this._activeEmptyState = undefined;
				}
				emptyState.dispose();
			},
		};
	}

	/**
	 * Web-only: hosts the workspace picker, but swaps it out for the
	 * no-agent-host empty state once we are *sure* there are no hosts —
	 * i.e. after a discovery cycle has completed. Rendering the empty
	 * state before discovery has run would briefly flash it at users who
	 * actually have hosts that just haven't been discovered yet (e.g.
	 * cached tunnels resolved on startup). Until then we keep the regular
	 * workspace picker, which has its own loading affordance.
	 */
	private _renderEmptyStateGate(container: HTMLElement, chatWidgetContent: HTMLElement): IDisposable {
		const store = new DisposableStore();
		const pickerSlot = dom.append(container, dom.$('.session-workspace-picker-slot'));
		const stateDisposables = store.add(new MutableDisposable());

		const showPicker = () => {
			chatWidgetContent.classList.remove('no-agent-host');
			dom.clearNode(pickerSlot);
			stateDisposables.value = this._renderWorkspacePicker(pickerSlot);
			this._renderChatTip();
		};

		const showEmptyState = () => {
			chatWidgetContent.classList.add('no-agent-host');
			dom.clearNode(pickerSlot);
			stateDisposables.value = this._renderEmptyState(pickerSlot);
			this._clearChatTip();
		};

		const filter = this.agentHostFilterService;
		let hasCompletedDiscovery = filter.hosts.length > 0;

		// If no discovery cycle is in flight or has completed yet, kick one
		// off so the empty state can resolve in a bounded time. The
		// `tunnelAgentHost.contribution` already triggers a startup
		// rediscover, but in the (rare) case the view mounts before the
		// contribution gets a chance, this prevents the user from being
		// stuck on a picker that never gets populated.
		if (!hasCompletedDiscovery && !filter.isDiscovering) {
			filter.rediscover();
		}

		const update = () => {
			if (hasCompletedDiscovery && !filter.isDiscovering && filter.hosts.length === 0) {
				showEmptyState();
			} else {
				showPicker();
			}
		};

		update();

		// `onDidChange` fires when the host list changes — entering or
		// leaving the empty state if the last host disconnects or the
		// first host appears.
		store.add(filter.onDidChange(() => {
			if (filter.hosts.length > 0) {
				hasCompletedDiscovery = true;
			}
			update();
		}));
		// `onDidChangeDiscovering` fires on discovery start *and* end; we
		// treat any transition out of discovering as having completed at
		// least one cycle.
		store.add(filter.onDidChangeDiscovering(() => {
			if (!filter.isDiscovering) {
				hasCompletedDiscovery = true;
			}
			update();
		}));

		return store;
	}

	// --- Send ---

	private async _send(query: string, attachedContext?: IChatRequestVariableEntry[], background?: boolean): Promise<boolean> {
		const session = this._session.get();
		if (!session) {
			this._workspacePicker.showPicker();
			return false;
		}
		const feedbackItems = [...this._feedbackItems.get()];
		const workspaceRoots = session.workspace.get()?.folders.map(folder => folder.root)
			?? (this._workspacePicker.selectedFolderUri ? [this._workspacePicker.selectedFolderUri] : []);
		const request = buildNewSessionPrompt(query, feedbackItems, workspaceRoots);

		// Capture the composer's workspace selection before the send: a
		// background send consumes the in-flight new session and resets the
		// new-session view, so we re-seed a fresh pending session afterwards
		// (see below) to keep the composer's pickers functional. Quick chats
		// have no workspace, so they re-seed via openQuickChat instead.
		const wasQuickChat = this._isQuickChatComposer.get();
		const reseedFolderUri = background && !wasQuickChat ? this._workspacePicker.selectedFolderUri : undefined;
		const sendOptions = { query: request, attachedContext, background };
		const clearFeedback = () => {
			for (const item of feedbackItems) {
				this.agentFeedbackService.removeFeedback(AGENT_FEEDBACK_NEW_SESSION_RESOURCE, item.id);
			}
		};
		// A background send is fire-and-forget and the composer immediately reseeds
		// for the next one, so several can be in flight at once. Each is tracked
		// separately, keyed by the options object it was started with, so one
		// send's outcome never clears another's comments.
		if (background) {
			this._pendingBackgroundSends.set(sendOptions, Event.once(
				Event.filter(this.sessionsManagementService.onDidSendRequest, event => event.options === sendOptions)
			)(() => {
				clearFeedback();
				this._pendingBackgroundSends.deleteAndDispose(sendOptions);
			}));
		}

		try {
			await this.sessionsManagementService.sendNewChatRequest(session, sendOptions);
		} catch (e) {
			this._pendingBackgroundSends.deleteAndDispose(sendOptions);
			this.logService.error('Failed to send request:', e);
			return false;
		}

		if (!background) {
			clearFeedback();
		}

		// A background send graduated the composer's in-flight session and
		// returned the view to a fresh (but session-less) new-session composer.
		// The send now commits in the background, so reseed a replacement draft
		// immediately — providers are multi-new-session aware, so the graduating
		// session and this new draft coexist. This restores the
		// session-type/model pickers for the next message.
		if (background) {
			if (wasQuickChat) {
				this.sessionsService.openQuickChat();
			} else if (reseedFolderUri) {
				await this._createNewSession(reseedFolderUri);
			}
		}
		return true;
	}

	private _renderFeedbackBanner(container: HTMLElement): void {
		const host = dom.append(container, dom.$('.session-input-banners.new-session-feedback-banners'));
		const content = this._register(new MutableDisposable<DisposableStore>());
		this._register(autorun(reader => {
			const feedbackItems = this._feedbackItems.read(reader);
			content.clear();
			dom.clearNode(host);
			if (!feedbackItems.length) {
				return;
			}

			const count = feedbackItems.length;
			const text = count === 1
				? localize('newSessionFeedback.one', "1 comment")
				: localize('newSessionFeedback.many', "{0} comments", count);
			const store = new DisposableStore();
			content.value = store;
			const banner = store.add(this.instantiationService.createInstance(SessionInputBannerWidget, {
				icon: Codicon.commentDiscussion,
				accent: false,
				text,
				ariaLabel: text,
				actions: [{
					label: localize('newSessionFeedback.reveal', "Reveal"),
					run: () => this.agentFeedbackService.revealFeedback(AGENT_FEEDBACK_NEW_SESSION_RESOURCE, feedbackItems[0].id),
				}],
			}));
			host.appendChild(banner.domNode);
		}));
	}

	saveState(): void {
		this._newChatInput.saveState();
	}

	layout(_height: number, _width: number): void {
		this._newChatInput.layout(_height, _width);
	}

	focusInput(): void {
		// While the empty state is mounted, the chat input is hidden via
		// CSS (`.no-agent-host` on `.new-chat-widget-content`) so focusing
		// it would just send focus to <body>. Land on the empty state's
		// heading instead so the user has a visible focus target.
		if (this._activeEmptyState) {
			this._activeEmptyState.focus();
			return;
		}
		this._newChatInput.focus();
	}

	/**
	 * Handles a workspace selection from the workspace picker and creates a
	 * new session for it. Workspace trust (when required) is requested by
	 * {@link ISessionsService.openNewSession} itself — a single gate shared
	 * by every path that creates a concrete session for a folder.
	 */
	private async _onWorkspaceSelected(folderUri: URI | undefined): Promise<void> {
		// Cancel any in-flight upgrade for a previous selection.
		this._pendingPreferredUpgrade.clear();

		if (!folderUri) {
			this.sessionsService.unsetNewSession();
			return;
		}

		if (this._store.isDisposed) {
			return;
		}

		const result = await this._createNewSession(folderUri);
		if (result.trustDeclined) {
			// Don't leave the picker showing the declined folder as selected.
			this._workspacePicker.removeFromRecents(folderUri);
		}
	}

	prefillInput(text: string): void {
		this._newChatInput.prefillInput(text);
	}

	setHostVisible(visible: boolean): void {
		this._aquariumToggle?.setHostVisible(visible);
	}

	sendQuery(text: string): void {
		this._newChatInput.sendQuery(text);
	}

	submitInput(): Promise<boolean> {
		if (!this._session.get()) {
			this._workspacePicker.showPicker();
			return Promise.resolve(false);
		}
		return this._newChatInput.submit();
	}

	attach(uris: URI[]): void {
		this._newChatInput.attach(uris);
	}

	attachEntries(...entries: IChatRequestVariableEntry[]): void {
		this._newChatInput.attachEntries(...entries);
	}

	selectWorkspace(folderUri: URI, providerId?: string): void {
		this._workspacePicker.setSelectedWorkspace(folderUri, { providerId });
	}
}

// #endregion
