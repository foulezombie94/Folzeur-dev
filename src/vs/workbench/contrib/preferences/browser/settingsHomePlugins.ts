/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchMcpManagementService, IWorkbenchLocalMcpServer } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';

interface ISmitheryServer {
	readonly qualifiedName: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly iconUrl?: string;
	readonly useCount?: number;
	readonly remote?: boolean;
	readonly deploymentUrl?: string;
	readonly connections?: readonly (string | { readonly type?: string; readonly deploymentUrl?: string })[];
	readonly tools?: readonly { readonly name: string; readonly description?: string }[];
	readonly resources?: readonly { readonly name?: string; readonly description?: string }[];
	readonly prompts?: readonly { readonly name: string; readonly description?: string }[];
	readonly rules?: readonly { readonly name: string; readonly description?: string }[];
	readonly commands?: readonly { readonly name: string; readonly description?: string }[];
	readonly installed?: boolean;
	readonly localServer?: IWorkbenchLocalMcpServer;
}

const SMITHERY_API = 'https://api.smithery.ai/servers';

export function renderSettingsHomePluginsPage(
	main: HTMLElement,
	container: HTMLElement,
	mcpManagementService: IWorkbenchMcpManagementService,
	notificationService: INotificationService,
	disposables: DisposableStore,
	renderHeader: (container: HTMLElement, title: string, lead: string) => void,
	onSelectCategory: (category: string) => void,
	onReRender: () => void
): void {
	renderHeader(main, localize('settingsHomePlugins', "Plugins"), localize('settingsHomePluginsLead', "Extend Appica with skills, rules, agents, hooks and MCP servers."));

	const banner = append(main, $('.settings-home-plugin-banner'));
	const bannerText = append(banner, $('.settings-home-plugin-banner-text'));
	append(bannerText, $('strong', undefined, localize('settingsHomePluginsBannerTitle', "Plugins are moving to Customize")));
	append(bannerText, $('span', undefined, localize('settingsHomePluginsBannerDescription', "Customize is the new home for managing this page.")));
	const customize = append(banner, $('.settings-home-appica-control'));
	const customizeButton = append(customize, $('button.settings-home-plugin-action', { type: 'button' }, localize('settingsHomePluginsCustomize', "Open Customize")));
	disposables.add(addDisposableListener(customizeButton, 'click', () => onSelectCategory('plugins')));

	const heading = append(main, $('.settings-home-plugin-heading'));
	const headingText = append(heading, $('.settings-home-plugin-heading-text'));
	append(headingText, $('h2', undefined, localize('settingsHomePluginsCatalog', "Plugins")));
	append(headingText, $('span', undefined, localize('settingsHomePluginsCatalogDescription', "Discover MCP servers and agent extensions from Smithery.")));
	const browse = append(heading, $('.settings-home-appica-control'));
	const browseButton = append(browse, $('button.settings-home-plugin-action', { type: 'button' }, localize('settingsHomePluginsBrowse', "Browse Marketplace")));
	disposables.add(addDisposableListener(browseButton, 'click', () => window.open('https://smithery.ai/servers', '_blank', 'noopener')));

	const toolbar = append(main, $('.settings-home-plugin-toolbar'));
	const filters = append(toolbar, $('.settings-home-plugin-filters'));
	const all = append(filters, $('button.settings-home-plugin-filter.selected', { type: 'button' }, localize('settingsHomePluginsAll', "All")));
	const user = append(filters, $('button.settings-home-plugin-filter', { type: 'button' }, localize('settingsHomePluginsUser', "User")));
	const search = append(toolbar, $('input.settings-home-plugin-search', { type: 'search', placeholder: localize('settingsHomePluginsSearch', "Search plugins or paste a link"), 'aria-label': localize('settingsHomePluginsSearch', "Search plugins or paste a link") })) as HTMLInputElement;
	const results = append(main, $('.settings-home-plugin-results'));
	let servers: ISmitheryServer[] = [];
	let activeFilter: 'all' | 'user' = 'all';
	let query = '';
	let requestId = 0;

	const renderPluginCard = (parentGrid: HTMLElement, server: ISmitheryServer) => {
		const card = append(parentGrid, $('.settings-home-plugin-card'));
		const icon = append(card, $('.settings-home-plugin-icon'));
		if (server.iconUrl) {
			const image = append(icon, $('img', { src: server.iconUrl, alt: '' })) as HTMLImageElement;
			disposables.add(addDisposableListener(image, 'error', () => { image.remove(); icon.append(renderIcon(Codicon.extensions)); }));
		} else { icon.append(renderIcon(Codicon.extensions)); }
		const text = append(card, $('.settings-home-plugin-card-text'));
		append(text, $('strong', undefined, server.displayName ?? server.qualifiedName));
		const description = server.description?.trim() || server.qualifiedName;
		append(text, $('span', undefined, description.length > 62 ? `${description.slice(0, 59)}…` : description));
		const meta = append(card, $('.settings-home-plugin-meta'));
		if (server.useCount) { append(meta, $('span', undefined, `${server.useCount.toLocaleString()} uses`)); }
		if (server.connections?.length) { append(meta, $('span', undefined, server.connections.join(' · '))); }
		card.append(renderIcon(Codicon.chevronRight));
		disposables.add(addDisposableListener(card, 'click', () => void showPluginDetails(server)));
	};

	const showPluginDetails = async (server: ISmitheryServer): Promise<void> => {
		let details = server;
		try {
			const response = await fetch(`${SMITHERY_API}/${encodeURIComponent(server.qualifiedName)}`);
			if (response.ok) {
				const loaded = await response.json() as ISmitheryServer;
				details = { ...loaded, connections: loaded.connections?.map(item => typeof item === 'string' ? item : item.type ?? 'http') };
			}
		} catch { }
		const overlay = append(container, $('.settings-home-plugin-modal'));
		const dialog = append(overlay, $('.settings-home-plugin-dialog'));
		const back = append(dialog, $('button.settings-home-plugin-back', { type: 'button' }, `← ${localize('settingsHomePluginsBack', "Plugins")}`));
		const close = append(dialog, $('button.settings-home-plugin-close', { type: 'button', 'aria-label': localize('settingsHomePluginsClose', "Close") }));
		close.append(renderIcon(Codicon.close));
		const titleRow = append(dialog, $('.settings-home-plugin-detail-title'));
		if (details.iconUrl) { append(titleRow, $('img.settings-home-plugin-detail-icon', { src: details.iconUrl, alt: '' })); }
		append(titleRow, $('h2', undefined, details.displayName ?? server.qualifiedName));
		append(dialog, $('p', undefined, details.description ?? localize('settingsHomePluginsNoDescription', "MCP server from Smithery.")));
		const connection = (details.connections ?? ['stdio']).join(' · ');
		append(dialog, $('span.settings-home-plugin-detail-meta', undefined, `Connections: ${connection}`));
		renderSmitheryDetailSection(dialog, localize('settingsHomePluginsMcpSection', "MCPs"), [{ name: details.displayName ?? server.qualifiedName, description: localize('settingsHomePluginsMcpDescription', "Model Context Protocol server available through Smithery.") }]);
		renderSmitheryDetailSection(dialog, localize('settingsHomePluginsToolsSection', "Tools"), details.tools ?? []);
		renderSmitheryDetailSection(dialog, localize('settingsHomePluginsResourcesSection', "Resources"), details.resources ?? []);
		renderSmitheryDetailSection(dialog, localize('settingsHomePluginsPromptsSection', "Prompts"), details.prompts ?? []);
		renderSmitheryDetailSection(dialog, localize('settingsHomePluginsCommandsSection', "Commands"), details.commands ?? []);
		renderSmitheryDetailSection(dialog, localize('settingsHomePluginsRulesSection', "Rules"), details.rules ?? []);
		append(dialog, $('p.settings-home-plugin-security-note', undefined, localize('settingsHomePluginsSecurityNote', "Security: installation only adds the declared remote MCP endpoint to your MCP configuration. You confirm the server before it can be used by the agent.")));
		const action = append(dialog, $('.settings-home-appica-control'));
		const installButton = append(action, $('button.settings-home-plugin-action', { type: 'button' }, details.installed ? localize('settingsHomePluginsUninstall', "Uninstall MCP") : localize('settingsHomePluginsInstall', "Install MCP"))) as HTMLButtonElement;
		if (details.installed && details.localServer) {
			disposables.add(addDisposableListener(installButton, 'click', () => void uninstallSmitheryServer(details.localServer!, installButton, dialog, overlay)));
		} else {
			disposables.add(addDisposableListener(installButton, 'click', () => void installSmitheryServer(details, installButton, overlay)));
		}
		disposables.add(addDisposableListener(back, 'click', () => overlay.remove()));
		disposables.add(addDisposableListener(close, 'click', () => overlay.remove()));
	};

	const renderSmitheryDetailSection = (parentSection: HTMLElement, title: string, items: readonly { readonly name?: string; readonly description?: string }[]) => {
		if (!items.length) { return; }
		append(parentSection, $('h3.settings-home-plugin-detail-section-title', undefined, `${title} ${items.length}`));
		const list = append(parentSection, $('.settings-home-plugin-detail-list'));
		for (const item of items.slice(0, 25)) {
			const row = append(list, $('.settings-home-plugin-detail-row'));
			append(row, $('strong', undefined, item.name ?? localize('settingsHomePluginsUnnamedItem', "Unnamed item")));
			if (item.description) { append(row, $('span', undefined, item.description)); }
		}
	};

	const installSmitheryServer = (server: ISmitheryServer, button: HTMLButtonElement, overlay: HTMLElement) => {
		const deploymentUrl = server.deploymentUrl;
		const dialog = overlay.querySelector('.settings-home-plugin-dialog') as HTMLElement | null;
		if (!deploymentUrl || !dialog) {
			if (dialog) { append(dialog, $('p.settings-home-plugin-security-note', undefined, localize('settingsHomePluginsNoInstallConfiguration', "This MCP does not expose an installable remote endpoint. Open its Smithery page to configure it manually."))); }
			return;
		}
		let endpoint: URL;
		try { endpoint = new URL(deploymentUrl); } catch { return; }
		if (endpoint.protocol !== 'https:') {
			append(dialog, $('p.settings-home-plugin-security-note', undefined, localize('settingsHomePluginsUnsafeEndpoint', "Installation was blocked because the MCP endpoint is not HTTPS.")));
			return;
		}
		notificationService.prompt(Severity.Warning, localize('settingsHomePluginsConfirmInstall', "Install this remote MCP server? It may access the services and data allowed by its tools."), [{
			label: localize('settingsHomePluginsConfirmInstallAction', "Install MCP"),
			run: () => void completeSmitheryInstall(server, endpoint, button, dialog, overlay)
		}, {
			label: localize('settingsHomePluginsCancelInstall', "Cancel"),
			run: () => undefined
		}]);
	};

	const completeSmitheryInstall = async (server: ISmitheryServer, endpoint: URL, button: HTMLButtonElement, dialog: HTMLElement, overlay: HTMLElement) => {
		button.disabled = true;
		button.textContent = localize('settingsHomePluginsInstalling', "Installing…");
		try {
			await mcpManagementService.install({
				name: `smithery-${server.qualifiedName.replace(/[^a-zA-Z0-9-_]/g, '-')}`,
				config: { type: McpServerType.REMOTE, url: endpoint.toString(), gallery: `https://smithery.ai/servers/${encodeURIComponent(server.qualifiedName)}` }
			}, { target: ConfigurationTarget.USER });
			overlay.remove();
			onReRender();
		} catch (error) {
			button.disabled = false;
			button.textContent = localize('settingsHomePluginsInstall', "Install MCP");
			append(dialog, $('p.settings-home-plugin-security-note', undefined, error instanceof Error ? error.message : localize('settingsHomePluginsInstallFailed', "The MCP could not be installed.")));
		}
	};

	const uninstallSmitheryServer = (server: IWorkbenchLocalMcpServer, button: HTMLButtonElement, dialog: HTMLElement, overlay: HTMLElement) => {
		notificationService.prompt(Severity.Warning, localize('settingsHomePluginsConfirmUninstall', "Uninstall this MCP server?"), [{
			label: localize('settingsHomePluginsConfirmUninstallAction', "Uninstall MCP"),
			run: () => void completeSmitheryUninstall(server, button, dialog, overlay)
		}, {
			label: localize('settingsHomePluginsCancelUninstall', "Cancel"),
			run: () => undefined
		}]);
	};

	const completeSmitheryUninstall = async (server: IWorkbenchLocalMcpServer, button: HTMLButtonElement, dialog: HTMLElement, overlay: HTMLElement) => {
		button.disabled = true;
		button.textContent = localize('settingsHomePluginsUninstalling', "Uninstalling…");
		try {
			await mcpManagementService.uninstall(server);
			overlay.remove();
			onReRender();
		} catch (error) {
			button.disabled = false;
			button.textContent = localize('settingsHomePluginsUninstall', "Uninstall MCP");
			append(dialog, $('p.settings-home-plugin-security-note', undefined, error instanceof Error ? error.message : localize('settingsHomePluginsUninstallFailed', "The MCP could not be uninstalled.")));
		}
	};

	const renderResults = (items: readonly ISmitheryServer[], loading = false, message?: string) => {
		clearNode(results);
		if (loading) { append(results, $('.settings-home-plugin-state', undefined, localize('settingsHomePluginsLoading', "Loading plugins…"))); return; }
		if (message) { append(results, $('.settings-home-plugin-state', undefined, message)); return; }
		if (items.length === 0) {
			const empty = append(results, $('.settings-home-plugin-empty'));
			append(empty, $('strong', undefined, localize('settingsHomePluginsEmptyTitle', "No plugins")));
			append(empty, $('span', undefined, localize('settingsHomePluginsEmptyDescription', "Browse the marketplace or add a custom MCP server to extend Appica with tools and skills.")));
			const add = append(empty, $('.settings-home-appica-control'));
			const addButton = append(add, $('button.settings-home-plugin-action', { type: 'button' }, localize('settingsHomePluginsAdd', "Add Plugin")));
			disposables.add(addDisposableListener(addButton, 'click', () => window.open('https://smithery.ai/servers', '_blank', 'noopener')));
			return;
		}
		const label = append(results, $('span.settings-home-plugin-suggested-label', undefined, query ? localize('settingsHomePluginsResults', "Results") : localize('settingsHomePluginsSuggested', "Suggested")));
		void label;
		const grid = append(results, $('.settings-home-plugin-grid'));
		for (const server of items) { renderPluginCard(grid, server); }
	};

	const load = async () => {
		const currentRequest = ++requestId;
		renderResults([], true);
		try {
			const searchQuery = query.trim();
			const url = new URL(SMITHERY_API);
			if (searchQuery) { url.searchParams.set('q', searchQuery); }
			url.searchParams.set('page', '1');
			url.searchParams.set('pageSize', '20');
			const response = await fetch(url);
			if (!response.ok) { throw new Error(`Smithery returned ${response.status}`); }
			const payload = await response.json() as { servers?: ISmitheryServer[] };
			if (currentRequest !== requestId) { return; }
			servers = Array.isArray(payload.servers) ? payload.servers : [];
			const installed = await mcpManagementService.getInstalled();
			const installedServers: ISmitheryServer[] = installed.map(local => {
				let qualifiedName = local.name;
				if (local.galleryUrl) {
					try {
						const galleryPath = new URL(local.galleryUrl).pathname;
						const marker = '/servers/';
						const markerIndex = galleryPath.indexOf(marker);
						if (markerIndex >= 0) { qualifiedName = decodeURIComponent(galleryPath.slice(markerIndex + marker.length)); }
					} catch { }
				}
				return {
					qualifiedName,
					displayName: local.displayName ?? local.name,
					description: local.description ?? (local.config.type === McpServerType.REMOTE ? local.config.url : local.name),
					iconUrl: local.icon?.dark,
					connections: [local.config.type === McpServerType.REMOTE ? 'http' : 'stdio'],
					deploymentUrl: local.config.type === McpServerType.REMOTE ? local.config.url : undefined,
					installed: true,
					localServer: local
				};
			});
			const installedByName = new Map(installedServers.map(server => [server.qualifiedName, server]));
			const catalogWithInstallState = servers.map(server => {
				const installed = installedByName.get(server.qualifiedName);
				return installed ? { ...server, installed: true, localServer: installed.localServer } : server;
			});
			const visible = activeFilter === 'user'
				? installedServers.filter(server => !query || `${server.displayName} ${server.qualifiedName}`.toLowerCase().includes(query.toLowerCase()))
				: catalogWithInstallState;
			renderResults(visible.slice(0, 8));
		} catch (error) {
			if (currentRequest === requestId) { renderResults([], false, localize('settingsHomePluginsError', "The Smithery catalog could not be loaded. Check your network connection and try again.")); }
		}
	};

	disposables.add(addDisposableListener(search, 'input', () => { query = search.value; void load(); }));
	disposables.add(addDisposableListener(all, 'click', () => { activeFilter = 'all'; all.classList.add('selected'); user.classList.remove('selected'); void load(); }));
	disposables.add(addDisposableListener(user, 'click', () => { activeFilter = 'user'; user.classList.add('selected'); all.classList.remove('selected'); void load(); }));
	void load();
}
