/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { SettingsHomeInput } from './settingsHomeInput.js';
import { renderAppicaButton, renderAppicaSettingsSpark } from './settingsHomeAppica.js';
import { ISettingsHomeSupabaseAuth } from './settingsHomeSupabaseAuth.js';
import { IWorkbenchMcpManagementService } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IKeybindingEditingService } from '../../../services/keybinding/common/keybindingEditing.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { renderSettingsHomeKeyboardPage } from './settingsHomeKeyboard.js';
import { renderSettingsHomePluginsPage } from './settingsHomePlugins.js';
import './media/settingsHomeEditor.css';

interface ISettingsHomeItem {
	readonly icon: ThemeIcon;
	readonly title: string;
	readonly description: string;
	readonly command: string;
	readonly action: string;
}

type SettingsHomeCategory = string;

export class SettingsHomeEditor extends EditorPane {

	static readonly ID = 'workbench.editor.settingsHome';

	private container!: HTMLElement;
	private content!: HTMLElement;
	private selectedCategory: SettingsHomeCategory = 'general';
	private readonly renderDisposables = this._register(new DisposableStore());
	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISettingsHomeSupabaseAuth private readonly authService: ISettingsHomeSupabaseAuth,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@INotificationService private readonly notificationService: INotificationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IKeybindingEditingService private readonly keybindingEditingService: IKeybindingEditingService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
	) {
		super(SettingsHomeEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = $('.settings-home', {
			role: 'document',
			tabindex: 0,
			'aria-label': localize('settingsHomeAriaLabel', "Settings overview")
		});
		this.content = append(this.container, $('.settings-home-content'));
		parent.append(this.container);
		this._register(this.authService.onDidChangeAccount(() => this.render()));
		this.render();
	}

	override async setInput(input: SettingsHomeInput, options: undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
	}

	override layout(dimension: Dimension): void {
		this.container.style.height = `${dimension.height}px`;
	}

	private render(): void {
		this.renderDisposables.clear();
		clearNode(this.content);

		const sidebar = append(this.content, $('.settings-home-sidebar'));
		const profile = append(sidebar, $('.settings-home-profile'));
		const account = this.authService.getAccount();
		if (account) {
			const initials = (account.name || '')
				.trim()
				.split(/\s+/)
				.slice(0, 2)
				.map(p => p[0])
				.join('')
				.toUpperCase() || 'A';

			const avatar = append(profile, $('.settings-home-avatar', undefined, initials));
			avatar.style.background = '#000000';
			avatar.style.color = '#ffffff';
			avatar.style.fontWeight = '600';

			const profileText = append(profile, $('.settings-home-profile-text'));
			append(profileText, $('strong', undefined, account.name));
			if (account.email) {
				append(profileText, $('span', undefined, account.email));
			}
		} else {
			append(profile, $('.settings-home-avatar', undefined, 'C'));
			const profileText = append(profile, $('.settings-home-profile-text'));
			append(profileText, $('strong', undefined, localize('settingsHomeProfile', "Sign in to your account")));
			append(profileText, $('span', undefined, localize('settingsHomeProfileDescription', "Sync your settings and plan")));
			const profileAction = append(profile, $('button.settings-home-profile-action', { type: 'button' }, localize('settingsHomeSignIn', "Sign In")));
			this.renderDisposables.add(addDisposableListener(profileAction, 'click', () => void this.authService.signInWithGoogle()));
		}

		const search = append(sidebar, $('input.settings-home-search', { type: 'search', placeholder: localize('settingsHomeSearch', "Search settings"), 'aria-label': localize('settingsHomeSearch', "Search settings") })) as HTMLInputElement;

		const navigation = append(sidebar, $('.settings-home-navigation', { role: 'navigation', 'aria-label': localize('settingsHomeNavigation', "Settings categories") }));
		this.addNavigationItem(navigation, Codicon.settingsGear, localize('settingsHomeGeneral', "General"), 'general');
		this.addNavigationItem(navigation, Codicon.account, localize('settingsHomeProfileNav', "Profile"), 'profile');
		this.addNavigationItem(navigation, Codicon.account, localize('settingsHomePlanUsage', "Plan & Usage"), 'plan');
		this.addNavigationItem(navigation, Codicon.hubot, localize('settingsHomeAgents', "Agents"), 'agents');
		this.addNavigationItem(navigation, Codicon.cloud, localize('settingsHomeCloudAgents', "Cloud Agents"), 'cloud-agents');
		append(navigation, $('.settings-home-nav-separator'));
		this.addNavigationItem(navigation, Codicon.symbolColor, localize('settingsHomeModels', "Models"), 'models');
		this.addNavigationItem(navigation, Codicon.gitPullRequest, localize('settingsHomeGit', "Git & Pull Requests"), 'git');
		this.addNavigationItem(navigation, Codicon.extensions, localize('settingsHomePlugins', "Plugins"), 'plugins');
		this.addNavigationItem(navigation, Codicon.notebookTemplate, localize('settingsHomeRules', "Rules, Skills & Subagents"), 'rules');
		this.addNavigationItem(navigation, Codicon.plug, localize('settingsHomeIntegrations', "Integrations"), 'integrations');
		this.addNavigationItem(navigation, Codicon.terminal, localize('settingsHomeTools', "Tools & MCPs"), 'tools');
		this.addNavigationItem(navigation, Codicon.globe, localize('settingsHomeBrowserNetwork', "Browser & Network"), 'browser');
		this.addNavigationItem(navigation, Codicon.layout, localize('settingsHomeLayout', "Layout"), 'appearance');
		this.addNavigationItem(navigation, Codicon.database, localize('settingsHomeIndexing', "Indexing & Docs"), 'indexing');
		this.addNavigationItem(navigation, Codicon.keyboard, localize('settingsHomeKeyboardNav', "Clavier"), 'clavier');
		append(navigation, $('.settings-home-nav-separator'));
		this.addNavigationItem(navigation, Codicon.book, localize('settingsHomeDocs', "Documentation"), 'docs');
		this.renderDisposables.add(addDisposableListener(search, 'input', () => {
			const query = search.value.trim().toLocaleLowerCase();
			for (const item of navigation.querySelectorAll<HTMLButtonElement>('.settings-home-nav-item')) {
				item.style.display = !query || item.textContent?.toLocaleLowerCase().includes(query) ? '' : 'none';
			}
			for (const separator of navigation.querySelectorAll<HTMLElement>('.settings-home-nav-separator')) {
				separator.style.display = query ? 'none' : '';
			}
		}));
		const upgradeLabel = localize('settingsHomeUpgrade', "Upgrade to Pro");
		const upgrade = append(sidebar, $('button.settings-home-upgrade', { type: 'button', 'aria-label': upgradeLabel, title: upgradeLabel }));
		upgrade.append(renderIcon(Codicon.rocket));
		append(upgrade, $('span', undefined, upgradeLabel));
		this.renderDisposables.add(addDisposableListener(upgrade, 'click', () => {
			this.selectedCategory = 'plan';
			this.render();
		}));

		const main = append(this.content, $('.settings-home-main'));
		switch (this.selectedCategory) {
			case 'profile':
				this.renderProfilePage(main);
				break;
			case 'integrations':
				this.renderPageHeader(main, localize('settingsHomeIntegrations', "Integrations"), localize('settingsHomeIntegrationsLead', "Control the connections that extend your application."));
				this.addIntegrationSection(main);
				break;
			case 'appearance':
				this.renderPageHeader(main, localize('settingsHomeAppearance', "Appearance"), localize('settingsHomeAppearanceLead', "Make the application feel like yours."));
				this.addAppearanceSection(main);
				break;
			case 'plugins':
				renderSettingsHomePluginsPage(main, this.container, this.mcpManagementService, this.notificationService, this.renderDisposables, (m, t, l) => this.renderPageHeader(m, t, l), (c) => { this.selectedCategory = c; this.render(); }, () => this.render());
				break;
			case 'git':
				this.renderGitPage(main);
				break;
			case 'rules':
				this.renderRulesPage(main);
				break;
			case 'tools':
				this.renderToolsPage(main);
				break;
			case 'browser':
				this.renderBrowserPage(main);
				break;
			case 'agents':
				this.renderPageHeader(main, localize('settingsHomeAgents', "Agents"), localize('settingsHomeAgentsLead', "Choose how your agents think, work, and request access."));
				this.addAgentRuntimeSection(main);
				break;
			case 'clavier':
			case 'tab':
				renderSettingsHomeKeyboardPage(main, this.keybindingService, this.commandService, this.keybindingEditingService, this.renderDisposables);
				break;
			default:
				this.renderCategoryPage(main);
				break;
		}
	}



	private renderGeneralPage(main: HTMLElement): void {
		this.renderPageHeader(main, localize('settingsHomeTitle', "General"), localize('settingsHomeLead', "Manage the application, your account, and agent workspace."));
		const account = append(main, $('.settings-home-section'));
		append(account, $('h2', undefined, localize('settingsHomeAccount', "Account")));
		this.addSectionRows(account, [
			{ icon: Codicon.account, title: localize('settingsHomeAccountDetails', "Application Account"), description: localize('settingsHomeAccountDetailsDescription', "Manage your profile, plan, and billing."), command: 'workbench.action.openSettings2', action: localize('settingsHomeOpen', "Open") },
			{ icon: Codicon.rocket, title: localize('settingsHomeUpgradeTitle', "Upgrade to Pro"), description: localize('settingsHomeUpgradeDescription', "Access premium models, more agent capacity, and additional tools."), command: 'workbench.action.openSettings2', action: localize('settingsHomeUpgrade', "Upgrade") },
		]);
		const section = append(main, $('.settings-home-section'));
		append(section, $('h2', undefined, localize('settingsHomeQuickControls', "Quick Controls")));
		const card = append(section, $('.settings-home-card'));
		this.addToggleRow(card, localize('settingsHomeAllowTerminal', "Allow integrated terminal"), localize('settingsHomeAllowTerminalDescription', "Allow the agent runtime to use commands in the workspace terminal."), 'chat.api.allowTerminal', true);
		this.addToggleRow(card, localize('settingsHomeTips', "Show tips on the start screen"), localize('settingsHomeTipsDescription', "Keep useful Appica tips visible when no editor is open."), 'appica.startupTips', true);
		this.addToggleRow(card, localize('settingsHomeNotifications', "Agent notifications"), localize('settingsHomeNotificationsDescription', "Notify when an agent finishes or needs your attention."), 'appica.agentNotifications', true);
		this.addToggleRow(card, localize('settingsHomeWarningNotifications', "Warning notifications"), localize('settingsHomeWarningNotificationsDescription', "Show safety and execution warnings as notifications."), 'appica.warningNotifications', true);
		this.addToggleRow(card, localize('settingsHomeCompletionSound', "Completion sound"), localize('settingsHomeCompletionSoundDescription', "Play a short sound when an agent completes a task."), 'appica.completionSound');
		this.addToggleRow(card, localize('settingsHomeDataSharing', "Share anonymous product data"), localize('settingsHomeDataSharingDescription', "Help improve Appica without sharing your workspace content."), 'appica.privacy.dataSharing', false);
		this.addSelectRow(card, localize('settingsHomeRestoreWindows', "Restore windows"), localize('settingsHomeRestoreWindowsDescription', "Choose what Appica restores when it starts."), 'window.restoreWindows', [['preserve', localize('settingsHomeRestorePreserve', 'Restore previous windows')], ['all', localize('settingsHomeRestoreAll', 'Restore all windows')], ['none', localize('settingsHomeRestoreNone', 'Open a new window')]]);
		this.addToggleRow(card, localize('settingsHomeAllowNetwork', "Allow network tools"), localize('settingsHomeAllowNetworkDescription', "Allow explicitly requested network tools."), 'chat.api.allowNetwork', true);
		this.addSection(main, localize('settingsHomeAdvanced', "Advanced"), [
			{ icon: Codicon.code, title: localize('settingsHomeVSCodeSettings', "VS Code Settings"), description: localize('settingsHomeVSCodeSettingsDescription', "Open the underlying editor settings only when you need them."), command: 'workbench.action.openSettings2', action: localize('settingsHomeOpen', "Open") },
		]);
	}

	private renderProfilePage(main: HTMLElement): void {
		this.renderPageHeader(main, localize('settingsHomeProfileTitle', "Profile"), localize('settingsHomeProfileLead', "Manage your Appica identity, account and plan."));
		const account = append(main, $('.settings-home-section'));
		append(account, $('h2', undefined, localize('settingsHomeProfileAccount', "Account")));
		const card = append(account, $('.settings-home-card'));
		const user = this.authService.getAccount();
		this.addTextRow(card, localize('settingsHomeProfileName', "Display name"), localize('settingsHomeProfileNameDescription', "The name shown in your Appica workspace."), user?.name ?? '', 'appica.profile.name');
		this.addTextRow(card, localize('settingsHomeProfileEmail', "Email"), localize('settingsHomeProfileEmailDescription', "Your authenticated Appica email address."), user?.email ?? 'Not connected', undefined, true);
		this.addActionRow(card, Codicon.account, localize('settingsHomeProfileSecurity', "Account security"), localize('settingsHomeProfileSecurityDescription', "Review your login and connected providers."), localize('settingsHomeOpen', "Open"), 'workbench.action.openSettings2');
		this.addActionRow(card, Codicon.signOut, localize('settingsHomeProfileSignOut', "Sign out"), localize('settingsHomeProfileSignOutDescription', "Remove the current Appica session from this device."), localize('settingsHomeSignOut', "Sign Out"), undefined, () => this.authService.signOut());
		this.addSection(main, localize('settingsHomePlan', "Plan"), [{ icon: Codicon.rocket, title: localize('settingsHomeProfilePlanTitle', "Appica Pro"), description: localize('settingsHomeProfilePlanDescription', "More agent capacity, models and workspace tools."), command: 'workbench.action.openSettings2', action: localize('settingsHomeUpgrade', "Upgrade") }]);
	}

	private renderGitPage(main: HTMLElement): void {
		this.renderPageHeader(main, localize('settingsHomeGit', "Git & Pull Requests"), localize('settingsHomeGitLead', "Connect source control to your agent workflow."));
		const section = append(main, $('.settings-home-section'));
		append(section, $('h2', undefined, localize('settingsHomePullRequests', "Pull Requests")));
		const card = append(section, $('.settings-home-card'));
		this.addSelectRow(card, localize('settingsHomeGitProvider', "Pull request provider"), localize('settingsHomeGitProviderDescription', "Choose where Appica opens and creates pull requests."), 'appica.git.provider', [['github', 'GitHub'], ['gitlab', 'GitLab'], ['bitbucket', 'Bitbucket']]);
		this.addSelectRow(card, localize('settingsHomeGitLinks', "PR link destination"), localize('settingsHomeGitLinksDescription', "Open pull request links in Appica or your default browser."), 'appica.git.linkDestination', [['app', 'Appica'], ['browser', 'Default browser']]);
		this.addToggleRow(card, localize('settingsHomeGitAttribution', "Add AI attribution"), localize('settingsHomeGitAttributionDescription', "Mark commits and pull requests created with an agent."), 'appica.git.attribution', true);
		this.addTextRow(card, localize('settingsHomeGitBranchPrefix', "Agent branch prefix"), localize('settingsHomeGitBranchPrefixDescription', "Prefix used for new branches created by an agent."), this.configurationService.getValue<string>('appica.git.branchPrefix') ?? 'appica/', 'appica.git.branchPrefix');
	}

	private renderRulesPage(main: HTMLElement): void {
		this.renderPageHeader(main, localize('settingsHomeRules', "Rules, Skills & Subagents"), localize('settingsHomeRulesLead', "Guide how agents reason and delegate work."));
		const section = append(main, $('.settings-home-section'));
		append(section, $('h2', undefined, localize('settingsHomeRulesSection', "Workspace instructions")));
		const card = append(section, $('.settings-home-card'));
		this.addToggleRow(card, localize('settingsHomeThirdPartyRules', "Allow third-party configurations"), localize('settingsHomeThirdPartyRulesDescription', "Load trusted rules and skills from configured locations."), 'chat.api.allowThirdPartyConfigs', false);
		this.addTextRow(card, localize('settingsHomeRulesPath', "Rules location"), localize('settingsHomeRulesPathDescription', "A folder or file containing instructions for your agents."), this.configurationService.getValue<string>('appica.rules.path') ?? '.appica/rules', 'appica.rules.path');
		this.addTextRow(card, localize('settingsHomeSkillsPath', "Skills location"), localize('settingsHomeSkillsPathDescription', "A folder containing reusable expert skills."), this.configurationService.getValue<string>('appica.skills.path') ?? '.appica/skills', 'appica.skills.path');
		this.addActionRow(card, Codicon.add, localize('settingsHomeAddSkill', "Add a skill"), localize('settingsHomeAddSkillDescription', "Open the command palette to create a reusable skill."), localize('settingsHomeAdd', "Add"), 'workbench.action.quickOpen');
		this.addActionRow(card, Codicon.serverProcess, localize('settingsHomeSubagents', "Subagents"), localize('settingsHomeSubagentsDescription', "Configure specialist agents that can work in parallel."), localize('settingsHomeConfigure', "Configure"), 'workbench.action.openSettings2');
	}

	private renderToolsPage(main: HTMLElement): void {
		this.renderPageHeader(main, localize('settingsHomeTools', "Tools & MCPs"), localize('settingsHomeToolsLead', "Control the tools and MCP servers available to agents."));
		const section = append(main, $('.settings-home-section'));
		append(section, $('h2', undefined, localize('settingsHomeToolsPermissions', "Permissions")));
		const card = append(section, $('.settings-home-card'));
		this.addToggleRow(card, localize('settingsHomeAllowMcp', "Allow MCP connections"), localize('settingsHomeAllowMcpDescription', "Allow configured Model Context Protocol servers."), 'chat.api.allowMcp');
		this.addToggleRow(card, localize('settingsHomeMcpAutoApprove', "Auto-approve MCP tools"), localize('settingsHomeMcpAutoApproveDescription', "Run approved MCP tools without asking every time."), 'chat.api.mcpAutoApprove');
		this.addToggleRow(card, localize('settingsHomeAllowPlugins', "Allow agent plugins"), localize('settingsHomeAllowPluginsDescription', "Allow configured plugins after their normal approval checks."), 'chat.api.allowPlugins');
		this.addTextRow(card, localize('settingsHomeMcpDomains', "Fetch domain allowlist"), localize('settingsHomeMcpDomainsDescription', "Comma-separated domains agents may fetch content from."), this.configurationService.getValue<string>('chat.api.fetchDomainAllowlist') ?? 'github.com, npmjs.com', 'chat.api.fetchDomainAllowlist');
		this.addActionRow(card, Codicon.serverProcess, localize('settingsHomeManageMcp', "Manage MCP servers"), localize('settingsHomeManageMcpDescription', "Open the full MCP configuration."), localize('settingsHomeOpen', "Open"), 'workbench.action.openSettings2');
	}

	private renderBrowserPage(main: HTMLElement): void {
		this.renderPageHeader(main, localize('settingsHomeBrowserNetwork', "Browser & Network"), localize('settingsHomeBrowserNetworkLead', "Control browsing, links and network access."));
		const section = append(main, $('.settings-home-section'));
		append(section, $('h2', undefined, localize('settingsHomeBrowserAutomation', "Browser automation")));
		const card = append(section, $('.settings-home-card'));
		this.addToggleRow(card, localize('settingsHomeOpenLinksInBrowser', "Open links in Appica Browser"), localize('settingsHomeOpenLinksInBrowserDescription', "Open localhost links and web pages in the integrated browser."), 'workbench.browser.openLocalhostLinks', true);
		this.addToggleRow(card, localize('settingsHomeBrowserAgentTools', "Allow browser agent tools"), localize('settingsHomeBrowserAgentToolsDescription', "Let agents inspect and interact with browser pages."), 'workbench.browser.enableChatTools');
		this.addSelectRow(card, localize('settingsHomeNetworkProtocol', "Network protocol"), localize('settingsHomeNetworkProtocolDescription', "Select the preferred HTTP protocol for network requests."), 'appica.network.protocol', [['auto', 'Automatic'], ['http1', 'HTTP/1.1'], ['http2', 'HTTP/2']]);
		this.addActionRow(card, Codicon.debugConsole, localize('settingsHomeNetworkDiagnostics', "Network diagnostics"), localize('settingsHomeNetworkDiagnosticsDescription', "Run a quick connectivity check for your agent services."), localize('settingsHomeRun', "Run"), 'workbench.action.toggleDevTools');
	}

	private renderCategoryPage(main: HTMLElement): void {
		const category = this.selectedCategory === 'general' ? undefined : this.selectedCategory;
		if (!category) {
			this.renderGeneralPage(main);
			return;
		}
		const page = new Map<string, readonly [string, string, ThemeIcon]>([
			['plan', [localize('settingsHomePlanUsage', "Plan & Usage"), localize('settingsHomePlanUsageLead', "Manage your plan and understand current usage."), Codicon.account]],
			['cloud-agents', [localize('settingsHomeCloudAgents', "Cloud Agents"), localize('settingsHomeCloudAgentsLead', "Configure remote environments for your agents."), Codicon.cloud]],
			['models', [localize('settingsHomeModels', "Models"), localize('settingsHomeModelsLead', "Manage the models available to your agents."), Codicon.symbolColor]],
			['git', [localize('settingsHomeGit', "Git & Pull Requests"), localize('settingsHomeGitLead', "Connect source control to your agent workflow."), Codicon.gitPullRequest]],
			['plugins', [localize('settingsHomePlugins', "Plugins"), localize('settingsHomePluginsLead', "Add capabilities from trusted plugins."), Codicon.extensions]],
			['rules', [localize('settingsHomeRules', "Rules, Skills & Subagents"), localize('settingsHomeRulesLead', "Guide how agents reason and delegate work."), Codicon.notebookTemplate]],
			['tools', [localize('settingsHomeTools', "Tools & MCPs"), localize('settingsHomeToolsLead', "Control the tools and MCP servers available to agents."), Codicon.terminal]],
			['browser', [localize('settingsHomeBrowserNetwork', "Browser & Network"), localize('settingsHomeBrowserNetworkLead', "Control browsing and network access."), Codicon.globe]],
			['indexing', [localize('settingsHomeIndexing', "Indexing & Docs"), localize('settingsHomeIndexingLead', "Manage indexing and documentation sources."), Codicon.database]],
			['docs', [localize('settingsHomeDocs', "Documentation"), localize('settingsHomeDocsLead', "Learn how to get the most from your application."), Codicon.book]],
		]).get(category);
		if (!page) {
			this.renderGeneralPage(main);
			return;
		}
		this.renderPageHeader(main, page[0], page[1]);
		if (['plan', 'cloud-agents', 'models', 'plugins', 'integrations', 'indexing', 'docs'].includes(category)) {
			this.renderExtendedCategoryPage(main, category);
			return;
		}
		this.addSection(main, localize('settingsHomeComingSoon', "Configuration"), [
			{ icon: page[2], title: localize('settingsHomeConfigurePage', "Configure {0}", page[0]), description: localize('settingsHomeConfigurePageDescription', "This application area is ready for its workspace configuration."), command: 'workbench.action.openSettings2', action: localize('settingsHomeConfigure', "Configure") },
		]);
	}

	private renderExtendedCategoryPage(main: HTMLElement, category: string): void {
		const section = append(main, $('.settings-home-section'));
		const card = append(section, $('.settings-home-card'));
		switch (category) {
			case 'plan':
				append(section, $('h2', undefined, localize('settingsHomePlanOverview', "Usage overview")));
				this.addSelectRow(card, localize('settingsHomePlanModelBudget', "Model budget"), localize('settingsHomePlanModelBudgetDescription', "Choose how much capacity agents can use per task."), 'appica.plan.modelBudget', [['balanced', 'Balanced'], ['quality', 'Quality first'], ['economy', 'Economy']]);
				this.addActionRow(card, Codicon.rocket, localize('settingsHomePlanUpgrade', "Upgrade your plan"), localize('settingsHomePlanUpgradeDescription', "Unlock more capacity and advanced agent features."), localize('settingsHomePlanUpgradeAction', "Upgrade"), 'workbench.action.openSettings2');
				break;
			case 'cloud-agents':
				append(section, $('h2', undefined, localize('settingsHomeCloudEnvironment', "Cloud environment")));
				this.addSelectRow(card, localize('settingsHomeCloudRegion', "Default region"), localize('settingsHomeCloudRegionDescription', "Choose where remote agent workspaces are created."), 'appica.cloud.region', [['auto', 'Automatic'], ['eu', 'Europe'], ['us', 'United States']]);
				this.addToggleRow(card, localize('settingsHomeCloudReuse', "Reuse cloud workspaces"), localize('settingsHomeCloudReuseDescription', "Keep a remote workspace available between agent tasks."), 'appica.cloud.reuseWorkspace', true);
				this.addActionRow(card, Codicon.cloud, localize('settingsHomeCloudManage', "Manage cloud workspaces"), localize('settingsHomeCloudManageDescription', "Open the cloud workspace manager."), localize('settingsHomeOpen', "Open"), 'workbench.action.openSettings2');
				break;
			case 'models':
				append(section, $('h2', undefined, localize('settingsHomeModelsAvailable', "Available models")));
				this.addSelectRow(card, localize('settingsHomeDefaultModel', "Default model"), localize('settingsHomeDefaultModelDescription', "The model selected for new agent conversations."), 'chat.api.model', [['auto', 'Automatic'], ['fast', 'Fast'], ['reasoning', 'Reasoning'], ['local', 'Local']]);
				this.addToggleRow(card, localize('settingsHomeFallbackModel', "Allow fallback models"), localize('settingsHomeFallbackModelDescription', "Use another configured model when the selected model is unavailable."), 'appica.models.allowFallback', true);
				this.addActionRow(card, Codicon.symbolColor, localize('settingsHomeModelKeys', "Model connections"), localize('settingsHomeModelKeysDescription', "Configure provider keys and local model endpoints."), localize('settingsHomeConfigure', "Configure"), 'workbench.action.openSettings2');
				break;
			case 'plugins':
				append(section, $('h2', undefined, localize('settingsHomePluginSources', "Plugin sources")));
				this.addToggleRow(card, localize('settingsHomePluginMarketplace', "Use the Appica marketplace"), localize('settingsHomePluginMarketplaceDescription', "Show trusted plugins and skills from the marketplace."), 'appica.plugins.marketplace', true);
				this.addToggleRow(card, localize('settingsHomePluginThirdParty', "Allow third-party plugins"), localize('settingsHomePluginThirdPartyDescription', "Allow plugins installed from a local folder or URL."), 'chat.api.allowPlugins');
				this.addActionRow(card, Codicon.extensions, localize('settingsHomePluginManage', "Manage installed plugins"), localize('settingsHomePluginManageDescription', "Open the Extensions view to install or remove plugins."), localize('settingsHomeOpen', "Open"), 'workbench.action.extensions');
				break;
			case 'integrations':
				append(section, $('h2', undefined, localize('settingsHomeIntegrationConnections', "Connections")));
				this.addToggleRow(card, localize('settingsHomeIntegrationMcp', "MCP connections"), localize('settingsHomeIntegrationMcpDescription', "Allow tools to connect to configured MCP servers."), 'chat.api.allowMcp');
				this.addToggleRow(card, localize('settingsHomeIntegrationGit', "Source control integrations"), localize('settingsHomeIntegrationGitDescription', "Allow agents to inspect repositories and pull requests."), 'appica.integrations.git', true);
				this.addActionRow(card, Codicon.plug, localize('settingsHomeIntegrationAdd', "Add an integration"), localize('settingsHomeIntegrationAddDescription', "Open the integration configuration."), localize('settingsHomeAdd', "Add"), 'workbench.action.openSettings2');
				break;
			case 'indexing':
				append(section, $('h2', undefined, localize('settingsHomeIndexingSources', "Sources")));
				this.addToggleRow(card, localize('settingsHomeIndexingWorkspace', "Index the workspace"), localize('settingsHomeIndexingWorkspaceDescription', "Make project files available as agent context."), 'appica.indexing.workspace', true);
				this.addToggleRow(card, localize('settingsHomeIndexingDocs', "Index documentation"), localize('settingsHomeIndexingDocsDescription', "Include project documentation and README files."), 'appica.indexing.docs', true);
				this.addTextRow(card, localize('settingsHomeIndexingIgnored', "Ignored patterns"), localize('settingsHomeIndexingIgnoredDescription', "Patterns excluded from indexing."), this.configurationService.getValue<string>('appica.indexing.ignored') ?? '**/node_modules/**', 'appica.indexing.ignored');
				break;
			case 'docs':
				append(section, $('h2', undefined, localize('settingsHomeDocsResources', "Resources")));
				this.addActionRow(card, Codicon.book, localize('settingsHomeDocsOpen', "Appica documentation"), localize('settingsHomeDocsOpenDescription', "Open guides for agents, tools, and settings."), localize('settingsHomeOpen', "Open"), 'workbench.action.openSettings2');
				this.addActionRow(card, Codicon.question, localize('settingsHomeDocsReport', "Report a problem"), localize('settingsHomeDocsReportDescription', "Send feedback about this settings experience."), localize('settingsHomeOpen', "Open"), 'workbench.action.openIssueReporter');
				this.addToggleRow(card, localize('settingsHomeDocsTips', "Show contextual tips"), localize('settingsHomeDocsTipsDescription', "Show short explanations near advanced settings."), 'appica.docs.contextualTips', true);
				break;
		}
	}

	private renderPageHeader(main: HTMLElement, title: string, lead: string): void {
		append(main, $('h1', undefined, title));
		append(main, $('p.settings-home-lead', undefined, lead));
		const notice = append(main, $('.settings-home-notice'));
		const noticeIcon = append(notice, $('.settings-home-appica-icon'));
		this.renderDisposables.add(renderAppicaSettingsSpark(noticeIcon));
		const noticeText = append(notice, $('.settings-home-notice-text'));
		append(noticeText, $('strong', undefined, localize('settingsHomeNoticeTitle', "Application settings")));
		append(noticeText, $('span', undefined, localize('settingsHomeNoticeDescription', "These controls apply to the app and its agents, not the VS Code settings editor.")));
	}

	private addIntegrationSection(container: HTMLElement): void {
		const section = append(container, $('.settings-home-section'));
		append(section, $('h2', undefined, localize('settingsHomeConnections', "Connections")));
		const card = append(section, $('.settings-home-card'));
		this.addToggleRow(card, localize('settingsHomeAllowMcp', "Allow MCP connections"), localize('settingsHomeAllowMcpDescription', "Allow Model Context Protocol servers configured for this workspace."), 'chat.api.allowMcp');
		this.addToggleRow(card, localize('settingsHomeAllowPlugins', "Allow agent plugins"), localize('settingsHomeAllowPluginsDescription', "Allow configured plugins after their normal approval checks."), 'chat.api.allowPlugins');
	}

	private addAppearanceSection(container: HTMLElement): void {
		const section = append(container, $('.settings-home-section'));
		append(section, $('h2', undefined, localize('settingsHomeInterface', "Interface")));
		const card = append(section, $('.settings-home-card'));
		this.addActionRow(card, Codicon.paintcan, localize('settingsHomeTheme', "Color theme"), localize('settingsHomeThemeDescription', "Choose the theme used throughout the application."), localize('settingsHomeChoose', "Choose"), 'workbench.action.selectTheme');
		this.addSelectRow(card, localize('settingsHomeChatDensity', "Chat density"), localize('settingsHomeChatDensityDescription', "Choose a compact or detailed conversation layout."), 'appica.chat.density', [['compact', 'Compact'], ['detailed', 'Detailed']]);
		this.addToggleRow(card, localize('settingsHomeCodeWrap', "Code block word wrap"), localize('settingsHomeCodeWrapDescription', "Wrap long code blocks inside agent conversations."), 'appica.chat.codeWrap', true);
		this.addToggleRow(card, localize('settingsHomeDiffBackgrounds', "Themed diff backgrounds"), localize('settingsHomeDiffBackgroundsDescription', "Use subtle colors for inline changes and diffs."), 'appica.chat.themedDiffs', true);
		this.addToggleRow(card, localize('settingsHomeReduceTransparency', "Reduce transparency"), localize('settingsHomeReduceTransparencyDescription', "Use more opaque surfaces throughout the interface."), 'window.titleBarStyle.reduceTransparency');
		this.addSelectRow(card, localize('settingsHomeUiFontSize', "Interface font size"), localize('settingsHomeUiFontSizeDescription', "Adjust the size of labels and controls."), 'window.zoomLevel', [['0', 'Default'], ['1', 'Large'], ['2', 'Extra large']]);
		this.addSelectRow(card, localize('settingsHomeEditorFontSize', "Editor font size"), localize('settingsHomeEditorFontSizeDescription', "Adjust the code editor font size."), 'editor.fontSize', [['12', '12 px'], ['14', '14 px'], ['16', '16 px'], ['18', '18 px']]);
		this.addTextRow(card, localize('settingsHomeFontFamily', "Font family"), localize('settingsHomeFontFamilyDescription', "Font family used by the editor."), this.configurationService.getValue<string>('editor.fontFamily') ?? 'monospace', 'editor.fontFamily');
		this.addActionRow(card, Codicon.keyboard, localize('settingsHomeKeyboard', "Keyboard shortcuts"), localize('settingsHomeKeybindingsDescription', "Configure commands and shortcuts."), localize('settingsHomeOpen', "Open"), 'workbench.action.openGlobalKeybindings');
	}



	private addSelectRow(card: HTMLElement, title: string, description: string, key: string, options: readonly (readonly [string, string])[]): void {
		const row = this.createSettingRow(card, title, description);
		const select = append(row, $('select.settings-home-select', { 'aria-label': title })) as HTMLSelectElement;
		for (const [value, label] of options) { append(select, $('option', { value }, label)); }
		select.value = this.configurationService.getValue<string>(key) ?? options[0][0];
		this.renderDisposables.add(addDisposableListener(select, 'change', () => this.configurationService.updateValue(key, select.value, ConfigurationTarget.USER)));
	}

	private addTextRow(card: HTMLElement, title: string, description: string, value: string, key?: string, readonly = false): void {
		const row = this.createSettingRow(card, title, description);
		const input = append(row, $('input.settings-home-text', { type: 'text', value, 'aria-label': title, readonly: readonly ? 'true' : undefined })) as HTMLInputElement;
		if (key && !readonly) { this.renderDisposables.add(addDisposableListener(input, 'change', () => this.configurationService.updateValue(key, input.value.trim(), ConfigurationTarget.USER))); }
	}

	private addActionRow(card: HTMLElement, icon: ThemeIcon, title: string, description: string, label: string, command?: string, action?: () => void | Promise<void>): void {
		const row = append(card, $('.settings-home-row'));
		const iconContainer = append(row, $('.settings-home-row-icon'));
		iconContainer.append(renderIcon(icon));
		const text = append(row, $('.settings-home-row-text'));
		append(text, $('strong', undefined, title));
		append(text, $('span', undefined, description));
		const control = append(row, $('.settings-home-appica-control'));
		this.renderDisposables.add(renderAppicaButton(control, label, () => action ? void action() : command ? void this.commandService.executeCommand(command) : undefined));
	}

	private createSettingRow(card: HTMLElement, title: string, description: string): HTMLElement {
		const row = append(card, $('.settings-home-row'));
		const text = append(row, $('.settings-home-row-text'));
		append(text, $('strong', undefined, title));
		append(text, $('span', undefined, description));
		return row;
	}

	private addToggleRow(card: HTMLElement, title: string, description: string, key: string, defaultValue = false): void {
		const row = this.createSettingRow(card, title, description);
		const toggle = append(row, $('button.settings-home-toggle', { type: 'button', role: 'switch', 'aria-label': title })) as HTMLButtonElement;
		const update = (enabled: boolean) => {
			toggle.classList.toggle('checked', enabled);
			toggle.setAttribute('aria-checked', String(enabled));
			toggle.title = enabled ? localize('settingsHomeEnabled', "Enabled") : localize('settingsHomeDisabled', "Disabled");
		};
		update(this.configurationService.getValue<boolean>(key) ?? defaultValue);
		this.renderDisposables.add(addDisposableListener(toggle, 'click', async () => {
			const enabled = toggle.getAttribute('aria-checked') !== 'true';
			await this.configurationService.updateValue(key, enabled, ConfigurationTarget.USER);
			update(enabled);
		}));
	}

	private addNavigationItem(container: HTMLElement, icon: ThemeIcon, label: string, category: SettingsHomeCategory): void {
		const selected = this.selectedCategory === category;
		const item = append(container, $('button.settings-home-nav-item', { type: 'button', 'aria-current': selected ? 'page' : undefined }));
		item.classList.toggle('selected', selected);
		item.setAttribute('aria-label', label);
		item.title = label;
		item.append(renderIcon(icon));
		item.append($('span.settings-home-nav-label', undefined, label));
		this.renderDisposables.add(addDisposableListener(item, 'click', () => {
			this.selectedCategory = category;
			this.render();
		}));
	}

	private addSection(container: HTMLElement, title: string, items: readonly ISettingsHomeItem[]): void {
		const section = append(container, $('.settings-home-section'));
		append(section, $('h2', undefined, title));
		this.addSectionRows(section, items);
	}

	private addSectionRows(section: HTMLElement, items: readonly ISettingsHomeItem[]): void {
		const card = append(section, $('.settings-home-card'));
		for (const item of items) {
			const row = append(card, $('.settings-home-row'));
			const icon = append(row, $('.settings-home-row-icon'));
			icon.append(renderIcon(item.icon));
			const text = append(row, $('.settings-home-row-text'));
			append(text, $('strong', undefined, item.title));
			append(text, $('span', undefined, item.description));
			const action = append(row, $('.settings-home-appica-control'));
			this.renderDisposables.add(renderAppicaButton(action, item.action, () => this.commandService.executeCommand(item.command)));
		}
	}

	private addAgentRuntimeSection(container: HTMLElement): void {
		const section = append(container, $('.settings-home-section'));
		append(section, $('h2', undefined, localize('settingsHomeAgentRuntime', "Agent Runtime")));
		const card = append(section, $('.settings-home-card'));

		const providerRow = this.createSettingRow(card, localize('settingsHomeProvider', "AI Provider"), localize('settingsHomeProviderDescription', "Choose the model service used by the native agent."));
		const provider = append(providerRow, $('select.settings-home-select', { 'aria-label': localize('settingsHomeProvider', "AI Provider") })) as HTMLSelectElement;
		for (const [value, label] of [
			['none', localize('settingsHomeProviderNone', "Disabled")],
			['ollama', localize('settingsHomeProviderOllama', "Ollama (local)")],
			['openai', "OpenAI"],
			['claude', "Anthropic Claude"],
			['gemini', "Google Gemini"],
		] as const) {
			append(provider, $('option', { value }, label));
		}
		provider.value = this.configurationService.getValue<string>('chat.api.provider') ?? 'none';

		const keyStatusRow = this.createSettingRow(card, localize('settingsHomeApiKeyStatus', "API key status"), localize('settingsHomeApiKeyStatusDescription', "The key is persisted in the operating system secure storage; it is never written to settings.json."));
		const keyStatus = append(keyStatusRow, $('.settings-home-appica-control'));
		const refreshKeyStatus = async () => {
			clearNode(keyStatus);
			if (provider.value === 'none') {
				append(keyStatus, $('span', undefined, localize('settingsHomeApiKeyDisabled', "Provider disabled")));
				return;
			}
			const storedKey = await this.secretStorageService.get(`chat.api.${provider.value}.key`);
			const label = storedKey?.trim()
				? localize('settingsHomeApiKeyConfigured', "Configured · ••••••••{0}", storedKey.trim().slice(-4))
				: localize('settingsHomeApiKeyMissing', "Not configured");
			append(keyStatus, $('span', undefined, label));
		};
		void refreshKeyStatus();
		this.renderDisposables.add(this.secretStorageService.onDidChangeSecret(key => {
			if (key === `chat.api.${provider.value}.key`) {
				void refreshKeyStatus();
			}
		}));

		// Inject Secure API Key Button right after Provider
		this.addActionRow(card, Codicon.key, localize('settingsHomeSetKey', "Set API Key securely"), localize('settingsHomeSetKeyDescription', "Save your provider key safely to the OS keychain."), localize('settingsHomeSet', "Set Key"), 'folzeur.agent.setApiKey');
		this.addActionRow(card, Codicon.trash, localize('settingsHomeClearKey', "Clear stored API key"), localize('settingsHomeClearKeyDescription', "Remove the selected provider key from secure storage."), localize('settingsHomeClear', "Clear"), 'folzeur.agent.clearApiKey');

		const modelRow = this.createSettingRow(card, localize('settingsHomeModel', "Model"), localize('settingsHomeModelDescription', "The model identifier sent to the selected provider."));

		// Create a container for the model input (can be text or select)
		const modelContainer = append(modelRow, $('.settings-home-appica-control'));

		const modelKey = () => provider.value === 'ollama' ? 'localAI.model' : `chat.api.${provider.value}.model`;

		const refreshModel = () => {
			while (modelContainer.firstChild) {
				modelContainer.firstChild.remove();
			} // Clear existing safely without triggering Trusted Types

			if (provider.value === 'gemini') {
				// Dropdown for Gemini Models
				const select = append(modelContainer, $('select.settings-home-select', { 'aria-label': localize('settingsHomeModel', "Model") })) as HTMLSelectElement;
				const options = [
					['gemini-3.1-pro-preview', 'Gemini 3.1 Pro'],
					['gemini-3.6-flash', 'Gemini 3.6 Flash'],
					['gemini-3.5-flash', 'Gemini 3.5 Flash'],
					['gemini-3-flash-preview', 'Gemini 3 Flash'],
					['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'],
					['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite']
				];
				for (const [val, label] of options) {
					append(select, $('option', { value: val }, label));
				}
				select.value = this.configurationService.getValue<string>(modelKey()) ?? 'gemini-3.6-flash';
				this.renderDisposables.add(addDisposableListener(select, 'change', () => this.configurationService.updateValue(modelKey(), select.value, ConfigurationTarget.USER)));
			} else {
				// Text input for others
				const fallback = provider.value === 'ollama' ? 'qwen2.5-coder:7b' : '';
				const input = append(modelContainer, $('input.settings-home-text', { type: 'text', 'aria-label': localize('settingsHomeModel', "Model") })) as HTMLInputElement;
				input.value = this.configurationService.getValue<string>(modelKey()) ?? fallback;
				input.disabled = provider.value === 'none';
				this.renderDisposables.add(addDisposableListener(input, 'change', () => this.configurationService.updateValue(modelKey(), input.value.trim(), ConfigurationTarget.USER)));
			}
		};

		refreshModel();

		this.renderDisposables.add(addDisposableListener(provider, 'change', async () => {
			await this.configurationService.updateValue('chat.api.provider', provider.value, ConfigurationTarget.USER);
			refreshModel();
			void refreshKeyStatus();
		}));

		this.addToggleRow(card, localize('settingsHomeAutoApprove', "Approve tool requests automatically"), localize('settingsHomeAutoApproveDescription', "Let the agent execute requested tools without showing a confirmation for each operation."), 'chat.api.autoApproveTools');
		this.addToggleRow(card, localize('settingsHomeAllowTerminal', "Allow integrated terminal"), localize('settingsHomeAllowTerminalDescription', "Allow the agent runtime to use commands in the workspace terminal."), 'chat.api.allowTerminal', true);
		this.addToggleRow(card, localize('settingsHomeAllowNetwork', "Allow network tools"), localize('settingsHomeAllowNetworkDescription', "Allow explicitly requested network tools. Provider traffic remains protected separately."), 'chat.api.allowNetwork', true);
		this.addToggleRow(card, localize('settingsHomeAllowMcp', "Allow MCP connections"), localize('settingsHomeAllowMcpDescription', "Allow Model Context Protocol servers when they are configured for this workspace."), 'chat.api.allowMcp');
		this.addToggleRow(card, localize('settingsHomeAllowPlugins', "Allow agent plugins"), localize('settingsHomeAllowPluginsDescription', "Allow configured runtime plugins after their normal approval checks."), 'chat.api.allowPlugins');
		this.addSelectRow(card, localize('settingsHomeSubmitKey', "Submit prompts with"), localize('settingsHomeSubmitKeyDescription', "Choose the keyboard shortcut used to send an agent request."), 'appica.agent.submitKey', [['enter', 'Enter'], ['ctrl-enter', 'Ctrl + Enter'], ['cmd-enter', 'Cmd + Enter']]);
		this.addToggleRow(card, localize('settingsHomeQueueMessages', "Queue messages while running"), localize('settingsHomeQueueMessagesDescription', "Hold new messages until the current agent turn is complete."), 'appica.agent.queueMessages', true);
		this.addToggleRow(card, localize('settingsHomeAutoComplete', "Agent auto-complete"), localize('settingsHomeAutoCompleteDescription', "Suggest the next action when an agent reaches a decision point."), 'appica.agent.autoComplete', true);
		this.addToggleRow(card, localize('settingsHomeWebSearch', "Web search tool"), localize('settingsHomeWebSearchDescription', "Allow agents to search the web when a task needs fresh information."), 'chat.api.allowWebSearch', true);
		this.addToggleRow(card, localize('settingsHomeFetchContent', "Fetch linked content"), localize('settingsHomeFetchContentDescription', "Allow agents to read pages referenced in a task."), 'chat.api.allowFetch', true);
		this.addToggleRow(card, localize('settingsHomeBrowserTool', "Browser tool"), localize('settingsHomeBrowserToolDescription', "Allow agents to control an isolated browser for web tasks."), 'chat.api.allowBrowser', true);
		this.addToggleRow(card, localize('settingsHomeModelDownloads', "Local model downloads"), localize('settingsHomeModelDownloadsDescription', "Allow the code index to download embedding and reranking models. Lexical code search remains available when disabled."), 'chat.api.allowModelDownloads', true);
		this.addSelectRow(card, localize('settingsHomeTerminalMode', "Terminal execution mode"), localize('settingsHomeTerminalModeDescription', "Choose how commands requested by agents are approved."), 'chat.api.terminalMode', [['ask', 'Ask every time'], ['allowlist', 'Allowlist'], ['auto', 'Auto-approve']]);
		this.addTextRow(card, localize('settingsHomeTerminalAllowlist', "Terminal allowlist"), localize('settingsHomeTerminalAllowlistDescription', "Commands that may run without an additional prompt."), this.configurationService.getValue<string>('chat.api.terminalAllowlist') ?? 'git status, git diff, git log, npm test, npm run test, npm run compile, cargo test', 'chat.api.terminalAllowlist');
	}
}
