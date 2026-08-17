/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../../../base/common/hash.js';
import { AgentRuntimePhase, AgentRuntimeStateMachine, AgentStateTransition } from './AgentRuntimeControl.js';

export type AgentExecutionPhase = AgentRuntimePhase;

export interface AgentVerificationEvidence {
	readonly tool: 'run_tests' | 'build';
	readonly command: string;
	readonly exitCode: 0;
	readonly outputHash: string;
	readonly completedAt: number;
	readonly mutationRevision: number;
	readonly newDiagnosticErrors: number;
}

export interface AgentExecutionSnapshot {
	readonly phase: AgentExecutionPhase;
	readonly mutationRevision: number;
	readonly modifiedFiles: readonly string[];
	readonly nonRollbackableEffects: readonly string[];
	readonly verification?: AgentVerificationEvidence;
	readonly lastFailure?: string;
	readonly consecutiveFailures: number;
	readonly finalDiffReviewRevision?: number;
	readonly unresolvedCriticalFailures: readonly string[];
	readonly openTransactions: readonly string[];
	readonly transitionHistory: readonly AgentStateTransition[];
}

export interface AgentCompletionGateInput {
	readonly hasPlan: boolean;
	readonly planComplete: boolean;
	readonly acceptanceCriteriaSatisfied: boolean;
	readonly newDiagnosticErrors: number;
}

export type AgentCompletionDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Deterministic execution/verification state kept outside the model transcript. */
export class AgentExecutionState {
	private readonly stateMachine = new AgentRuntimeStateMachine();
	private _mutationRevision = 0;
	private readonly _modifiedFiles = new Set<string>();
	private readonly _nonRollbackableEffects: string[] = [];
	private _verification: AgentVerificationEvidence | undefined;
	private _lastFailure: string | undefined;
	private _consecutiveFailures = 0;
	private _finalDiffReviewRevision: number | undefined;
	private readonly _unresolvedCriticalFailures = new Set<string>();
	private readonly _openTransactions = new Set<string>();

	get phase(): AgentExecutionPhase { return this.stateMachine.phase; }
	get hasMutations(): boolean { return this._mutationRevision > 0; }
	get mutationRevision(): number { return this._mutationRevision; }
	get verification(): AgentVerificationEvidence | undefined { return this._verification; }
	get modifiedFiles(): readonly string[] { return [...this._modifiedFiles]; }
	get debugGuidance(): string {
		if (this._consecutiveFailures < 2) {return '';}
		return `\n\n[Deterministic debug policy: ${this._consecutiveFailures} consecutive failures. Do not repeat the same call. Re-read current state, isolate the smallest cause, choose a different repair, then rerun the objective verification.]`;
	}

	reset(): void {
		this.stateMachine.reset();
		this._mutationRevision = 0;
		this._modifiedFiles.clear();
		this._nonRollbackableEffects.length = 0;
		this._verification = undefined;
		this._lastFailure = undefined;
		this._consecutiveFailures = 0;
		this._finalDiffReviewRevision = undefined;
		this._unresolvedCriticalFailures.clear();
		this._openTransactions.clear();
	}

	restoreAfterCrash(value: unknown): void {
		if (!value || typeof value !== 'object') {return;}
		const snapshot = value as Partial<AgentExecutionSnapshot>;
		const revision = Number(snapshot.mutationRevision);
		if (!Number.isInteger(revision) || revision <= 0) {
			this._openTransactions.clear();
			for (const transactionId of Array.isArray(snapshot.openTransactions) ? snapshot.openTransactions : []) {if (typeof transactionId === 'string' && transactionId) {this._openTransactions.add(transactionId.slice(0, 200));}}
			this._unresolvedCriticalFailures.clear();
			for (const failure of Array.isArray(snapshot.unresolvedCriticalFailures) ? snapshot.unresolvedCriticalFailures : []) {if (typeof failure === 'string' && failure) {this._unresolvedCriticalFailures.add(failure.slice(0, 1000));}}
			if (this._openTransactions.size) {this._unresolvedCriticalFailures.add('Recovered state contains interrupted transactions; rollback or reconcile them before completion.');}
			this.stateMachine.restore(snapshot.phase);
			if (this._openTransactions.size) {this.stateMachine.transition('debugging', 'Recovered an interrupted transaction before its mutation revision was committed.');}
			return;
		}
		this._mutationRevision = revision;
		this._modifiedFiles.clear();
		for (const file of Array.isArray(snapshot.modifiedFiles) ? snapshot.modifiedFiles : []) {if (typeof file === 'string' && file) {this._modifiedFiles.add(file);}}
		this._nonRollbackableEffects.length = 0;
		for (const effect of Array.isArray(snapshot.nonRollbackableEffects) ? snapshot.nonRollbackableEffects : []) {if (typeof effect === 'string') {this._nonRollbackableEffects.push(effect.slice(0, 1000));}}
		// Never trust a pre-crash verification result: files and processes may have changed while the agent was down.
		this._verification = undefined;
		this._lastFailure = 'Recovered an interrupted mutation revision. Reinspect modified files and rerun verification before completion.';
		this._consecutiveFailures = Math.max(1, Number(snapshot.consecutiveFailures) || 0);
		this._finalDiffReviewRevision = undefined;
		this._openTransactions.clear();
		for (const transactionId of Array.isArray(snapshot.openTransactions) ? snapshot.openTransactions : []) {
			if (typeof transactionId === 'string' && transactionId) {this._openTransactions.add(transactionId.slice(0, 200));}
		}
		this._unresolvedCriticalFailures.clear();
		for (const failure of Array.isArray(snapshot.unresolvedCriticalFailures) ? snapshot.unresolvedCriticalFailures : []) {
			if (typeof failure === 'string' && failure) {this._unresolvedCriticalFailures.add(failure.slice(0, 1000));}
		}
		this._unresolvedCriticalFailures.add('Recovered state requires fresh inspection and verification.');
		if (this._openTransactions.size) {this._unresolvedCriticalFailures.add('Recovered state contains interrupted transactions; rollback or reconcile them before completion.');}
		this.stateMachine.restore(snapshot.phase);
		this.stateMachine.transition('debugging', 'Recovered an interrupted mutation revision.');
	}

	transition(phase: AgentExecutionPhase, reason: string): void { this.stateMachine.transition(phase, reason); }

	recordMutation(filePaths: readonly string[] = []): void {
		this._mutationRevision++;
		for (const filePath of filePaths) {if (filePath) {this._modifiedFiles.add(filePath);}}
		this._verification = undefined;
		this._finalDiffReviewRevision = undefined;
		this._unresolvedCriticalFailures.delete('Verification failed.');
		this.transitionToApplying('A controlled filesystem mutation was committed.');
	}

	recordNonRollbackableEffect(effect: string): void {
		this._mutationRevision++;
		this._nonRollbackableEffects.push(effect.slice(0, 1000));
		this._verification = undefined;
		this._finalDiffReviewRevision = undefined;
		this.transitionToApplying('A confirmed command may have produced external mutations.');
	}

	recordVerification(tool: 'run_tests' | 'build', command: string, output: string, newDiagnosticErrors: number): void {
		this._verification = {
			tool,
			command,
			exitCode: 0,
			outputHash: hash(output).toString(16),
			completedAt: Date.now(),
			mutationRevision: this._mutationRevision,
			newDiagnosticErrors,
		};
		this._lastFailure = undefined;
		this._consecutiveFailures = 0;
		this._unresolvedCriticalFailures.delete('Verification failed.');
		this.stateMachine.transition('verifying', 'Objective verification passed for the latest mutation revision.');
	}

	recordFailure(reason: string, critical = false): void {
		this._verification = undefined;
		this._lastFailure = reason.slice(0, 4000);
		this._consecutiveFailures++;
		if (critical) {this._unresolvedCriticalFailures.add(reason.slice(0, 1000));}
		this.stateMachine.transition('debugging', reason);
	}

	recordResolvedFailure(reason: string): void { this._unresolvedCriticalFailures.delete(reason); }
	markFailed(reason: string): void {
		this._lastFailure = reason.slice(0, 4000);
		this._consecutiveFailures++;
		if (this.stateMachine.phase === 'completed' || this.stateMachine.phase === 'failed' || this.stateMachine.phase === 'cancelled') {return;}
		if (this.stateMachine.phase === 'idle') {this.stateMachine.transition('classifying', 'Runtime failed during initialization.');}
		this.stateMachine.transition('failed', reason);
	}

	recordFinalDiffReview(): void {
		this._finalDiffReviewRevision = this._mutationRevision;
		if (this._verification?.mutationRevision === this._mutationRevision) {
			this._unresolvedCriticalFailures.delete('Recovered state requires fresh inspection and verification.');
		}
	}

	beginTransaction(transactionId: string): void { this._openTransactions.add(transactionId); }
	finishTransaction(transactionId: string): void { this._openTransactions.delete(transactionId); }

	canComplete(input: AgentCompletionGateInput): AgentCompletionDecision {
		if (this._openTransactions.size) {return { allowed: false, reason: 'one or more mutation transactions are still open' };}
		if (this._unresolvedCriticalFailures.size) {return { allowed: false, reason: 'there are unresolved critical failures' };}
		if (input.hasPlan && (!input.planComplete || !input.acceptanceCriteriaSatisfied)) {return { allowed: false, reason: 'the execution plan or its acceptance criteria are incomplete' };}
		if (!this.hasMutations) {return { allowed: true };}
		if (!input.hasPlan) {return { allowed: false, reason: 'the execution plan is missing' };}
		if (!this._verification || this._verification.mutationRevision !== this._mutationRevision) {return { allowed: false, reason: 'there is no successful verification for the latest mutation revision' };}
		if (input.newDiagnosticErrors > 0 || this._verification.newDiagnosticErrors > 0) {return { allowed: false, reason: 'the task introduced language-service errors' };}
		if (this._finalDiffReviewRevision !== this._mutationRevision) {return { allowed: false, reason: 'the final diff has not been reviewed after the latest mutation' };}
		return { allowed: true };
	}

	completionBlockReason(hasPlan: boolean, planComplete: boolean, newDiagnosticErrors: number): string | undefined {
		const decision = this.canComplete({ hasPlan, planComplete, acceptanceCriteriaSatisfied: planComplete, newDiagnosticErrors });
		return decision.allowed ? undefined : decision.reason;
	}

	markCompleted(input: AgentCompletionGateInput): void {
		const decision = this.canComplete(input);
		if (!decision.allowed) {throw new Error(`Completion gate rejected: ${decision.reason}.`);}
		if (this.stateMachine.phase !== 'verifying') {this.stateMachine.transition('verifying', 'Runtime is evaluating deterministic completion gates.');}
		this.stateMachine.transition('completed', 'All deterministic completion gates passed.');
	}

	markRolledBack(files?: readonly string[], entireRun = true): void {
		if (entireRun) {this._modifiedFiles.clear();}
		else {for (const file of files ?? []) {this._modifiedFiles.delete(file);}}
		this._verification = undefined;
		if (this._nonRollbackableEffects.length) {
			this._lastFailure = 'File snapshots were restored, but confirmed external command effects cannot be rolled back automatically.';
			this._consecutiveFailures++;
		} else if (entireRun) {
			this._mutationRevision = 0;
			this._lastFailure = undefined;
			this._consecutiveFailures = 0;
		}
		if (!entireRun) {this._mutationRevision++;}
		this._finalDiffReviewRevision = undefined;
		this._openTransactions.clear();
		this._unresolvedCriticalFailures.delete('Recovered state contains interrupted transactions; rollback or reconcile them before completion.');
		this.stateMachine.transition('executing', 'The requested rollback scope was restored safely.');
	}

	private transitionToApplying(reason: string): void {
		if (this.stateMachine.phase === 'idle') {
			this.stateMachine.transition('classifying', 'Execution state initialized by a controlled mutation.');
			this.stateMachine.transition('planning', 'Mutation preconditions were established by the caller.');
		}
		if (this.stateMachine.phase === 'debugging' || this.stateMachine.phase === 'verifying' || this.stateMachine.phase === 'replanning' || this.stateMachine.phase === 'exploring' || this.stateMachine.phase === 'planning') {
			this.stateMachine.transition('executing', 'Returning to controlled execution before mutation.');
		}
		this.stateMachine.transition('applying', reason);
	}

	snapshot(): AgentExecutionSnapshot {
		return {
			phase: this.stateMachine.phase,
			mutationRevision: this._mutationRevision,
			modifiedFiles: [...this._modifiedFiles],
			nonRollbackableEffects: [...this._nonRollbackableEffects],
			verification: this._verification,
			lastFailure: this._lastFailure,
			consecutiveFailures: this._consecutiveFailures,
			finalDiffReviewRevision: this._finalDiffReviewRevision,
			unresolvedCriticalFailures: [...this._unresolvedCriticalFailures],
			openTransactions: [...this._openTransactions],
			transitionHistory: [...this.stateMachine.history],
		};
	}
}
