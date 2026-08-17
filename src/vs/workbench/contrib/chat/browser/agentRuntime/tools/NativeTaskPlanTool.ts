/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeTool } from './INativeTool.js';

export interface PlanStep {
	readonly id: string;
	readonly step: string;
	readonly status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';
	readonly dependsOn: readonly string[];
	readonly acceptanceCriteria: readonly string[];
	readonly evidence: readonly string[];
	readonly files?: readonly string[];
	readonly affectedFiles?: readonly string[];
	readonly verification?: readonly string[];
}

export interface PlanRevision {
	readonly revision: number;
	readonly reason: string;
	readonly timestamp: number;
	readonly changedStepIds: readonly string[];
}

export interface PlanEvidenceRecord {
	readonly reference: string;
	readonly tool: string;
	readonly kind: 'read' | 'mutation' | 'verification';
}

const MUTATION_EVIDENCE_TOOLS = new Set(['apply_diff', 'apply_patch_transaction', 'write_to_file', 'create_directory', 'delete_file', 'rollback_task_changes', 'execute_command', 'run_command', 'run_background', 'package_manager', 'git_checkout']);
const VERIFICATION_EVIDENCE_TOOLS = new Set(['run_tests', 'build']);

/** Deterministic task-state machine: a plan may have at most one active step. */
export class NativeTaskPlanTool implements INativeTool {
	public readonly name = 'update_task_plan';
	public readonly description = 'Create or replan a persistent dependency-aware execution plan. Completed steps require runtime-issued evidence references returned by successful tools (for example tool:<toolCallId>), not free-form claims. Supply revisionReason whenever completed work is reopened or the plan changes materially.';
	public readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			revisionReason: { type: 'string', minLength: 1, maxLength: 500 },
			steps: {
				type: 'array', minItems: 1, maxItems: 20,
				items: {
					type: 'object', additionalProperties: false,
					properties: {
						id: { type: 'string', minLength: 1, maxLength: 80 },
						step: { type: 'string', minLength: 1, maxLength: 300 },
						status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'completed', 'failed'] },
						dependsOn: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 80 } },
						acceptanceCriteria: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 300 } },
						evidence: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 1000 } },
						files: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 32_768 } },
						affectedFiles: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 32_768 } },
						verification: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 300 } },
					},
					required: ['id', 'step', 'status', 'dependsOn', 'acceptanceCriteria', 'evidence']
				}
			}
		},
		required: ['steps']
	};
	private steps: PlanStep[] = [];
	private readonly evidenceReferences = new Map<string, PlanEvidenceRecord>();
	private readonly revisions: PlanRevision[] = [];
	private strictEvidence = false;
	private revision = 0;

	public reset(): void { this.steps = []; this.evidenceReferences.clear(); this.revisions.length = 0; this.revision = 0; this.strictEvidence = false; }
	public enableStrictEvidence(): void { this.strictEvidence = true; }
	public registerEvidence(toolCallId: string, tool = 'read', kindOverride?: PlanEvidenceRecord['kind']): string {
		const reference = `tool:${toolCallId}`;
		const kind = kindOverride ?? (VERIFICATION_EVIDENCE_TOOLS.has(tool) ? 'verification' : MUTATION_EVIDENCE_TOOLS.has(tool) ? 'mutation' : 'read');
		this.evidenceReferences.set(reference, { reference, tool, kind });
		return reference;
	}
	public restoreEvidence(references: unknown): void {
		if (!Array.isArray(references)) {return;}
		for (const value of references) {
			const reference = typeof value === 'string' ? value : value && typeof value === 'object' ? String((value as Partial<PlanEvidenceRecord>).reference ?? '') : '';
			if (!/^tool:[a-zA-Z0-9_.:-]{1,200}$/.test(reference)) {continue;}
			const tool = value && typeof value === 'object' && typeof (value as Partial<PlanEvidenceRecord>).tool === 'string' ? (value as Partial<PlanEvidenceRecord>).tool! : 'recovered';
			const declaredKind = value && typeof value === 'object' ? (value as Partial<PlanEvidenceRecord>).kind : undefined;
			const kind = declaredKind === 'mutation' || declaredKind === 'verification' ? declaredKind : 'read';
			this.evidenceReferences.set(reference, { reference, tool, kind });
		}
	}
	public restoreRevisionHistory(value: unknown): void {
		if (!Array.isArray(value)) {return;}
		for (const item of value.slice(-50)) {
			if (!item || typeof item !== 'object') {continue;}
			const candidate = item as Partial<PlanRevision>;
			if (!Number.isInteger(candidate.revision) || typeof candidate.reason !== 'string' || !Number.isFinite(candidate.timestamp) || !Array.isArray(candidate.changedStepIds)) {continue;}
			this.revisions.push({ revision: candidate.revision!, reason: candidate.reason.slice(0, 500), timestamp: candidate.timestamp!, changedStepIds: candidate.changedStepIds.filter((id): id is string => typeof id === 'string').slice(0, 20) });
			this.revision = Math.max(this.revision, candidate.revision!);
		}
	}
	public get hasPlan(): boolean { return this.steps.length > 0; }
	public get isComplete(): boolean { return this.hasPlan && this.steps.every(step => step.status === 'completed'); }
	public get acceptanceCriteriaSatisfied(): boolean { return this.hasPlan && this.steps.every(step => step.status === 'completed' && step.evidence.length === step.acceptanceCriteria.length); }
	public get snapshot(): readonly PlanStep[] { return this.steps; }
	public get revisionHistory(): readonly PlanRevision[] { return this.revisions; }
	public get evidenceSnapshot(): readonly PlanEvidenceRecord[] { return [...this.evidenceReferences.values()]; }
	public get currentStepId(): string | undefined { return this.steps.find(step => step.status === 'in_progress')?.id; }
	public completionBlockReason(modifiedFiles: readonly string[]): string | undefined {
		const mutationSteps = this.steps.filter(step => (step.affectedFiles?.length ?? step.files?.length ?? 0) > 0);
		const missingVerification = mutationSteps.find(step => !step.verification?.length);
		if (missingVerification) {return `plan step ${missingVerification.id} changes files but has no verification requirements`;}
		const affected = mutationSteps.flatMap(step => step.affectedFiles ?? step.files ?? []).map(normalizePlanPath);
		const uncovered = modifiedFiles.find(file => {
			const target = normalizePlanPath(file);
			return !affected.some(candidate => candidate === target || target.endsWith(`/${candidate}`) || candidate.endsWith(`/${target}`));
		});
		return uncovered ? `the plan does not account for modified file ${uncovered}` : undefined;
	}

	public async execute(parameters: { steps?: PlanStep[]; revisionReason?: string }): Promise<string> {
		const steps = parameters.steps ?? [];
		if (steps.filter(step => step.status === 'in_progress').length > 1) {throw new Error('Only one plan step may be in_progress.');}
		const names = new Set<string>();
		const ids = new Set<string>();
		for (const step of steps) {
			const normalized = step.step.trim().toLowerCase();
			if (names.has(normalized)) {throw new Error(`Duplicate plan step: ${step.step}`);}
			names.add(normalized);
			const id = step.id.trim();
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) {throw new Error(`Invalid plan step ID: ${step.id}`);}
			if (ids.has(id)) {throw new Error(`Duplicate plan step ID: ${id}`);}
			ids.add(id);
		}
		for (const step of steps) {
			const dependencies = new Set(step.dependsOn);
			if (dependencies.size !== step.dependsOn.length) {throw new Error(`Duplicate dependency in step ${step.id}.`);}
			if (dependencies.has(step.id)) {throw new Error(`Plan step ${step.id} cannot depend on itself.`);}
			for (const dependency of dependencies) {if (!ids.has(dependency)) {throw new Error(`Unknown dependency ${dependency} in step ${step.id}.`);}}
			if (step.evidence.length > step.acceptanceCriteria.length) {throw new Error(`Step ${step.id} has more evidence entries than acceptance criteria.`);}
			if (step.status === 'completed' && step.evidence.length !== step.acceptanceCriteria.length) {throw new Error(`Completed step ${step.id} requires one evidence entry per acceptance criterion.`);}
			if (this.strictEvidence && step.status === 'completed') {
				const unverified = step.evidence.find(reference => !this.evidenceReferences.has(reference));
				if (unverified) {throw new Error(`Completed step ${step.id} cites unknown runtime evidence ${unverified}. Use a tool:<toolCallId> reference returned by a successful tool.`);}
				const records = step.evidence.map(reference => this.evidenceReferences.get(reference)!);
				if ((step.affectedFiles?.length || step.files?.length) && !records.some(record => record.kind === 'mutation')) {throw new Error(`Completed step ${step.id} affects files but cites no successful mutation evidence.`);}
				if (step.verification?.length && !records.some(record => record.kind === 'verification')) {throw new Error(`Completed step ${step.id} requires verification but cites no successful run_tests or build evidence.`);}
			}
		}
		this.assertAcyclic(steps);
		const statusById = new Map(steps.map(step => [step.id, step.status]));
		for (const step of steps) {
			if (step.status === 'in_progress' || step.status === 'completed') {
				const incomplete = step.dependsOn.find(dependency => statusById.get(dependency) !== 'completed');
				if (incomplete) {throw new Error(`Step ${step.id} cannot be ${step.status} before dependency ${incomplete} is completed.`);}
			}
		}
		const regressed = this.steps.filter(previous => previous.status === 'completed').some(previous => steps.find(step => step.id === previous.id)?.status !== 'completed');
		if (regressed && !parameters.revisionReason?.trim()) {throw new Error('A completed step was removed or reopened; provide revisionReason to record the plan change.');}
		const previous = new Map(this.steps.map(step => [step.id, JSON.stringify(step)]));
		const changedStepIds = steps.filter(step => previous.get(step.id) !== JSON.stringify(step)).map(step => step.id);
		if (this.steps.length && changedStepIds.length && !parameters.revisionReason?.trim()) {throw new Error('A material plan update requires revisionReason so the replan decision remains auditable.');}
		this.steps = steps.map(step => ({
			id: step.id.trim(),
			step: step.step.trim(),
			status: step.status,
			dependsOn: [...step.dependsOn],
			acceptanceCriteria: step.acceptanceCriteria.map(value => value.trim()),
			evidence: step.evidence.map(value => value.trim()),
			files: step.files?.map(value => value.trim()),
			affectedFiles: (step.affectedFiles ?? step.files)?.map(value => value.trim()),
			verification: step.verification?.map(value => value.trim()),
		}));
		if (changedStepIds.length || this.revision === 0) {
			this.revisions.push({ revision: ++this.revision, reason: parameters.revisionReason?.trim() || 'Initial plan', timestamp: Date.now(), changedStepIds });
			if (this.revisions.length > 50) {this.revisions.splice(0, this.revisions.length - 50);}
		}
		return this.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.id}: ${step.step}\n   depends on: ${step.dependsOn.join(', ') || 'none'}\n   acceptance: ${step.acceptanceCriteria.join('; ')}\n   evidence: ${step.evidence.join('; ') || 'pending'}`).join('\n');
	}

	private assertAcyclic(steps: readonly PlanStep[]): void {
		const byId = new Map(steps.map(step => [step.id, step]));
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string): void => {
			if (visiting.has(id)) {throw new Error(`Plan dependency cycle detected at ${id}.`);}
			if (visited.has(id)) {return;}
			visiting.add(id);
			for (const dependency of byId.get(id)?.dependsOn ?? []) {visit(dependency);}
			visiting.delete(id);
			visited.add(id);
		};
		for (const step of steps) {visit(step.id);}
	}
}

function normalizePlanPath(value: string): string {
	return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
}
