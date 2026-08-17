/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Web/workbench bridge for the native agent.
 *
 * The workbench owns only chat registration, progress rendering and cancellation forwarding.
 * Planning, providers, tools, filesystem access, terminal processes, MCP, security, recovery and
 * verification run directly by the workbench-native agent runtime.
 */

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { timeout } from '../../../../base/common/async.js';
import * as nls from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ChatAgentLocation, ChatModeKind } from '../common/constants.js';
import { IChatProgress } from '../common/chatService/chatService.js';
import { IChatAgentData, IChatAgentHistoryEntry, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../common/participants/chatAgents.js';
import { ILanguageModelsService } from '../common/languageModels.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IFolzeurAgentService } from '../../../../platform/folzeurAgent/common/folzeurAgent.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { FOLZEUR_LM_VENDOR, FolzeurLanguageModelProvider, parseFolzeurModelIdentifier, toFolzeurModelIdentifier } from './agentRuntime/FolzeurLanguageModelProvider.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { AgentSnapshotContentProvider } from './agentRuntime/ui/AgentSnapshotContentProvider.js';
import { AgentSessionModel } from './agentRuntime/AgentSessionModel.js';
import { AgentChatProgressAdapter } from './agentRuntime/ui/AgentChatProgressAdapter.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { LocalAppServerRegistry } from './agentRuntime/utils/LocalAppServerRegistry.js';

export const NATIVE_AGENT_ID = 'native.api';

export class NativeAIAgents extends Disposable {
	private readonly runningTasks = new Map<string, { readonly cancel: () => void }>();
	private readonly folzeurLanguageModelProvider: FolzeurLanguageModelProvider;
	private readonly snapshotContentProvider: AgentSnapshotContentProvider;
	private readonly localAppServerRegistry: LocalAppServerRegistry;

	constructor(
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IFolzeurAgentService private readonly folzeurAgentService: IFolzeurAgentService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
		this.snapshotContentProvider = this._register(this.instantiationService.createInstance(AgentSnapshotContentProvider));
		this.folzeurLanguageModelProvider = this._register(this.instantiationService.createInstance(FolzeurLanguageModelProvider));
		this.localAppServerRegistry = this._register(this.instantiationService.createInstance(LocalAppServerRegistry));
		this.registerFolzeurLanguageModels();
		this._register(CommandsRegistry.registerCommand({
			id: 'folzeur.agent.setApiKey',
			handler: async () => this.promptForApiKey()
		}));
		this._register(CommandsRegistry.registerCommand({
			id: 'folzeur.agent.clearApiKey',
			handler: async () => this.clearApiKey()
		}));

		this._register(CommandsRegistry.registerCommand({
			id: 'folzeur.agent.openTerminal',
			handler: async (_accessor, terminalInstanceId: number) => {
				const terminal = this.terminalService.getInstanceFromId(terminalInstanceId);
				if (terminal) {
					await this.terminalService.revealTerminal(terminal, false);
				}
			}
		}));

		this.registerAgent();
	}

	private registerFolzeurLanguageModels(): void {
		const vendorDescriptor = {
			vendor: FOLZEUR_LM_VENDOR,
			displayName: 'Folzeur',
			configuration: undefined,
			managementCommand: undefined,
			when: undefined,
		};
		this.languageModelsService.deltaLanguageModelChatProviderDescriptors([vendorDescriptor], []);
		this._register({
			dispose: () => this.languageModelsService.deltaLanguageModelChatProviderDescriptors([], [vendorDescriptor]),
		});
		this._register(this.languageModelsService.registerLanguageModelProvider(FOLZEUR_LM_VENDOR, this.folzeurLanguageModelProvider));
		this.folzeurLanguageModelProvider.notifyChanged();
	}

	private async promptForApiKey(): Promise<void> {
		const provider = this.configurationService.getValue<string>('chat.api.provider');
		if (provider === 'none') {
			return;
		}

		const keyName = `chat.api.${provider}.key`;
		const key = await this.quickInputService.input({
			prompt: `Enter API Key for ${provider} (Saved securely in OS Keychain)`,
			password: true,
			placeHolder: 'sk-...'
		});

		if (key === undefined) {
			return;
		}
		if (key.trim()) {
			await this.secretStorageService.set(keyName, key.trim());
		} else {
			await this.secretStorageService.delete(keyName);
		}
	}

	private async clearApiKey(): Promise<void> {
		const provider = this.configurationService.getValue<string>('chat.api.provider');
		if (!provider || provider === 'none') {
			return;
		}
		await this.secretStorageService.delete(`chat.api.${provider}.key`);
	}

	private async resolveFolzeurModelId(provider: string, rawModel: string | undefined): Promise<string | undefined> {
		if (!rawModel) {
			return undefined;
		}
		if (provider !== 'gemini' && provider !== 'openai' && provider !== 'claude' && provider !== 'ollama') {
			return rawModel;
		}

		const parsed = parseFolzeurModelIdentifier(rawModel);
		// Use the actual provider from the model identifier, not the config provider
		const actualProvider = parsed?.provider ?? provider;
		const apiModelId = parsed?.modelId ?? rawModel;
		const folzeurId = toFolzeurModelIdentifier(actualProvider, apiModelId);

		if (this.languageModelsService.lookupLanguageModel(folzeurId)) {
			return folzeurId;
		}

		const changed = Event.toPromise(Event.filter(this.languageModelsService.onDidChangeLanguageModels, vendor => vendor === FOLZEUR_LM_VENDOR));
		this.folzeurLanguageModelProvider.notifyChanged();
		await Promise.race([changed, timeout(3000)]);
		return folzeurId;
	}

	private registerAgent(): void {
		const agentData: IChatAgentData = {
			extensionId: new ExtensionIdentifier('folzeur.native-agent'),
			publisherDisplayName: 'Folzeur',
			extensionPublisherId: 'folzeur',
			extensionDisplayName: 'Folzeur Agent',
			id: NATIVE_AGENT_ID,
			description: nls.localize('nativeAgent.description', "Integrated coding agent with project tools, terminal, web and MCP capabilities."),
			metadata: {},
			name: 'native',
			fullName: 'Native',
			extensionVersion: '1.0.0',
			slashCommands: [],
			modes: [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent],
			disambiguation: [],
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline, ChatAgentLocation.Terminal, ChatAgentLocation.Notebook],
			isDefault: true,
			isCore: true,
		};

		this._register(this.chatAgentService.registerAgent(NATIVE_AGENT_ID, agentData));
		this._register(this.chatAgentService.registerAgentImplementation(NATIVE_AGENT_ID, {
			invoke: async (request, progress, history, token) => this.invoke(request, part => progress([part]), history, token),
		}));
	}

	private historyContext(history: readonly IChatAgentHistoryEntry[]): string {
		const entries = history.slice(-6).map(entry => {
			let response = '';
			try { response = JSON.stringify(entry.response).slice(0, 4_000); } catch { response = '[unavailable response]'; }
			return `User: ${entry.request.message.slice(0, 4_000)}\nAssistant record: ${response}`;
		});
		return entries.join('\n\n').slice(-16_000);
	}

	private async invoke(request: IChatAgentRequest, progress: (part: IChatProgress) => void, history: readonly IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const provider = this.configurationService.getValue<string>('chat.api.provider');
		if (!provider || provider === 'none') {
			const message = nls.localize('nativeAgent.providerNotConfigured', 'Configure an AI provider and model before starting the agent.');
			progress({ kind: 'markdownContent', content: new MarkdownString(message) });
			return { errorDetails: { message } };
		}

		const sessionId = request.sessionResource.toString().replace(/[^a-zA-Z0-9_-]/g, '_').slice(-120);
		const configuredModelKey = provider === 'ollama' ? 'localAI.model' : `chat.api.${provider}.model`;
		const configuredModel = this.configurationService.getValue<string>(configuredModelKey)?.trim();
		const selectedModel = request.userSelectedModelId?.trim();

		const model = await this.resolveFolzeurModelId(provider, selectedModel || configuredModel);
		if (!model) {
			const message = nls.localize('nativeAgent.modelNotConfigured', 'Configure a model for the selected AI provider before starting the agent.');
			progress({ kind: 'markdownContent', content: new MarkdownString(message) });
			return { errorDetails: { message } };
		}

		if (!this.languageModelsService.lookupLanguageModel(model)) {
			const message = nls.localize('nativeAgent.modelUnavailable', 'The selected model is not currently available: {0}', model);
			progress({ kind: 'markdownContent', content: new MarkdownString(message) });
			return { errorDetails: { message } };
		}
		const parsedModel = parseFolzeurModelIdentifier(model);
		const actualProvider = parsedModel?.provider ?? provider;
		const displayModel = parsedModel?.modelId ?? model;
		const cwd = request.workingDirectory?.fsPath || this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		if (!cwd) {
			const message = nls.localize('nativeAgent.workspaceRequired', 'Open a workspace folder before starting an agent task.');
			return { errorDetails: { message, isExpectedError: true } };
		}
		if (this.folzeurAgentService.isSupported) {
			try {
				await this.folzeurAgentService.start({ workspacePath: cwd });
				await this.folzeurAgentService.request('capabilities');
			} catch { /* The TypeScript runtime remains available as the deterministic fallback. */ }
		}
		this.runningTasks.get(sessionId)?.cancel();
		const taskCancellation = new CancellationTokenSource();
		let task: import('./agentRuntime/NativeTask.js').NativeTask | undefined;
		const sessionModel = new AgentSessionModel(sessionId, displayModel);
		const progressAdapter = new AgentChatProgressAdapter(sessionModel, progress, this.snapshotContentProvider);
		const cancel = () => {
			taskCancellation.cancel();
			task?.stop();
		};
		const requestCancellation = token.onCancellationRequested(cancel);
		this.runningTasks.set(sessionId, { cancel });

		try {
			const { NativeTask } = await import('./agentRuntime/NativeTask.js');
			task = this.instantiationService.createInstance(NativeTask, this.localAppServerRegistry);
			const runResult = await task.run(request.message, actualProvider, model, cwd, progress, taskCancellation.token, sessionModel, this.historyContext(history), sessionId);

			const result: IChatAgentResult = {
				metadata: {
					sessionId,
					runId: runResult.runId,
					phase: runResult.status,
					iterations: runResult.iterations,
					toolCalls: runResult.toolCalls,
					durationMs: runResult.durationMs,
					modifiedFiles: runResult.modifiedFiles,
				},
			};
			if (runResult.status === 'incomplete' || runResult.status === 'cancelled') {
				result.errorDetails = { message: runResult.reason ?? 'The agent task did not complete.', responseIsIncomplete: true, isExpectedError: true };
			}
			return result;
		} catch (error) {
			if (token.isCancellationRequested || taskCancellation.token.isCancellationRequested) {
				return { errorDetails: { message: 'Agent task cancelled.', responseIsIncomplete: true, isExpectedError: true }, metadata: { sessionId, phase: 'cancelled' } };
			}
			const message = error instanceof Error ? error.message : String(error);
			progress({ kind: 'markdownContent', content: new MarkdownString(nls.localize('nativeAgent.runtimeError', "**Agent runtime error:** {0}", message)) });
			return { errorDetails: { message } };
		} finally {
			if (this.runningTasks.get(sessionId)?.cancel === cancel) {
				this.runningTasks.delete(sessionId);
			}
			requestCancellation.dispose();
			taskCancellation.dispose();
			task?.dispose();
			progressAdapter.dispose();
			sessionModel.dispose();
		}
	}

}
