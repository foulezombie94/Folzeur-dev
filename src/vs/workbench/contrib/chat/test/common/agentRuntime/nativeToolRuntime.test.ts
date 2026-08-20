/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { NativeToolRuntime } from '../../../browser/agentRuntime/tools/NativeToolRuntime.js';
import { INativeTool } from '../../../browser/agentRuntime/tools/INativeTool.js';
import { NativeTaskPlanTool } from '../../../browser/agentRuntime/tools/NativeTaskPlanTool.js';
import { assertPublicHttpUrl } from '../../../browser/agentRuntime/utils/AgentNetworkPolicy.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { NativeApplyPatchTransactionTool } from '../../../browser/agentRuntime/tools/NativeApplyPatchTransactionTool.js';
import { assessCommandSandbox, assessVerification, classifyAgentCommand, isAllowlistedCommand } from '../../../browser/agentRuntime/utils/AgentCommandPolicy.js';
import { AgentExecutionState } from '../../../browser/agentRuntime/utils/AgentExecutionState.js';
import { AgentStateCrypto, sha256 } from '../../../browser/agentRuntime/utils/AgentStateCrypto.js';
import { BoundedStreamLineDecoder, FolzeurLanguageModelProvider, toFolzeurModelIdentifier } from '../../../browser/agentRuntime/FolzeurLanguageModelProvider.js';
import { ChatMessageRole } from '../../../common/languageModels.js';
import { TaskJournal } from '../../../browser/agentRuntime/utils/TaskJournal.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { AgentSessionEvent, AgentSessionModel } from '../../../browser/agentRuntime/AgentSessionModel.js';
import { AdaptiveAgentBudget, AgentProgressTracker, AgentRunMetrics, AgentRuntimeStateMachine, classifyProviderError, classifyTaskHeuristically, providerRetryDelay, reclassifyTaskFromEvidence } from '../../../browser/agentRuntime/utils/AgentRuntimeControl.js';
import { isSensitivePath, redactSecrets } from '../../../browser/agentRuntime/utils/SecretProtection.js';
import { hashToolParameters, resolveNativeToolPolicy } from '../../../browser/agentRuntime/tools/NativeToolPolicyRegistry.js';
import { createModelHttpError } from '../../../browser/agentRuntime/model/ModelAdapter.js';
import { TaskSnapshotManager } from '../../../browser/agentRuntime/utils/TaskSnapshotManager.js';
import { WorkspaceCodeIndex } from '../../../browser/agentRuntime/utils/WorkspaceCodeIndex.js';
import { ToolResultStore } from '../../../browser/agentRuntime/utils/ToolResultStore.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';

suite('NativeToolRuntime', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('persists and paginates complete tool results beyond the former truncation limit', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const workspace = URI.from({ scheme: Schemas.inMemory, path: '/workspace' });
		await fileService.createFolder(workspace);
		const store = new ToolResultStore(fileService);
		await store.setRunScope(workspace, 'run-1');
		const source = `${'0123456789'.repeat(100_001)}é-fin`;
		const retained = await store.put(source);
		assert.ok(retained.length > 1_000_000);
		assert.strictEqual(retained.hash.length, 64);
		let offset = 0;
		let restored = '';
		while (offset < retained.length) {
			const page = await store.read(retained.id, offset, 20_000);
			assert.ok(page);
			restored += page.value;
			assert.ok(page.end > offset);
			offset = page.end;
		}
		assert.strictEqual(restored, source);
		await store.clear();
		assert.strictEqual(await store.read(retained.id), undefined);
	});

	test('classifies tasks into execution strategies and scales adaptive budgets', () => {
		assert.strictEqual(classifyTaskHeuristically('bonjour').kind, 'conversation');
		assert.strictEqual(classifyTaskHeuristically('analyse le système de cache').kind, 'code_exploration');
		assert.strictEqual(classifyTaskHeuristically('corrige cette erreur dans auth.ts').kind, 'debug');
		const long = classifyTaskHeuristically('Mets en place toute cette architecture production sur tout le système et plusieurs fichiers.');
		assert.strictEqual(long.kind, 'long_running_task');
		const longBudget = new AdaptiveAgentBudget(long, 0).snapshot;
		const simpleBudget = new AdaptiveAgentBudget(classifyTaskHeuristically('modifie auth.ts'), 0).snapshot;
		assert.ok(longBudget.hardToolCalls > simpleBudget.hardToolCalls);
		assert.ok(longBudget.hardIterations > 30);
		const adaptive = new AdaptiveAgentBudget(classifyTaskHeuristically('modifie auth.ts'), 0);
		const expanded = reclassifyTaskFromEvidence(adaptive.snapshot.classification, { observedTargets: 50, modifiedFiles: 8, planSteps: 12, affectedFiles: 25, iterations: 5, toolCalls: 20, contradictions: 2 });
		assert.strictEqual(expanded.kind, 'refactor');
		assert.strictEqual(adaptive.reclassify(expanded, { iterations: 5, toolCalls: 20 }, 1), true);
		assert.strictEqual(adaptive.snapshot.revision, 1);
		assert.ok(adaptive.snapshot.hardToolCalls > simpleBudget.hardToolCalls);
	});

	test('rejects invalid runtime state transitions', () => {
		const state = new AgentRuntimeStateMachine();
		assert.throws(() => state.transition('completed', 'invalid'), /Invalid agent runtime transition/);
		state.transition('classifying', 'start');
		state.transition('exploring', 'inspect');
		state.transition('planning', 'plan');
		state.transition('executing', 'execute');
		assert.throws(() => state.transition('completed', 'skip verification'), /Invalid agent runtime transition/);
		state.transition('verifying', 'verify');
		state.transition('completed', 'done');
		assert.strictEqual(state.phase, 'completed');
	});

	test('distinguishes activity from progress and detects stagnant trajectories', () => {
		const tracker = new AgentProgressTracker();
		tracker.startIteration(1);
		assert.strictEqual(tracker.recordTool('read_file', { path: 'a.ts' }, 'same', true), 'continue');
		assert.strictEqual(tracker.snapshot.score, 0, 'a successful read is activity, not objective progress');
		tracker.startIteration(2);
		assert.strictEqual(tracker.recordTool('read_file', { path: 'a.ts' }, 'same', true), 'alternative');
		tracker.startIteration(3);
		assert.ok(['alternative', 'replan'].includes(tracker.recordTool('read_file', { path: 'a.ts' }, 'same', true)));
		tracker.startIteration(4);
		tracker.recordTool('write_to_file', { path: 'b.ts' }, 'written', true, { mutationFiles: ['b.ts'], mutationRevision: 1 });
		assert.strictEqual(tracker.snapshot.score, 0, 'an unverified mutation cannot inflate progress');
		tracker.recordTool('run_tests', { command: 'npm test -- --run b.test.ts' }, 'passing', true, { verificationPassed: true, verificationStrength: 'targeted', mutationRevision: 1, verificationRevision: 1 });
		assert.ok(tracker.snapshot.score >= 3);
		const beforeRegression = tracker.snapshot.score;
		tracker.recordTool('run_tests', { command: 'npm test -- --run b.test.ts' }, 'failing', false, { regressionPenalty: 3 });
		assert.ok(tracker.snapshot.score < beforeRegression, 'regressions reduce the progress score');
	});

	test('hashes complete large results and bounds parameter fingerprints', () => {
		const tracker = new AgentProgressTracker();
		const prefix = 'x'.repeat(25_000);
		tracker.startIteration(1);
		assert.strictEqual(tracker.recordTool('read_file', { path: 'large.ts' }, `${prefix}A`, true), 'continue');
		tracker.startIteration(2);
		assert.strictEqual(tracker.recordTool('read_file', { path: 'large.ts' }, `${prefix}B`, true), 'continue');
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		assert.match(hashToolParameters({ patch: 'z'.repeat(1_000_000), cyclic }), /^[0-9a-f]+$/);
	});

	test('classifies provider failures and applies bounded jitter', () => {
		assert.strictEqual(classifyProviderError({ status: 429 }).action, 'retry');
		assert.strictEqual(classifyProviderError({ status: 503 }).action, 'retry');
		assert.strictEqual(classifyProviderError(new Error('provider returned HTTP 503')).action, 'retry');
		assert.strictEqual(classifyProviderError({ status: 401 }).action, 'fail');
		assert.strictEqual(classifyProviderError(new Error('context_length_exceeded')).action, 'compact');
		assert.strictEqual(classifyProviderError({ status: 400, code: 'invalid_request_error', message: 'messages content shape rejected' }, 'anthropic').action, 'rebuild');
		assert.strictEqual(classifyProviderError({ status: 400, code: 'invalid_tool_schema' }, 'openai').action, 'fail');
		assert.strictEqual(classifyProviderError(createModelHttpError('openai', 400, 'invalid message JSON', '')).action, 'rebuild');
		assert.strictEqual(classifyProviderError(createModelHttpError('claude', 429, 'rate limit', '')).action, 'retry');
		assert.strictEqual(providerRetryDelay(0, () => 0), 750);
		assert.strictEqual(providerRetryDelay(10, () => 1), 37_500);
		assert.strictEqual(providerRetryDelay(0, () => 0, 2_500), 2_500);
	});

	test('accepts full shell syntax for enforcement by the OS sandbox', () => {
		const workspace = 'C:\\repo';
		assert.strictEqual(assessCommandSandbox('npm run typecheck', workspace).allowed, true);
		assert.strictEqual(assessCommandSandbox('git -C C:\\repo status', workspace).allowed, true);
		assert.strictEqual(assessCommandSandbox('git status && npm test | tee test.log', workspace).allowed, true);
		assert.strictEqual(assessCommandSandbox('python -c "print(1)"', workspace).allowed, true);
		assert.strictEqual(assessCommandSandbox('npm test\0whoami', workspace).allowed, false);
	});

	test('records cumulative token and event-based RAG metrics', () => {
		const metrics = new AgentRunMetrics('trace');
		metrics.recordModel(10, { inputTokens: 100, outputTokens: 20, cachedTokens: 5, reasoningTokens: 3, peakContextTokens: 100 });
		metrics.recordModel(15, { inputTokens: 120, outputTokens: 30, peakContextTokens: 120 });
		metrics.recordRag(7);
		assert.strictEqual(metrics.snapshot.inputTokensTotal, 220);
		assert.strictEqual(metrics.snapshot.inputTokens, 120);
		assert.strictEqual(metrics.snapshot.outputTokens, 50);
		assert.strictEqual(metrics.snapshot.ragCalls, 1);
	});

	test('retrieves a persisted cold-index file when the native RAG is unavailable', async () => {
		const workspace = URI.file('C:/workspace');
		const source = URI.joinPath(workspace, 'cold.ts');
		const indexResource = URI.joinPath(workspace, '.folzeur', 'workspace-index.json');
		const content = 'export function uniquelyDeferredNeedle() { return 42; }';
		let contentHash = 2166136261;
		for (let index = 0; index < content.length; index++) {
			contentHash ^= content.charCodeAt(index);
			contentHash = Math.imul(contentHash, 16777619);
		}
		const files = new Map<string, VSBuffer>([[source.toString(), VSBuffer.fromString(content)], [indexResource.toString(), VSBuffer.fromString(JSON.stringify({ version: 2, manifest: {}, chunks: [], deferred: { 'cold.ts': { hash: (contentHash >>> 0).toString(16), terms: ['uniquely', 'deferred', 'needle'] } } }))]]);
		const fileService = {
			onDidFilesChange: () => ({ dispose() { } }),
			readFile: async (resource: URI) => { const value = files.get(resource.toString()); if (!value) { throw new Error('not found'); } return { value }; },
			resolve: async (resource: URI) => resource.toString() === workspace.toString()
				? { resource, isDirectory: true, children: [{ resource: source, name: 'cold.ts', isDirectory: false }] }
				: { resource, isDirectory: false, size: files.get(resource.toString())?.byteLength ?? 0 },
			createFolder: async () => undefined,
			writeFile: async (resource: URI, value: VSBuffer) => { files.set(resource.toString(), value); },
			move: async (from: URI, to: URI) => { const value = files.get(from.toString()); if (!value) { throw new Error('not found'); } files.set(to.toString(), value); files.delete(from.toString()); },
		};
		const index = new WorkspaceCodeIndex(fileService as any, workspace);
		try {
			await index.ready();
			const results = await index.searchAll('uniquelyDeferredNeedle', 3);
			assert.strictEqual(results[0]?.filePath, 'cold.ts');
			assert.match(results[0]?.snippet ?? '', /uniquelyDeferredNeedle/);
		} finally {
			index.dispose();
		}
	});

	test('redacts credentials and recognizes secret-bearing paths', () => {
		assert.strictEqual(isSensitivePath('C:/repo/.env.local'), true);
		assert.strictEqual(isSensitivePath('C:/repo/config/secrets.json'), true);
		for (const path of [
			'C:/repo/config/ssl/server.key',
			'C:/repo/nested/.ssh/id_rsa',
			'C:/repo/nested/.ssh/id_ed25519',
			'C:/repo/android/release.jks',
			'C:/repo/android/release.keystore',
			'C:/repo/vpn/client.ovpn',
			'C:/repo/data/users.sqlite',
			'C:/repo/data/users.sqlite3',
			'C:/repo/data/cache.db',
			'C:/repo/backups/latest.sql',
			'C:/repo/backups/latest.dump',
			'C:/repo/.history/private.ts',
			'C:/repo/.vscode/settings.json',
			'C:/repo/.idea/workspace.xml',
			'C:/repo/logs/debug.log',
			'C:/repo/.DS_Store',
			'C:/repo/nested/Thumbs.db',
		]) {
			assert.strictEqual(isSensitivePath(path), true, `${path} must be excluded`);
		}
		assert.strictEqual(isSensitivePath('C:/repo/src/app.ts'), false);
		assert.ok(!redactSecrets('api_key=super-secret-value bearer abcdefghijklmnop').includes('super-secret-value'));
		assert.ok(!redactSecrets('api_key=super-secret-value bearer abcdefghijklmnop').includes('abcdefghijklmnop'));
	});

	test('preserves hashes and structured identifiers during entropy redaction', () => {
		const technicalValues = [
			'0123456789abcdefABCDEF0123456789',
			'0123456789abcdef0123456789abcdef01234567',
			'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
			'550e8400-e29b-41d4-a716-446655440000',
			'01ARZ3NDEKTSV4RRFFQ69G5FAV',
			'sha256-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=',
		];
		assert.deepStrictEqual(technicalValues.map(redactSecrets), technicalValues);
		assert.strictEqual(redactSecrets('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/='), '[REDACTED_HIGH_ENTROPY]');
	});

	test('rejects unknown, oversized and malformed parameters', () => {
		const runtime = new NativeToolRuntime();
		const tool: INativeTool = {
			name: 'delegate', description: '',
			inputSchema: {
				type: 'object', additionalProperties: false, required: ['tasks'],
				properties: { tasks: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 2 } } }
			},
			execute: async () => undefined
		};
		assert.throws(() => runtime.validate(tool, { tasks: [] }), /fewer than 1|at least 1/);
		assert.throws(() => runtime.validate(tool, { tasks: ['a'] }), /fewer than 2|too short/);
		assert.throws(() => runtime.validate(tool, { tasks: ['ok', 'ok', 'extra'] }), /more than 2|at most 2/);
		assert.throws(() => runtime.validate(tool, { tasks: ['ok'], surprise: true }), /additional properties|not allowed/);
	});

	test('validates complete JSON Schema composition and patterns', () => {
		const runtime = new NativeToolRuntime();
		const tool: INativeTool = {
			name: 'complex_schema', description: '',
			inputSchema: {
				type: 'object', additionalProperties: false, required: ['target'],
				properties: {
					target: {
						oneOf: [
							{ type: 'string', pattern: '^[a-z]+(?:/[a-z]+)*$' },
							{ type: 'integer', minimum: 1 },
						]
					}
				}
			},
			execute: async () => undefined
		};
		runtime.validate(tool, { target: 'src/runtime' });
		runtime.validate(tool, { target: 4 });
		assert.throws(() => runtime.validate(tool, { target: '../escape' }), /pattern|oneOf/);
		assert.throws(() => runtime.validate(tool, { target: 0 }), /minimum|oneOf/);
	});

	test('coalesces identical concurrent reads', async () => {
		const runtime = new NativeToolRuntime(2);
		let executions = 0;
		let release!: () => void;
		const blocked = new Promise<void>(resolve => release = resolve);
		const tool: INativeTool = {
			name: 'read_file', description: '', inputSchema: { type: 'object' },
			execute: async () => { executions++; await blocked; return 'value'; }
		};
		const first = runtime.execute(tool, { path: 'same' }, 'cwd');
		const second = runtime.execute(tool, { path: 'same' }, 'cwd');
		release();
		assert.deepStrictEqual(await Promise.all([first, second]), ['value', 'value']);
		assert.strictEqual(executions, 1);
	});

	test('applies backpressure to independent operations', async () => {
		const runtime = new NativeToolRuntime(1);
		let active = 0;
		let peak = 0;
		const tool: INativeTool = {
			name: 'mutation', description: '', inputSchema: { type: 'object' },
			execute: async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise(resolve => setTimeout(resolve, 5));
				active--;
			}
		};
		await Promise.all([runtime.execute(tool, { n: 1 }, 'cwd'), runtime.execute(tool, { n: 2 }, 'cwd')]);
		assert.strictEqual(peak, 1);
	});

	test('enforces deterministic plan state', async () => {
		const plan = new NativeTaskPlanTool();
		assert.strictEqual(plan.hasPlan, false);
		assert.strictEqual(plan.isComplete, false);
		await assert.rejects(() => plan.execute({ steps: [
			{ id: 'inspect', step: 'Inspect', status: 'in_progress', dependsOn: [], acceptanceCriteria: ['inspected'], evidence: [] },
			{ id: 'edit', step: 'Edit', status: 'in_progress', dependsOn: [], acceptanceCriteria: ['edited'], evidence: [] }
		] }), /Only one/);
		await plan.execute({ steps: [{ id: 'inspect', step: 'Inspect', status: 'completed', dependsOn: [], acceptanceCriteria: ['inspected'], evidence: ['read_file output'], criterionEvidence: { criterion_1: ['read_file output'] } }, { id: 'edit', step: 'Edit', status: 'pending', dependsOn: ['inspect'], acceptanceCriteria: ['edited'], evidence: [] }] });
		assert.strictEqual(plan.isComplete, false);
		await plan.execute({ revisionReason: 'Edit completed after its dependency', steps: [{ id: 'inspect', step: 'Inspect', status: 'completed', dependsOn: [], acceptanceCriteria: ['inspected'], evidence: ['read_file output'], criterionEvidence: { criterion_1: ['read_file output'] } }, { id: 'edit', step: 'Edit', status: 'completed', dependsOn: ['inspect'], acceptanceCriteria: ['edited'], evidence: ['apply_diff output'], criterionEvidence: { criterion_1: ['apply_diff output'] } }] });
		assert.strictEqual(plan.isComplete, true);
	});

	test('requires runtime-issued evidence in strict plan mode and records replans', async () => {
		const plan = new NativeTaskPlanTool();
		plan.enableStrictEvidence();
		await plan.execute({ steps: [{ id: 'edit', step: 'Edit', status: 'in_progress', dependsOn: [], acceptanceCriteria: ['file updated'], evidence: [], affectedFiles: ['a.ts'], verification: ['targeted test'] }] });
		await assert.rejects(() => plan.execute({ revisionReason: 'claim completion', steps: [{ id: 'edit', step: 'Edit', status: 'completed', dependsOn: [], acceptanceCriteria: ['file updated'], evidence: ['made it up'], criterionEvidence: { criterion_1: ['made it up'] } }] }), /unknown runtime evidence/);
		const evidence = plan.registerEvidence('call-1', 'apply_diff');
		await plan.execute({ revisionReason: 'Tool confirmed the edit', steps: [{ id: 'edit', step: 'Edit', status: 'completed', dependsOn: [], acceptanceCriteria: ['file updated'], evidence: [evidence], criterionEvidence: { criterion_1: [evidence] } }] });
		assert.strictEqual(plan.isComplete, true);
		assert.strictEqual(plan.revisionHistory.length, 2);
	});

	test('requires typed mutation and verification evidence for file-changing plan steps', async () => {
		const plan = new NativeTaskPlanTool();
		plan.enableStrictEvidence();
		await plan.execute({ steps: [{ id: 'edit', step: 'Edit and verify', status: 'in_progress', dependsOn: [], acceptanceCriteria: ['file updated', 'tests pass'], evidence: [], affectedFiles: ['src/a.ts'], verification: ['targeted tests'] }] });
		const mutation = plan.registerEvidence('edit-1', 'apply_diff');
		const unrelatedMutation = plan.registerEvidence('edit-2', 'apply_diff');
		await assert.rejects(() => plan.execute({ revisionReason: 'Edit landed', steps: [{ id: 'edit', step: 'Edit and verify', status: 'completed', dependsOn: [], acceptanceCriteria: ['file updated', 'tests pass'], evidence: [mutation, unrelatedMutation], criterionEvidence: { criterion_1: [mutation], criterion_2: [unrelatedMutation] }, affectedFiles: ['src/a.ts'], verification: ['targeted tests'] }] }), /requires verification/);
		const verification = plan.registerEvidence('test-1', 'run_tests');
		await plan.execute({ revisionReason: 'Edit and tests passed', steps: [{ id: 'edit', step: 'Edit and verify', status: 'completed', dependsOn: [], acceptanceCriteria: ['file updated', 'tests pass'], evidence: [mutation, verification], criterionEvidence: { criterion_1: [mutation], criterion_2: [verification] }, affectedFiles: ['src/a.ts'], verification: ['targeted tests'] }] });
		assert.strictEqual(plan.completionBlockReason(['C:/workspace/src/a.ts']), undefined);
		assert.match(plan.completionBlockReason(['C:/workspace/src/b.ts']) ?? '', /does not account/);
	});

	test('keeps structured agent state and bounds terminal output', () => {
		const session = new AgentSessionModel('session-1', 'test-model');
		const events: AgentSessionEvent[] = [];
		const listener = session.onDidChange(event => events.push(event));
		try {
			session.start();
			session.beginTool('edit-1', 'write_to_file', { path: 'a.ts' });
			assert.strictEqual(session.snapshot.status, 'editing');
			session.finishTool('edit-1');
			assert.strictEqual(session.snapshot.steps[0].status, 'success');

			session.startTerminal('terminal-1', 'npm test', 'C:/workspace', 42);
			session.appendTerminalOutput('terminal-1', Array.from({ length: 1_100 }, (_, index) => `line ${index}`).join('\n'));
			const running = session.snapshot.terminalRuns[0];
			assert.strictEqual(running.truncated, true);
			assert.ok(running.lineCount <= 1_000);
			assert.ok(running.output.length <= 120_000);
			assert.strictEqual(running.terminalInstanceId, 42);

			session.finishTerminal('terminal-1', 0);
			session.finishTerminal('terminal-1', 0);
			const completions = events.filter(event => event.kind === 'terminalChanged' && event.completed);
			assert.strictEqual(completions.length, 1);
		} finally {
			listener.dispose();
			session.dispose();
		}
	});

	test('rejects dependency cycles and premature plan progress', async () => {
		const plan = new NativeTaskPlanTool();
		await assert.rejects(() => plan.execute({ steps: [
			{ id: 'a', step: 'A', status: 'pending', dependsOn: ['b'], acceptanceCriteria: ['a'], evidence: [] },
			{ id: 'b', step: 'B', status: 'pending', dependsOn: ['a'], acceptanceCriteria: ['b'], evidence: [] },
		] }), /cycle/);
		await assert.rejects(() => plan.execute({ steps: [
			{ id: 'a', step: 'A', status: 'pending', dependsOn: [], acceptanceCriteria: ['a'], evidence: [] },
			{ id: 'b', step: 'B', status: 'in_progress', dependsOn: ['a'], acceptanceCriteria: ['b'], evidence: [] },
		] }), /before dependency/);
	});

	test('defaults unknown shell commands to mutation and hardens allowlists', () => {
		assert.strictEqual(classifyAgentCommand('git status'), 'read_only');
		assert.strictEqual(classifyAgentCommand('npm test'), 'verification');
		assert.strictEqual(classifyAgentCommand('Get-ChildItem'), 'read_only');
		assert.strictEqual(classifyAgentCommand('Invoke-Widget'), 'mutation');
		assert.strictEqual(classifyAgentCommand('Remove-Item -LiteralPath x -Recurse -Force'), 'destructive');
		assert.strictEqual(classifyAgentCommand('echo ok; r"m" -rf workspace'), 'destructive');
		assert.strictEqual(classifyAgentCommand('powershell -EncodedCommand ZABlAGwA'), 'destructive');
		assert.strictEqual(classifyAgentCommand('git reset --hard HEAD'), 'destructive');
		assert.strictEqual(resolveNativeToolPolicy('execute_command', { command: 'git reset --hard HEAD' }).requiresConfirmation, true);
		assert.strictEqual(resolveNativeToolPolicy('execute_command', { command: 'git reset --hard HEAD' }).risk, 'destructive');
		assert.strictEqual(resolveNativeToolPolicy('new_unknown_tool', {}).effect, 'mutation');
		assert.strictEqual(resolveNativeToolPolicy('read_file', { path: 'a.ts' }).parallelSafe, true);
		assert.strictEqual(isAllowlistedCommand('git status', ['git status']), true);
		assert.strictEqual(isAllowlistedCommand('git status; Remove-Item x', ['git status']), false);
		assert.strictEqual(isAllowlistedCommand('npm test && echo fake', ['npm test']), false);
	});

	test('streams UTF-8 across arbitrary chunk boundaries with bounds', () => {
		const decoder = new BoundedStreamLineDecoder(100, 50);
		const bytes = new TextEncoder().encode('data: {"text":"café 😀"}\nnext\n');
		const splitInsideEmoji = bytes.indexOf(0xf0) + 2;
		assert.deepStrictEqual(decoder.push(bytes.slice(0, splitInsideEmoji)), []);
		assert.deepStrictEqual(decoder.push(bytes.slice(splitInsideEmoji)), ['data: {"text":"café 😀"}', 'next']);
		assert.deepStrictEqual(decoder.finish(), []);
		assert.throws(() => new BoundedStreamLineDecoder(3).push(new Uint8Array(4)), /safety limit/);
	});

	test('streams OpenAI text and reconstructs fragmented tool calls', async () => {
		const originalFetch = globalThis.fetch;
		const encoder = new TextEncoder();
		(globalThis as { fetch: typeof fetch }).fetch = async () => new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n'));
				controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_","arguments":"{\\"path\\":"}}]}}]}\n'));
				controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"a.ts\\"}"}}]}}]}\n'));
				controller.enqueue(encoder.encode('data: [DONE]\n'));
				controller.close();
			}
		}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
		const configuration = { getValue: () => undefined, onDidChangeConfiguration: () => ({ dispose() { } }) };
		const provider = new FolzeurLanguageModelProvider(configuration as any);
		try {
			const response = await provider.sendChatRequest(
				toFolzeurModelIdentifier('openai', 'gpt-4o-mini'),
				[{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hello' }] }],
				undefined,
				{ configuration: { apiKey: 'test-key' } } as any,
				CancellationToken.None,
			);
			const chunks: any[] = [];
			for await (const chunk of response.stream) chunks.push(...(Array.isArray(chunk) ? chunk : [chunk]));
			assert.deepStrictEqual(chunks.filter(part => part.type === 'text').map(part => part.value), ['Hel', 'lo']);
			assert.deepStrictEqual(chunks.find(part => part.type === 'tool_use'), { type: 'tool_use', name: 'read_file', toolCallId: 'call-1', parameters: { path: 'a.ts' } });
		} finally {
			provider.dispose();
			globalThis.fetch = originalFetch;
		}
	});

	test('streams Gemini, Claude and Ollama protocol events', async () => {
		const originalFetch = globalThis.fetch;
		const encoder = new TextEncoder();
		const responseOf = (chunks: string[], contentType: string) => new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			}
		}), { status: 200, headers: { 'content-type': contentType } });
		(globalThis as { fetch: typeof fetch }).fetch = async input => {
			const url = String(input);
			if (url.includes('googleapis.com')) return responseOf([
				'data: {"candidates":[{"content":{"parts":[{"text":"Gem"},{"functionCall":{"name":"read_file","args":{"path":"g.ts"}}}]}}]}\n'
			], 'text/event-stream');
			if (url.includes('anthropic.com')) return responseOf([
				'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Cla"}}\n',
				'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"claude-call","name":"read_file","input":{}}}\n',
				'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"c.ts\\"}"}}\n',
				'data: {"type":"content_block_stop","index":1}\n',
			], 'text/event-stream');
			return responseOf([
				'{"message":{"content":"Oll"}}\n',
				'{"message":{"tool_calls":[{"function":{"name":"read_file","arguments":{"path":"o.ts"}}}]}}\n',
			], 'application/x-ndjson');
		};
		const configuration = { getValue: () => undefined, onDidChangeConfiguration: () => ({ dispose() { } }) };
		const provider = new FolzeurLanguageModelProvider(configuration as any);
		const collect = async (providerName: 'gemini' | 'claude' | 'ollama') => {
			const response = await provider.sendChatRequest(
				toFolzeurModelIdentifier(providerName, 'test-model'),
				[{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hello' }] }],
				undefined,
				{ configuration: { apiKey: 'test-key' } } as any,
				CancellationToken.None,
			);
			const chunks: any[] = [];
			for await (const chunk of response.stream) chunks.push(...(Array.isArray(chunk) ? chunk : [chunk]));
			return chunks;
		};
		try {
			const gemini = await collect('gemini');
			assert.strictEqual(gemini.find(part => part.type === 'text')?.value, 'Gem');
			assert.deepStrictEqual(gemini.find(part => part.type === 'tool_use')?.parameters, { path: 'g.ts' });
			const claude = await collect('claude');
			assert.strictEqual(claude.find(part => part.type === 'text')?.value, 'Cla');
			assert.deepStrictEqual(claude.find(part => part.type === 'tool_use')?.parameters, { path: 'c.ts' });
			const ollama = await collect('ollama');
			assert.strictEqual(ollama.find(part => part.type === 'text')?.value, 'Oll');
			assert.deepStrictEqual(ollama.find(part => part.type === 'tool_use')?.parameters, { path: 'o.ts' });
		} finally {
			provider.dispose();
			globalThis.fetch = originalFetch;
		}
	});

	test('preserves Gemini thought signatures across tool-call turns', async () => {
		const originalFetch = globalThis.fetch;
		const requestBodies: Array<Record<string, any>> = [];
		(globalThis as { fetch: typeof fetch }).fetch = async (_input, init) => {
			requestBodies.push(JSON.parse(String(init?.body)) as Record<string, any>);
			const response = requestBodies.length === 1
				? 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"create_directory","args":{"path":"project"}},"thoughtSignature":"signed-thought"}]}}]}\n'
				: 'data: {"candidates":[{"content":{"parts":[{"text":"done"}]}}]}\n';
			return new Response(response, { status: 200, headers: { 'content-type': 'text/event-stream' } });
		};
		const configuration = { getValue: () => undefined, onDidChangeConfiguration: () => ({ dispose() { } }) };
		const provider = new FolzeurLanguageModelProvider(configuration as any);
		try {
			const userMessage = { role: ChatMessageRole.User, content: [{ type: 'text' as const, value: 'create it' }] };
			const firstResponse = await provider.sendChatRequest(
				toFolzeurModelIdentifier('gemini', 'test-model'),
				[userMessage],
				undefined,
				{ configuration: { apiKey: 'test-key' } } as any,
				CancellationToken.None,
			);
			const toolCalls: any[] = [];
			for await (const chunk of firstResponse.stream) toolCalls.push(...(Array.isArray(chunk) ? chunk : [chunk]));
			const toolCall = toolCalls.find(part => part.type === 'tool_use');
			assert.strictEqual(toolCall.thoughtSignature, 'signed-thought');

			const secondResponse = await provider.sendChatRequest(
				toFolzeurModelIdentifier('gemini', 'test-model'),
				[
					userMessage,
					{ role: ChatMessageRole.Assistant, content: [toolCall] },
					{ role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: toolCall.toolCallId, value: [{ type: 'text', value: 'created' }] }] },
				],
				undefined,
				{ configuration: { apiKey: 'test-key' } } as any,
				CancellationToken.None,
			);
			for await (const _chunk of secondResponse.stream) { /* consume request */ }

			assert.deepStrictEqual(requestBodies[1].contents[1].parts[0], {
				functionCall: { name: 'create_directory', args: { path: 'project' } },
				thoughtSignature: 'signed-thought',
			});
		} finally {
			provider.dispose();
			globalThis.fetch = originalFetch;
		}
	});

	test('adapts tool schemas for Gemini without changing other providers', async () => {
		const originalFetch = globalThis.fetch;
		const requests = new Map<string, Record<string, unknown>>();
		(globalThis as { fetch: typeof fetch }).fetch = async (input, init) => {
			const url = String(input);
			requests.set(url, JSON.parse(String(init?.body)) as Record<string, unknown>);
			const payload = url.includes('127.0.0.1') ? '{}\n' : 'data: {}\n';
			return new Response(payload, { status: 200 });
		};
		const configuration = { getValue: () => undefined, onDidChangeConfiguration: () => ({ dispose() { } }) };
		const provider = new FolzeurLanguageModelProvider(configuration as any);
		const inputSchema = {
			type: 'object',
			additionalProperties: false,
			properties: {
				changes: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: { path: { type: 'string' } },
					},
				},
			},
			required: ['changes'],
		};
		const options = {
			configuration: { apiKey: 'test-key' },
			tools: [{ name: 'apply_changes', description: 'Apply changes', inputSchema }],
		} as any;
		const collect = async (providerName: 'gemini' | 'openai' | 'claude' | 'ollama') => {
			const response = await provider.sendChatRequest(
				toFolzeurModelIdentifier(providerName, 'test-model'),
				[{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hello' }] }],
				undefined,
				options,
				CancellationToken.None,
			);
			for await (const _chunk of response.stream) { /* consume request */ }
		};
		try {
			await collect('gemini');
			await collect('openai');
			await collect('claude');
			await collect('ollama');

			const gemini = [...requests.entries()].find(([url]) => url.includes('googleapis.com'))?.[1] as any;
			const openai = [...requests.entries()].find(([url]) => url.includes('openai.com'))?.[1] as any;
			const claude = [...requests.entries()].find(([url]) => url.includes('anthropic.com'))?.[1] as any;
			const ollama = [...requests.entries()].find(([url]) => url.includes('127.0.0.1'))?.[1] as any;
			assert.deepStrictEqual(gemini.tools[0].functionDeclarations[0].parameters, {
				type: 'object',
				properties: { changes: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } } } } },
				required: ['changes'],
			});
			assert.deepStrictEqual(openai.tools[0].function.parameters, inputSchema);
			assert.deepStrictEqual(claude.tools[0].input_schema, inputSchema);
			assert.deepStrictEqual(ollama.tools[0].function.parameters, inputSchema);
			assert.strictEqual(inputSchema.additionalProperties, false);
			assert.strictEqual(inputSchema.properties.changes.items.additionalProperties, false);
		} finally {
			provider.dispose();
			globalThis.fetch = originalFetch;
		}
	});

	test('aborts an active provider stream on cancellation', async () => {
		const originalFetch = globalThis.fetch;
		const encoder = new TextEncoder();
		let aborted = false;
		(globalThis as { fetch: typeof fetch }).fetch = async (_input, init) => new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n'));
				init?.signal?.addEventListener('abort', () => {
					aborted = true;
					controller.error(new Error('aborted'));
				});
			}
		}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
		const configuration = { getValue: () => undefined, onDidChangeConfiguration: () => ({ dispose() { } }) };
		const provider = new FolzeurLanguageModelProvider(configuration as any);
		const cancellation = new CancellationTokenSource();
		try {
			const response = await provider.sendChatRequest(
				toFolzeurModelIdentifier('openai', 'gpt-4o-mini'),
				[{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hello' }] }],
				undefined,
				{ configuration: { apiKey: 'test-key' } } as any,
				cancellation.token,
			);
			const iterator = response.stream[Symbol.asyncIterator]();
			assert.deepStrictEqual(await iterator.next(), { done: false, value: [{ type: 'text', value: 'first' }] });
			cancellation.cancel();
			await assert.rejects(iterator.next(), /cancel|abort/i);
			assert.strictEqual(aborted, true);
		} finally {
			cancellation.dispose();
			provider.dispose();
			globalThis.fetch = originalFetch;
		}
	});

	test('runs mutation failure fix verification lifecycle end to end', async () => {
		const plan = new NativeTaskPlanTool();
		await plan.execute({ steps: [{ id: 'edit', step: 'Edit and verify', status: 'in_progress', dependsOn: [], acceptanceCriteria: ['tests pass'], evidence: [] }] });
		const state = new AgentExecutionState();
		state.recordMutation(['a.ts']);
		const failed = assessVerification('run_tests', 'npm test', 1, '1 failing');
		assert.strictEqual(failed.accepted, false);
		state.recordFailure(failed.reason);
		state.recordMutation(['a.ts']);
		const passed = assessVerification('run_tests', 'npm test', 0, '1 passing');
		assert.strictEqual(passed.accepted, true);
		state.recordVerification('run_tests', 'npm test', '1 passing', 0);
		state.recordFinalDiffReview();
		await plan.execute({ revisionReason: 'Verification passed', steps: [{ id: 'edit', step: 'Edit and verify', status: 'completed', dependsOn: [], acceptanceCriteria: ['tests pass'], evidence: ['npm test: 1 passing'], criterionEvidence: { criterion_1: ['npm test: 1 passing'] } }] });
		assert.deepStrictEqual(state.canComplete({ hasPlan: plan.hasPlan, planComplete: plan.isComplete, acceptanceCriteriaSatisfied: plan.acceptanceCriteriaSatisfied, newDiagnosticErrors: 0 }), { allowed: true });
		state.beginTransaction('still-open');
		assert.match(state.completionBlockReason(plan.hasPlan, plan.isComplete, 0) ?? '', /transactions/);
		state.finishTransaction('still-open');
		assert.strictEqual(state.completionBlockReason(plan.hasPlan, plan.isComplete, 0), undefined);
		state.recordMutation(['a.ts']);
		assert.match(state.completionBlockReason(plan.hasPlan, plan.isComplete, 0) ?? '', /latest mutation revision/);
	});

	test('restores a deterministic crash checkpoint for the same session', async () => {
		const files = new Map<string, VSBuffer>();
		const fileService = {
			createFolder: async () => undefined,
			exists: async (resource: URI) => files.has(resource.toString()),
			writeFile: async (resource: URI, value: VSBuffer) => { files.set(resource.toString(), value); },
			move: async (source: URI, target: URI) => { const value = files.get(source.toString()); if (!value) throw new Error('not found'); files.set(target.toString(), value); files.delete(source.toString()); },
			readFile: async (resource: URI) => {
				const value = files.get(resource.toString());
				if (!value) throw new Error('not found');
				return { value };
			},
		};
		const workspace = URI.file('C:/workspace');
		const stateCrypto = AgentStateCrypto.fromBase64(AgentStateCrypto.generateKey());
		const first = new TaskJournal(fileService as any, workspace, stateCrypto, 'session-1');
		await first.initialize();
		await first.record('tool_started', 'read_file');
		await first.checkpoint('running', { iteration: 3, modifiedFiles: ['a.ts'] });
		const resumed = new TaskJournal(fileService as any, workspace, stateCrypto, 'session-1');
		const checkpoint = await resumed.initialize();
		assert.strictEqual(checkpoint?.status, 'running');
		assert.deepStrictEqual(checkpoint?.state, { iteration: 3, modifiedFiles: ['a.ts'] });
		const journalResource = [...files.keys()].find(resource => resource.endsWith('/session-1.json'))!;
		files.set(journalResource, VSBuffer.fromString(`${files.get(journalResource)!.toString()}tampered`));
		await assert.rejects(new TaskJournal(fileService as any, workspace, stateCrypto, 'session-1').initialize(), /corrupt or unauthenticated/);
	});

	test('restores durable pre-mutation file contents after process recovery', async () => {
		const files = new Map<string, VSBuffer>();
		const directories = new Set<string>();
		const fileService = {
			createFolder: async (resource: URI) => { directories.add(resource.toString()); },
			exists: async (resource: URI) => files.has(resource.toString()) || directories.has(resource.toString()),
			writeFile: async (resource: URI, value: VSBuffer) => { files.set(resource.toString(), value); },
			move: async (source: URI, target: URI) => { const value = files.get(source.toString()); if (!value) throw new Error('not found'); files.set(target.toString(), value); files.delete(source.toString()); },
			readFile: async (resource: URI) => { const value = files.get(resource.toString()); if (!value) throw new Error('not found'); return { value }; },
			resolve: async (resource: URI) => ({ resource, isDirectory: directories.has(resource.toString()), children: [], mtime: Date.now() }),
			del: async (resource: URI) => { files.delete(resource.toString()); directories.delete(resource.toString()); },
		};
		const textFileService = {
			read: async (resource: URI) => ({ value: files.get(resource.toString())?.toString() ?? '' }),
			write: async (resource: URI, value: string) => { files.set(resource.toString(), VSBuffer.fromString(value)); },
		};
		const workspace = URI.file('C:/workspace');
		const source = URI.file('C:/workspace/a.ts');
		files.set(source.toString(), VSBuffer.fromString('before'));
		const stateCrypto = AgentStateCrypto.fromBase64(AgentStateCrypto.generateKey());
		const first = new TaskSnapshotManager(textFileService as any, fileService as any);
		first.setStateCrypto(stateCrypto);
		await first.initialize(workspace, 'run-1', false);
		await first.capture(source.fsPath);
		files.set(source.toString(), VSBuffer.fromString('after'));
		await first.markApplied(source.fsPath);

		const recovered = new TaskSnapshotManager(textFileService as any, fileService as any);
		recovered.setStateCrypto(stateCrypto);
		await recovered.initialize(workspace, 'run-1', true);
		assert.strictEqual(await recovered.restoreAll(), 1);
		assert.strictEqual(files.get(source.toString())?.toString(), 'before');
	});

	test('blocks private and credential-bearing web targets', () => {
		for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://10.0.0.1/', 'http://100.64.0.1/', 'http://192.168.1.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'https://user:secret@example.com/']) {
			assert.throws(() => assertPublicHttpUrl(url));
		}
		assert.strictEqual(assertPublicHttpUrl('https://example.com/path').hostname, 'example.com');
	});

	test('cancels work while waiting for runtime capacity', async () => {
		const runtime = new NativeToolRuntime(1);
		let release!: () => void;
		const blocked = new Promise<void>(resolve => release = resolve);
		const tool: INativeTool = { name: 'mutation', description: '', inputSchema: { type: 'object' }, execute: async () => blocked };
		const first = runtime.execute(tool, {}, 'cwd');
		const cancellation = new CancellationTokenSource();
		const second = runtime.execute(tool, { second: true }, 'cwd', undefined, cancellation.token);
		cancellation.cancel();
		await assert.rejects(second, /cancelled/);
		release();
		await first;
		cancellation.dispose();
	});

	test('cancels a mutation while it waits for a locked resource', async () => {
		const runtime = new NativeToolRuntime(2);
		let release!: () => void;
		const blocked = new Promise<void>(resolve => release = resolve);
		const tool: INativeTool = { name: 'write_to_file', description: '', inputSchema: { type: 'object' }, execute: async () => blocked };
		const first = runtime.execute(tool, { path: 'same.ts' }, 'cwd');
		const cancellation = new CancellationTokenSource();
		const second = runtime.execute(tool, { path: 'same.ts', second: true }, 'cwd', undefined, cancellation.token);
		cancellation.cancel();
		await assert.rejects(second, /resource lock/);
		release();
		await first;
		cancellation.dispose();
	});

	test('recovers a no-mutation interrupted state into the recovering phase', () => {
		const state = new AgentExecutionState();
		state.restoreAfterCrash({ phase: 'exploring', mutationRevision: 0 });
		assert.strictEqual(state.phase, 'recovering');
		state.transition('exploring', 'resume');
		assert.strictEqual(state.phase, 'exploring');
	});

	test('recovers interrupted pre-commit transactions as blocking state', () => {
		const state = new AgentExecutionState();
		state.restoreAfterCrash({ phase: 'running_tool', mutationRevision: 0, openTransactions: ['tx-1'] });
		assert.strictEqual(state.phase, 'debugging');
		assert.match(state.completionBlockReason(false, false, 0) ?? '', /transactions/);
	});

	test('validates an entire multi-file patch before writing', async () => {
		const files = new Map<string, string>([['a.ts', 'const a = 1;'], ['b.ts', 'const b = 1;']]);
		let writes = 0;
		const keyOf = (uri: { fsPath: string }) => uri.fsPath.replace(/\\/g, '/').split('/').pop()!;
		const textFileService = {
			isDirty: () => false,
			read: async (uri: { fsPath: string }) => ({ value: files.get(keyOf(uri))! }),
			write: async (uri: { fsPath: string }, value: string) => { writes++; files.set(keyOf(uri), value); },
		};
		const tool = new NativeApplyPatchTransactionTool(textFileService as any);
		const diff = (from: string, to: string) => `<<<<<<< SEARCH\n${from}\n=======\n${to}\n>>>>>>> REPLACE`;
		const rejected = await tool.execute({ changes: [
			{ filePath: 'a.ts', expectedHash: await sha256(files.get('a.ts')!), diffContent: diff('const a = 1;', 'const a = 2;') },
			{ filePath: 'b.ts', expectedHash: '0'.repeat(64), diffContent: diff('const b = 1;', 'const b = 2;') },
		] });
		assert.strictEqual(rejected.success, false);
		assert.strictEqual(writes, 0);

		const committed = await tool.execute({ changes: [
			{ filePath: 'a.ts', expectedHash: await sha256(files.get('a.ts')!), diffContent: diff('const a = 1;', 'const a = 2;') },
			{ filePath: 'b.ts', expectedHash: await sha256(files.get('b.ts')!), diffContent: diff('const b = 1;', 'const b = 2;') },
		] });
		assert.strictEqual(committed.success, true);
		assert.deepStrictEqual([...files.values()], ['const a = 2;', 'const b = 2;']);
	});

	test('refuses transaction rollback when a committed file gained concurrent user edits', async () => {
		const files = new Map<string, string>([['a.ts', 'const a = 1;'], ['b.ts', 'const b = 1;']]);
		let aWasWritten = false;
		const keyOf = (uri: { fsPath: string }) => uri.fsPath.replace(/\\/g, '/').split('/').pop()!;
		const textFileService = {
			isDirty: () => false,
			read: async (uri: { fsPath: string }) => {
				const key = keyOf(uri);
				if (key === 'b.ts' && aWasWritten) files.set('a.ts', 'const a = 99; // user');
				return { value: files.get(key)! };
			},
			write: async (uri: { fsPath: string }, value: string) => {
				const key = keyOf(uri);
				if (key === 'b.ts') throw new Error('simulated disk failure');
				files.set(key, value);
				aWasWritten = true;
			},
		};
		const tool = new NativeApplyPatchTransactionTool(textFileService as any);
		const diff = (from: string, to: string) => `<<<<<<< SEARCH\n${from}\n=======\n${to}\n>>>>>>> REPLACE`;
		const result = await tool.execute({ changes: [
			{ filePath: 'a.ts', expectedHash: await sha256('const a = 1;'), diffContent: diff('const a = 1;', 'const a = 2;') },
			{ filePath: 'b.ts', expectedHash: await sha256('const b = 1;'), diffContent: diff('const b = 1;', 'const b = 2;') },
		] });
		assert.strictEqual(result.success, false);
		assert.match(result.error ?? '', /safe rollback refused/);
		assert.strictEqual(files.get('a.ts'), 'const a = 99; // user');
	});
});
