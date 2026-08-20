/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../../../base/common/hash.js';
import { extractToolTargets, hashToolParameters, NativeToolMetric, resolveNativeToolPolicy } from '../tools/NativeToolPolicyRegistry.js';

export type AgentTaskKind = 'conversation' | 'question' | 'code_exploration' | 'simple_edit' | 'multi_file_edit' | 'debug' | 'refactor' | 'architecture' | 'long_running_task';
export type AgentRuntimePhase = 'idle' | 'classifying' | 'exploring' | 'planning' | 'executing' | 'running_tool' | 'applying' | 'verifying' | 'debugging' | 'replanning' | 'compacting' | 'waiting_user' | 'recovering' | 'completed' | 'failed' | 'cancelled';

export interface AgentTaskClassification {
	readonly kind: AgentTaskKind;
	readonly complexity: 1 | 2 | 3 | 4 | 5;
	readonly estimatedFiles: number;
	readonly needsMcp: boolean;
	readonly requiresMutation: boolean;
	readonly rationale: string;
}

export interface AgentStateTransition { readonly from: AgentRuntimePhase; readonly to: AgentRuntimePhase; readonly reason: string; readonly timestamp: number }

const TRANSITIONS: Readonly<Record<AgentRuntimePhase, readonly AgentRuntimePhase[]>> = {
	idle: ['classifying', 'recovering', 'cancelled'],
	classifying: ['exploring', 'planning', 'executing', 'completed', 'failed', 'cancelled'],
	exploring: ['planning', 'executing', 'running_tool', 'debugging', 'replanning', 'compacting', 'waiting_user', 'verifying', 'failed', 'cancelled'],
	planning: ['exploring', 'executing', 'running_tool', 'replanning', 'compacting', 'waiting_user', 'verifying', 'failed', 'cancelled'],
	executing: ['exploring', 'planning', 'running_tool', 'applying', 'verifying', 'debugging', 'replanning', 'compacting', 'waiting_user', 'failed', 'cancelled'],
	running_tool: ['exploring', 'planning', 'executing', 'applying', 'verifying', 'debugging', 'replanning', 'compacting', 'waiting_user', 'failed', 'cancelled'],
	applying: ['executing', 'running_tool', 'verifying', 'debugging', 'replanning', 'compacting', 'waiting_user', 'failed', 'cancelled'],
	verifying: ['executing', 'running_tool', 'debugging', 'replanning', 'compacting', 'waiting_user', 'completed', 'failed', 'cancelled'],
	debugging: ['exploring', 'planning', 'executing', 'running_tool', 'replanning', 'verifying', 'compacting', 'waiting_user', 'failed', 'cancelled'],
	replanning: ['exploring', 'planning', 'executing', 'running_tool', 'compacting', 'waiting_user', 'verifying', 'failed', 'cancelled'],
	compacting: ['exploring', 'planning', 'executing', 'running_tool', 'debugging', 'replanning', 'failed', 'cancelled'],
	waiting_user: ['exploring', 'planning', 'executing', 'running_tool', 'applying', 'verifying', 'debugging', 'replanning', 'cancelled', 'failed'],
	recovering: ['exploring', 'planning', 'executing', 'debugging', 'failed', 'cancelled'],
	completed: [], failed: [], cancelled: [],
};

/** Runtime-owned state machine. Only the verifying phase may complete an action run. */
export class AgentRuntimeStateMachine {
	private _phase: AgentRuntimePhase = 'idle';
	private readonly transitions: AgentStateTransition[] = [];
	get phase(): AgentRuntimePhase { return this._phase; }
	get history(): readonly AgentStateTransition[] { return this.transitions; }
	reset(): void { this._phase = 'idle'; this.transitions.length = 0; }
	transition(to: AgentRuntimePhase, reason: string): void {
		if (to === this._phase) {return;}
		if (!TRANSITIONS[this._phase].includes(to)) {throw new Error(`Invalid agent runtime transition: ${this._phase} -> ${to}.`);}
		this.transitions.push({ from: this._phase, to, reason: reason.slice(0, 500), timestamp: Date.now() });
		// The durable TaskJournal is the audit source. This in-memory window is diagnostic only.
		if (this.transitions.length > 512) {this.transitions.splice(0, this.transitions.length - 512);}
		this._phase = to;
	}
	restore(phase: unknown): void {
		const source = typeof phase === 'string' && Object.hasOwn(TRANSITIONS, phase) ? phase : 'unknown';
		this.transition('recovering', `Interrupted run recovered from ${source}; terminal states are never reused.`);
	}
}

export interface AgentBudgetSnapshot {
	readonly classification: AgentTaskClassification;
	readonly revision: number;
	readonly softIterations: number; readonly hardIterations: number;
	readonly softToolCalls: number; readonly hardToolCalls: number;
	readonly softDeadlineMs: number; readonly hardDeadlineMs: number;
}
export interface AgentBudgetUsage { readonly iterations: number; readonly toolCalls: number; readonly elapsedMs: number; readonly progressScore: number; readonly iterationsSinceProgress: number; readonly stagnationLevel: number }
export type AgentBudgetDecision = { readonly action: 'continue' } | { readonly action: 'checkpoint' | 'replan' | 'stop'; readonly reason: string };
interface BudgetProfile { readonly iterations: readonly [number, number]; readonly tools: readonly [number, number]; readonly minutes: readonly [number, number] }
const BUDGET_PROFILES: Readonly<Record<AgentTaskKind, BudgetProfile>> = {
	conversation: { iterations: [1, 2], tools: [0, 0], minutes: [1, 3] }, question: { iterations: [4, 10], tools: [8, 24], minutes: [5, 15] },
	code_exploration: { iterations: [12, 40], tools: [40, 160], minutes: [15, 60] }, simple_edit: { iterations: [12, 35], tools: [40, 140], minutes: [20, 60] },
	multi_file_edit: { iterations: [30, 90], tools: [140, 420], minutes: [45, 150] }, debug: { iterations: [35, 110], tools: [160, 500], minutes: [60, 180] },
	refactor: { iterations: [45, 140], tools: [220, 650], minutes: [75, 240] }, architecture: { iterations: [35, 100], tools: [160, 450], minutes: [60, 180] },
	long_running_task: { iterations: [80, 240], tools: [400, 1_000], minutes: [120, 360] },
};
const ABSOLUTE_HARD_ITERATIONS = 300;
const ABSOLUTE_HARD_TOOL_CALLS = 1_200;
const ABSOLUTE_HARD_DURATION_MS = 6 * 60 * 60_000;

/** Reclassifiable adaptive budget. Discoveries can expand soft/hard envelopes up to absolute safety limits. */
export class AdaptiveAgentBudget {
	private value: AgentBudgetSnapshot;
	private windowStartedAt: number;
	private lastCheckpointIteration = 0;
	private lastReplanIteration = -10;
	private continuationWindows = 0;
	constructor(classification: AgentTaskClassification, now = Date.now()) { this.windowStartedAt = now; this.value = this.calculate(classification, 0, now); }
	get snapshot(): AgentBudgetSnapshot { return this.value; }
	reclassify(classification: AgentTaskClassification, usage: Pick<AgentBudgetUsage, 'iterations' | 'toolCalls'>, now = Date.now()): boolean {
		if (sameClassification(this.value.classification, classification)) {return false;}
		this.value = this.calculate(classification, this.value.revision + 1, now, usage);
		return true;
	}
	evaluate(usage: AgentBudgetUsage, now = Date.now()): AgentBudgetDecision {
		if (usage.iterations >= this.value.hardIterations) {return { action: 'stop', reason: `Hard iteration safety limit reached (${this.value.hardIterations}); persist a resumable checkpoint before pausing.` };}
		if (usage.toolCalls >= this.value.hardToolCalls) {return { action: 'stop', reason: `Hard tool-call safety limit reached (${this.value.hardToolCalls}); persist a resumable checkpoint before pausing.` };}
		if (now >= this.value.hardDeadlineMs) {return { action: 'stop', reason: 'Hard task duration safety deadline reached; persist a resumable checkpoint before pausing.' };}
		if ((usage.stagnationLevel >= 4 || usage.iterationsSinceProgress >= 10) && usage.iterations - this.lastReplanIteration >= 3) {
			this.lastReplanIteration = usage.iterations; return { action: 'replan', reason: 'The current trajectory is stagnant and requires a materially different plan.' };
		}
		const soft = usage.iterations >= this.value.softIterations || usage.toolCalls >= this.value.softToolCalls || now >= this.value.softDeadlineMs;
		if (soft && usage.iterations - this.lastCheckpointIteration >= 3) {
			this.lastCheckpointIteration = usage.iterations;
			if (usage.iterationsSinceProgress <= 3 && usage.progressScore > 0) {return { action: 'checkpoint', reason: 'Soft budget reached while objective progress continues; checkpoint and reassess remaining work.' };}
			this.lastReplanIteration = usage.iterations; return { action: 'replan', reason: 'Soft budget reached without recent measurable progress.' };
		}
		return { action: 'continue' };
	}
	continueAfterHardCheckpoint(usage: AgentBudgetUsage, now = Date.now()): boolean {
		if (this.value.classification.kind !== 'long_running_task' || usage.stagnationLevel >= 4 || usage.iterationsSinceProgress > 10 || this.continuationWindows >= 28) {return false;}
		this.continuationWindows++;
		this.windowStartedAt = now;
		this.value = this.calculate(this.value.classification, this.value.revision + 1, now, usage);
		this.lastCheckpointIteration = usage.iterations;
		return true;
	}
	private calculate(classification: AgentTaskClassification, revision: number, now: number, usage?: Pick<AgentBudgetUsage, 'iterations' | 'toolCalls'>): AgentBudgetSnapshot {
		const profile = BUDGET_PROFILES[classification.kind];
		const fileFactor = Math.min(3, Math.log2(Math.max(1, classification.estimatedFiles)) / 3);
		const factor = 1 + (classification.complexity - 1) * 0.14 + fileFactor * 0.28;
		return {
			classification, revision,
			softIterations: Math.max((usage?.iterations ?? 0) + 3, Math.ceil(profile.iterations[0] * factor)),
			hardIterations: (usage?.iterations ?? 0) + Math.min(ABSOLUTE_HARD_ITERATIONS, Math.max(10, Math.ceil(profile.iterations[1] * factor))),
			softToolCalls: Math.max((usage?.toolCalls ?? 0) + 8, Math.ceil(profile.tools[0] * factor)),
			hardToolCalls: (usage?.toolCalls ?? 0) + Math.min(ABSOLUTE_HARD_TOOL_CALLS, Math.max(30, Math.ceil(profile.tools[1] * factor))),
			softDeadlineMs: Math.max(now + 60_000, this.windowStartedAt + Math.ceil(profile.minutes[0] * factor) * 60_000),
			hardDeadlineMs: Math.min(this.windowStartedAt + ABSOLUTE_HARD_DURATION_MS, Math.max(now + 5 * 60_000, this.windowStartedAt + Math.ceil(profile.minutes[1] * factor) * 60_000)),
		};
	}
}

export interface ReclassificationEvidence { readonly observedTargets: number; readonly modifiedFiles: number; readonly planSteps: number; readonly affectedFiles: number; readonly iterations: number; readonly toolCalls: number; readonly contradictions: number }
export function reclassifyTaskFromEvidence(current: AgentTaskClassification, evidence: ReclassificationEvidence): AgentTaskClassification {
	const scope = Math.max(current.estimatedFiles, evidence.modifiedFiles, evidence.affectedFiles, Math.ceil(evidence.observedTargets / 3));
	let kind = current.kind;
	if (current.requiresMutation && scope >= 4 && kind === 'simple_edit') {kind = 'multi_file_edit';}
	if (current.requiresMutation && (scope >= 20 || evidence.planSteps >= 10 || evidence.contradictions >= 2) && !['debug', 'architecture'].includes(kind)) {kind = 'refactor';}
	if (scope >= 60 || evidence.iterations >= 45 || evidence.toolCalls >= 180) {kind = 'long_running_task';}
	const complexity = Math.min(5, Math.max(current.complexity, scope >= 40 ? 5 : scope >= 12 ? 4 : scope >= 4 ? 3 : current.complexity)) as 1 | 2 | 3 | 4 | 5;
	if (kind === current.kind && complexity === current.complexity && scope === current.estimatedFiles) {return current;}
	return { ...current, kind, complexity, estimatedFiles: scope, rationale: `${current.rationale} Reclassified from observed repository scope (${scope} files/targets, ${evidence.planSteps} plan steps, ${evidence.contradictions} contradictions).` };
}

export type StagnationDirective = 'continue' | 'alternative' | 'replan' | 'escalate';
export type VerificationStrength = 'smoke' | 'targeted' | 'package' | 'broad';
interface ToolTrajectory { readonly fingerprint: string; readonly tool: string; readonly scope: string; readonly targetHash: string; readonly resultHash: string; readonly success: boolean; readonly progressDelta: number; readonly timestamp: number }
export interface AgentProgressSnapshot {
	readonly score: number; readonly iteration: number; readonly activityCount: number; readonly iterationsSinceProgress: number; readonly stagnationLevel: number;
	readonly completedSteps: number; readonly resolvedErrors: number; readonly passingVerifications: number; readonly modifiedFiles: number; readonly discoveries: number;
	readonly observedTargets: number; readonly regressions: number; readonly rollbacks: number; readonly recentTrajectory: readonly ToolTrajectory[];
}
export interface AgentProgressObservation {
	readonly mutationFiles?: readonly string[];
	readonly mutationRevision?: number;
	readonly verificationPassed?: boolean;
	readonly verificationStrength?: VerificationStrength;
	readonly verificationRevision?: number;
	readonly planCompletedDelta?: number;
	readonly objectiveEvidence?: readonly string[];
	readonly resolvedFailureIds?: readonly string[];
	readonly regressionPenalty?: number;
	readonly rolledBack?: boolean;
}

/** Activity is never progress by itself. Mutations earn progress only after objective verification. */
export class AgentProgressTracker {
	private readonly recent: ToolTrajectory[] = [];
	private readonly discoveries = new Set<string>();
	private readonly observedTargets = new Set<string>();
	private readonly files = new Set<string>();
	private readonly pendingFiles = new Set<string>();
	private readonly resolvedFailureIds = new Set<string>();
	private readonly scopedStagnation = new Map<string, number>();
	private score = 0; private iteration = 0; private activityCount = 0; private lastProgressIteration = 0;
	private completedSteps = 0; private resolvedErrors = 0; private passingVerifications = 0; private stagnationLevel = 0; private regressions = 0; private rollbacks = 0;
	private restoredModifiedFiles = 0; private restoredDiscoveries = 0; private restoredObservedTargets = 0;
	startIteration(iteration: number): void { this.iteration = iteration; }
	restore(value: unknown): void {
		if (!value || typeof value !== 'object') {return;}
		const snapshot = value as Partial<AgentProgressSnapshot>;
		this.score = finite(snapshot.score); this.activityCount = finite(snapshot.activityCount); this.completedSteps = finite(snapshot.completedSteps);
		this.resolvedErrors = finite(snapshot.resolvedErrors); this.passingVerifications = finite(snapshot.passingVerifications); this.regressions = finite(snapshot.regressions); this.rollbacks = finite(snapshot.rollbacks);
		this.restoredModifiedFiles = finite(snapshot.modifiedFiles); this.restoredDiscoveries = finite(snapshot.discoveries); this.restoredObservedTargets = finite(snapshot.observedTargets);
		this.iteration = 0; this.lastProgressIteration = 0; this.stagnationLevel = 0;
		for (const entry of Array.isArray(snapshot.recentTrajectory) ? snapshot.recentTrajectory.slice(-64) : []) {if (isTrajectory(entry)) {this.recent.push(entry);}}
	}
	recordTool(tool: string, parameters: Readonly<Record<string, unknown>>, result: string, success: boolean, options: AgentProgressObservation = {}): StagnationDirective {
		const policy = resolveNativeToolPolicy(tool, parameters);
		const targets = extractToolTargets(parameters, policy);
		for (const target of targets) {this.observedTargets.add(target);}
		const targetHash = hash(targets.join('|')).toString(16);
		const scope = `${tool}:${targets[0] ?? 'workspace'}`;
		const resultHash = hash(result).toString(16);
		const fingerprint = `${tool}:${hashToolParameters(parameters)}:${targetHash}`;
		this.activityCount++;
		let progressDelta = 0;
		for (const file of options.mutationFiles ?? []) { this.files.add(file); this.pendingFiles.add(file); }
		for (const evidence of options.objectiveEvidence ?? []) {if (evidence && !this.discoveries.has(evidence)) { this.discoveries.add(evidence); progressDelta += 2; }}
		if ((options.planCompletedDelta ?? 0) > 0) { this.completedSteps += options.planCompletedDelta!; progressDelta += options.planCompletedDelta! * 4; }
		if (options.verificationPassed && options.verificationRevision !== undefined && options.verificationRevision === options.mutationRevision) {
			const weights: Record<VerificationStrength, number> = { smoke: 1, targeted: 3, package: 5, broad: 7 };
			this.passingVerifications++;
			progressDelta += weights[options.verificationStrength ?? 'smoke'] + Math.min(3, this.pendingFiles.size);
			this.pendingFiles.clear();
		}
		for (const failureId of options.resolvedFailureIds ?? []) {if (failureId && !this.resolvedFailureIds.has(failureId)) { this.resolvedFailureIds.add(failureId); this.resolvedErrors++; progressDelta += 2; }}
		if (options.rolledBack) { this.rollbacks++; progressDelta -= Math.max(2, this.pendingFiles.size); this.pendingFiles.clear(); }
		if ((options.regressionPenalty ?? 0) > 0) { this.regressions++; progressDelta -= Math.min(10, options.regressionPenalty!); }

		const trajectory: ToolTrajectory = { fingerprint, tool, scope, targetHash, resultHash, success, progressDelta, timestamp: Date.now() };
		this.recent.push(trajectory); if (this.recent.length > 256) {this.recent.splice(0, this.recent.length - 256);}
		if (progressDelta > 0) {
			this.score += progressDelta; this.lastProgressIteration = this.iteration; this.stagnationLevel = Math.max(0, this.stagnationLevel - 2); this.scopedStagnation.set(scope, 0);
		} else {
			this.score += progressDelta;
			const repetitions = this.recent.slice(0, -1).filter(entry => entry.fingerprint === fingerprint && entry.resultHash === resultHash && entry.success === success).length;
			const failures = this.recent.slice(-32).filter(entry => !entry.success && entry.scope === scope).length;
			const cycleSize = detectCycleSize(this.recent);
			if (repetitions || failures >= 2 || cycleSize > 0) {
				const local = (this.scopedStagnation.get(scope) ?? 0) + 1; this.scopedStagnation.set(scope, local);
				// A loop confined to one tool/target raises only that local scope. The
				// run-wide level rises only when a repeated cycle spans several scopes.
				if (cycleSize > 0 && new Set(this.recent.slice(-cycleSize).map(entry => entry.scope)).size > 1) {this.stagnationLevel = Math.min(5, this.stagnationLevel + 1);}
			}
		}
		const localLevel = this.scopedStagnation.get(scope) ?? 0;
		if (localLevel >= 5 || this.stagnationLevel >= 5) {return 'escalate';}
		if (localLevel >= 3 || this.stagnationLevel >= 3) {return 'replan';}
		if (localLevel >= 1 || this.stagnationLevel >= 1) {return 'alternative';}
		return 'continue';
	}
	get snapshot(): AgentProgressSnapshot { return { score: this.score, iteration: this.iteration, activityCount: this.activityCount, iterationsSinceProgress: Math.max(0, this.iteration - this.lastProgressIteration), stagnationLevel: this.stagnationLevel, completedSteps: this.completedSteps, resolvedErrors: this.resolvedErrors, passingVerifications: this.passingVerifications, modifiedFiles: this.restoredModifiedFiles + this.files.size, discoveries: this.restoredDiscoveries + this.discoveries.size, observedTargets: this.restoredObservedTargets + this.observedTargets.size, regressions: this.regressions, rollbacks: this.rollbacks, recentTrajectory: [...this.recent.slice(-24)] }; }
}

export type ProviderErrorAction = 'retry' | 'fail' | 'compact' | 'rebuild';
export interface ProviderErrorDecision { readonly action: ProviderErrorAction; readonly reason: string; readonly retryAfterMs?: number }
/** Structured provider fields take precedence; text matching is only a compatibility fallback. */
export function classifyProviderError(error: unknown, provider = ''): ProviderErrorDecision {
	const record = flattenProviderError(error);
	const recovery = String(record.recovery ?? '').toLowerCase();
	if (recovery === 'retry') {return { action: 'retry', reason: 'The provider adapter classified this failure as transient.', retryAfterMs: parseRetryAfter(record.retryAfter ?? record.retry_after ?? record.retryAfterMs) };}
	if (recovery === 'compact') {return { action: 'compact', reason: 'The provider adapter requested context compaction.' };}
	if (recovery === 'rebuild_request') {return { action: 'rebuild', reason: 'The provider adapter requested a normalized request rebuild.' };}
	if (recovery === 'fail') {return { action: 'fail', reason: 'The provider adapter classified this failure as permanent.' };}
	const status = Number(record.status ?? record.statusCode ?? record.httpStatus);
	const code = String(record.code ?? record.type ?? record.errorCode ?? '').toLowerCase();
	const message = String(record.message ?? '').toLowerCase();
	const retryAfterMs = parseRetryAfter(record.retryAfter ?? record.retry_after ?? record.retryAfterMs);
	const structured = `${provider} ${code}`.toLowerCase();
	if (status === 401 || status === 403 || ['authentication_error', 'permission_error', 'invalid_api_key'].some(value => structured.includes(value))) {return { action: 'fail', reason: 'Permanent authentication or authorization failure.' };}
	if (status === 413 || /context|token.*limit|request_too_large/.test(structured) || /context[_ -]?(length|window)|too many tokens|maximum context/.test(message)) {return { action: 'compact', reason: 'Provider context limit exceeded.' };}
	if (/invalid.*tool|tool.*schema|invalid_schema|malformed_tool/.test(`${structured} ${message}`)) {return { action: 'fail', reason: 'Permanent tool-schema failure.' };}
	if (status === 400) {
		if (/invalid_request|bad_request/.test(structured) && /messages|content|request|context/.test(message)) {return { action: 'rebuild', reason: 'Provider rejected the request shape; rebuild a reduced normalized request once.' };}
		return { action: 'fail', reason: 'Non-recoverable provider validation failure.' };
	}
	if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500 && status <= 599 || /rate_limit|overloaded|timeout|temporar|connection|reset/.test(structured)) {return { action: 'retry', reason: 'Transient provider or network failure.', retryAfterMs };}
	if (/\b(?:429|5\d\d)\b|rate.?limit|temporar|timeout|timed out|econnreset|connection reset|socket hang up|overloaded/.test(message)) {return { action: 'retry', reason: 'Transient provider or network failure detected by compatibility fallback.', retryAfterMs };}
	if (/invalid request|unauthorized|forbidden|invalid api key|authentication/.test(message)) {return { action: 'fail', reason: 'Permanent provider request or authorization failure.' };}
	return { action: 'fail', reason: 'Non-retryable provider failure.' };
}
export function providerRetryDelay(attempt: number, random = Math.random, retryAfterMs?: number): number { if (retryAfterMs !== undefined) {return Math.min(120_000, Math.max(0, retryAfterMs));} const exponential = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt)); return Math.round(exponential * (0.75 + random() * 0.5)); }

export interface AgentModelUsage { readonly inputTokens: number; readonly outputTokens?: number; readonly cachedTokens?: number; readonly reasoningTokens?: number; readonly peakContextTokens?: number }
export interface AgentRunMetricsSnapshot {
	readonly traceId: string; readonly modelRequests: number; readonly modelLatencyMs: number; readonly toolCalls: number; readonly toolLatencyMs: number;
	readonly ragCalls: number; readonly ragLatencyMs: number; readonly ragFailures: number; readonly retries: number; readonly compactions: number; readonly patchFailures: number;
	readonly verificationFailures: number; readonly rollbacks: number; readonly delegates: number; readonly inputTokens: number; readonly inputTokensTotal: number;
	readonly outputTokens: number; readonly cachedTokens: number; readonly reasoningTokens: number; readonly peakContextTokens: number;
}
/** Event-oriented aggregate telemetry. Callers can record RAG, rollback and delegation outside tool dispatch. */
export class AgentRunMetrics {
	private modelRequests = 0; private modelLatencyMs = 0; private toolCalls = 0; private toolLatencyMs = 0; private ragCalls = 0; private ragLatencyMs = 0; private ragFailures = 0;
	private retries = 0; private compactions = 0; private patchFailures = 0; private verificationFailures = 0; private rollbacks = 0; private delegates = 0;
	private inputTokensTotal = 0; private outputTokens = 0; private cachedTokens = 0; private reasoningTokens = 0; private peakContextTokens = 0;
	constructor(readonly traceId: string) { }
	restore(value: unknown): void { if (!value || typeof value !== 'object') {return;} const v = value as Partial<AgentRunMetricsSnapshot>; for (const key of ['modelRequests', 'modelLatencyMs', 'toolCalls', 'toolLatencyMs', 'ragCalls', 'ragLatencyMs', 'ragFailures', 'retries', 'compactions', 'patchFailures', 'verificationFailures', 'rollbacks', 'delegates', 'inputTokensTotal', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'peakContextTokens'] as const) {this[key] = finite(v[key]);} }
	recordModel(latencyMs: number, usage: AgentModelUsage): void { this.modelRequests++; this.modelLatencyMs += Math.max(0, latencyMs); this.inputTokensTotal += Math.max(0, usage.inputTokens); this.outputTokens += Math.max(0, usage.outputTokens ?? 0); this.cachedTokens += Math.max(0, usage.cachedTokens ?? 0); this.reasoningTokens += Math.max(0, usage.reasoningTokens ?? 0); this.peakContextTokens = Math.max(this.peakContextTokens, usage.peakContextTokens ?? usage.inputTokens); }
	recordTool(name: string, latencyMs: number, success: boolean, parameters: Readonly<Record<string, unknown>> = {}): void { this.toolCalls++; this.toolLatencyMs += Math.max(0, latencyMs); this.recordMetric(resolveNativeToolPolicy(name, parameters).metric, latencyMs, success); }
	recordRag(latencyMs: number, success = true): void { this.ragCalls++; this.ragLatencyMs += Math.max(0, latencyMs); if (!success) {this.ragFailures++;} }
	recordRollback(): void { this.rollbacks++; }
	recordDelegate(): void { this.delegates++; }
	recordVerificationFailure(): void { this.verificationFailures++; }
	recordPatchFailure(): void { this.patchFailures++; }
	recordRetry(): void { this.retries++; }
	recordCompaction(): void { this.compactions++; }
	get snapshot(): AgentRunMetricsSnapshot { return { traceId: this.traceId, modelRequests: this.modelRequests, modelLatencyMs: this.modelLatencyMs, toolCalls: this.toolCalls, toolLatencyMs: this.toolLatencyMs, ragCalls: this.ragCalls, ragLatencyMs: this.ragLatencyMs, ragFailures: this.ragFailures, retries: this.retries, compactions: this.compactions, patchFailures: this.patchFailures, verificationFailures: this.verificationFailures, rollbacks: this.rollbacks, delegates: this.delegates, inputTokens: this.peakContextTokens, inputTokensTotal: this.inputTokensTotal, outputTokens: this.outputTokens, cachedTokens: this.cachedTokens, reasoningTokens: this.reasoningTokens, peakContextTokens: this.peakContextTokens }; }
	private recordMetric(metric: NativeToolMetric, latencyMs: number, success: boolean): void { if (metric === 'rag') { this.ragCalls++; this.ragLatencyMs += Math.max(0, latencyMs); if (!success) {this.ragFailures++;} } else if (metric === 'patch' && !success) {this.patchFailures++;} else if (metric === 'verification' && !success) {this.verificationFailures++;} else if (metric === 'rollback') {this.rollbacks++;} else if (metric === 'delegate') {this.delegates++;} }
}

export function classifyTaskHeuristically(prompt: string): AgentTaskClassification {
	const text = prompt.trim().toLowerCase(); const fileMentions = new Set(prompt.match(/[\w./\\-]+\.[a-z0-9]{1,8}/gi) ?? []).size;
	const longSignals = /\b(entire|integral|production|massive|long[- ]running|tout le syst[eè]me|architecture compl[eè]te|migration)\b/i.test(text);
	const architecture = /\b(architecture|design|audit|roadmap|system design)\b/i.test(text); const refactor = /\b(refactor|restructure|migrate|rename across|nettoie|r[eé]organise)\b/i.test(text);
	const debug = /\b(debug|bug|fix|error|fail|crash|diagnos|r[eè]gle|corrige)\b/i.test(text); const mutation = /\b(edit|change|create|delete|implement|add|remove|fix|refactor|migrate|modifi(?:e|er|cation)?|cr[eé]e|supprime|r[eè]gle|corrige|mets? en place)\b/i.test(text);
	const exploration = /\b(search|inspect|analy[sz]e|find|explore|audit|cherche|v[eé]rifie)\b/i.test(text); const conversational = text.length <= 100 && /^(salut|bonjour|bonsoir|hello|hi|hey|merci|thanks|ok|oui|non|[cç]a va)\b/i.test(text);
	let kind: AgentTaskKind;
	if (conversational && !mutation && !exploration) {kind = 'conversation';} else if (longSignals && mutation) {kind = 'long_running_task';} else if (architecture && !mutation) {kind = 'architecture';} else if (refactor) {kind = 'refactor';} else if (debug) {kind = 'debug';} else if (mutation && (fileMentions > 1 || /multi|plusieurs|across|entire|tout/.test(text))) {kind = 'multi_file_edit';} else if (mutation) {kind = 'simple_edit';} else if (exploration || fileMentions) {kind = 'code_exploration';} else {kind = 'question';}
	const complexity = Math.max(1, Math.min(5, 1 + (text.length > 500 ? 1 : 0) + (text.length > 2_000 ? 1 : 0) + (fileMentions > 3 ? 1 : 0) + (longSignals ? 2 : architecture || refactor || debug ? 1 : 0))) as 1 | 2 | 3 | 4 | 5;
	return { kind, complexity, estimatedFiles: Math.max(fileMentions, kind === 'multi_file_edit' ? 4 : kind === 'long_running_task' ? 12 : mutation ? 1 : 0), needsMcp: /\bmcp\b/i.test(text), requiresMutation: mutation, rationale: 'Deterministic local baseline; the runtime reclassifies it from observed repository evidence.' };
}

function sameClassification(a: AgentTaskClassification, b: AgentTaskClassification): boolean { return a.kind === b.kind && a.complexity === b.complexity && a.estimatedFiles === b.estimatedFiles && a.requiresMutation === b.requiresMutation && a.needsMcp === b.needsMcp; }
function finite(value: unknown): number { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : 0; }
function isTrajectory(value: unknown): value is ToolTrajectory { if (!value || typeof value !== 'object') {return false;} const item = value as Partial<ToolTrajectory>; return typeof item.fingerprint === 'string' && typeof item.tool === 'string' && typeof item.scope === 'string' && typeof item.targetHash === 'string' && typeof item.resultHash === 'string' && typeof item.success === 'boolean' && typeof item.progressDelta === 'number' && typeof item.timestamp === 'number'; }
function detectCycleSize(recent: readonly ToolTrajectory[]): number { const values = recent.map(item => `${item.fingerprint}:${item.resultHash}:${item.success}`); for (let size = 2; size <= 12; size++) { if (values.length < size * 2) {continue;} const last = values.slice(-size).join('|'); const previous = values.slice(-size * 2, -size).join('|'); if (last === previous) {return size;} } return 0; }
function flattenProviderError(error: unknown): Record<string, unknown> { if (!error || typeof error !== 'object') {return { message: String(error ?? '') };} const outer = error as Record<string, unknown>; const inner = outer.error && typeof outer.error === 'object' ? outer.error as Record<string, unknown> : {}; const cause = outer.cause && typeof outer.cause === 'object' ? outer.cause as Record<string, unknown> : {}; return { ...cause, ...inner, ...outer, message: outer.message ?? inner.message ?? cause.message ?? '' }; }
function parseRetryAfter(value: unknown): number | undefined { const numeric = Number(value); if (!Number.isFinite(numeric) || numeric < 0) {return undefined;} return numeric > 1_000 ? numeric : numeric * 1_000; }
