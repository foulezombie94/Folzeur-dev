/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../../../base/common/hash.js';
import { AgentCommandRisk, classifyAgentCommand } from '../utils/AgentCommandPolicy.js';

export type NativeToolEffect = 'read' | 'verification' | 'mutation' | 'control' | 'external_read' | 'external_interaction' | 'external_mutation';
export type NativeToolMetric = 'rag' | 'patch' | 'verification' | 'rollback' | 'delegate' | 'none';

export interface NativeToolPolicy {
	readonly effect: NativeToolEffect;
	readonly risk: 'safe' | 'caution' | 'destructive';
	readonly parallelSafe: boolean;
	readonly coalescible: boolean;
	readonly requiresConfirmation: boolean;
	readonly targetKeys: readonly string[];
	readonly metric: NativeToolMetric;
}

const READ = (targetKeys: readonly string[], metric: NativeToolMetric = 'none'): NativeToolPolicy => ({ effect: 'read', risk: 'safe', parallelSafe: true, coalescible: true, requiresConfirmation: false, targetKeys, metric });
const CONTROL = (targetKeys: readonly string[] = []): NativeToolPolicy => ({ effect: 'control', risk: 'safe', parallelSafe: false, coalescible: false, requiresConfirmation: false, targetKeys, metric: 'none' });
const MUTATION = (targetKeys: readonly string[], metric: NativeToolMetric = 'none'): NativeToolPolicy => ({ effect: 'mutation', risk: 'caution', parallelSafe: false, coalescible: false, requiresConfirmation: true, targetKeys, metric });

const POLICIES = new Map<string, NativeToolPolicy>([
	['read_file', READ(['path', 'startLine', 'endLine'])],
	['list_dir', READ(['path'])],
	['list_directory', READ(['path'])],
	['search_files', READ(['path', 'query'])],
	['grep', READ(['path', 'query'])],
	['fuzzy_find_files', READ(['query'])],
	['search_codebase', READ(['query'], 'rag')],
	['codebase_search', READ(['query'], 'rag')],
	['code_graph', READ(['query'])],
	['read_tool_result', READ(['resultId', 'offset'])],
	['git_diff', READ(['path'])],
	['git_status', READ([])],
	['git_log', READ([])],
	['web_search', { effect: 'external_read', risk: 'caution', parallelSafe: true, coalescible: true, requiresConfirmation: false, targetKeys: ['query'], metric: 'none' }],
	['web_fetch', { effect: 'external_read', risk: 'caution', parallelSafe: true, coalescible: true, requiresConfirmation: false, targetKeys: ['url'], metric: 'none' }],
	['apply_diff', MUTATION(['filePath'], 'patch')],
	['apply_patch_transaction', MUTATION(['changes'], 'patch')],
	['write_to_file', MUTATION(['path'])],
	['create_directory', MUTATION(['path'])],
	['delete_file', { ...MUTATION(['path']), risk: 'destructive' }],
	['rollback_task_changes', { ...MUTATION(['scope', 'files'], 'rollback'), risk: 'destructive' }],
	['git_checkout', MUTATION(['mode', 'ref', 'path'])],
	['git_operation', MUTATION(['operation', 'name', 'path', 'remote', 'branch'])],
	['package_manager', MUTATION(['packageManager', 'arguments'])],
	['launch_local_app', { effect: 'control', risk: 'caution', parallelSafe: false, coalescible: false, requiresConfirmation: true, targetKeys: ['path'], metric: 'none' }],
	['run_tests', { effect: 'verification', risk: 'caution', parallelSafe: false, coalescible: false, requiresConfirmation: true, targetKeys: ['command', 'cwd'], metric: 'verification' }],
	['build', { effect: 'verification', risk: 'caution', parallelSafe: false, coalescible: false, requiresConfirmation: true, targetKeys: ['command', 'cwd'], metric: 'verification' }],
	['update_task_plan', CONTROL(['steps'])],
	['attempt_completion', CONTROL()],
	['ask_followup_question', CONTROL(['question'])],
	['delegate_analysis', { effect: 'read', risk: 'safe', parallelSafe: false, coalescible: false, requiresConfirmation: false, targetKeys: ['requests'], metric: 'delegate' }],
]);

const UNKNOWN_POLICY: NativeToolPolicy = {
	effect: 'mutation',
	risk: 'caution',
	parallelSafe: false,
	coalescible: false,
	requiresConfirmation: true,
	targetKeys: [],
	metric: 'none',
};

export function resolveNativeToolPolicy(name: string, parameters: Readonly<Record<string, unknown>> = {}): NativeToolPolicy {
	if (name.startsWith('mcp__')) {return { ...UNKNOWN_POLICY, effect: 'external_mutation' };}
	if (name === 'execute_command' || name === 'run_command' || name === 'run_background') {
		return commandPolicy(classifyAgentCommand(String(parameters.command ?? '')));
	}
	if (name === 'git_operation') {
		const operation = String(parameters.operation ?? '');
		if (['branch_list', 'stash_list', 'show', 'blame', 'rev_parse', 'worktree_list'].includes(operation)) {return READ(['operation', 'name', 'ref', 'path']);}
		if (['restore', 'branch_delete', 'worktree_remove', 'merge_abort', 'rebase', 'rebase_abort'].includes(operation)) {return { ...MUTATION(['operation', 'name', 'ref', 'path']), risk: 'destructive' };}
	}
	if (name === 'browser_action') {
		const action = String(parameters.action ?? '');
		if (action === 'get_storage_value') {return { effect: 'external_read', risk: 'caution', parallelSafe: true, coalescible: false, requiresConfirmation: true, targetKeys: ['sessionId', 'action', 'storageArea', 'storageKey'], metric: 'none' };}
		if (['screenshot', 'get_console_logs', 'get_network_logs', 'get_text', 'get_title', 'inspect_dom', 'accessibility_snapshot', 'get_storage', 'list_storage_keys', 'wait_for', 'assert', 'evaluate'].includes(action)) {return { ...READ(['sessionId', 'action', 'selector', 'assertion', 'expected']), effect: 'external_read' };}
		if (action === 'close') {return { ...CONTROL(['sessionId', 'action']), effect: 'control', risk: 'safe', requiresConfirmation: false };}
		return { ...UNKNOWN_POLICY, effect: action === 'launch' ? 'external_read' : 'external_interaction', targetKeys: ['sessionId', 'action', 'url', 'selector'] };
	}
	if (name === 'manage_terminal') {
		return String(parameters.action ?? '') === 'get_output'
			? READ(['terminalId', 'action'])
			: { effect: 'external_interaction', risk: 'caution', parallelSafe: false, coalescible: false, requiresConfirmation: true, targetKeys: ['terminalId', 'action'], metric: 'none' };
	}
	return POLICIES.get(name) ?? UNKNOWN_POLICY;
}

export function isMutationEffect(effect: NativeToolEffect): boolean {
	return effect === 'mutation' || effect === 'external_mutation';
}

export function extractToolTargets(parameters: Readonly<Record<string, unknown>>, policy: NativeToolPolicy): readonly string[] {
	const values: string[] = [];
	for (const key of policy.targetKeys) {collectTargets(parameters[key], `${key}=`, values, 0);}
	if (!values.length) {
		for (const [key, value] of Object.entries(parameters).slice(0, 32)) {collectTargets(value, `${key}=`, values, 0);}
	}
	return [...new Set(values)].sort().slice(0, 64);
}

/** Bounded canonical hashing avoids allocating a serialized copy of large patches. */
export function hashToolParameters(value: unknown): string {
	const seen = new WeakSet<object>();
	let visited = 0;
	const walk = (candidate: unknown, depth: number): string => {
		if (++visited > 20_000) {return '[entry-budget]';}
		if (depth > 32) {return '[depth-budget]';}
		if (typeof candidate === 'string') {return `s:${candidate.length}:${hexHash(candidate)}`;}
		if (candidate === null || typeof candidate !== 'object') {return `${typeof candidate}:${String(candidate)}`;}
		if (seen.has(candidate)) {return '[cycle]';}
		seen.add(candidate);
		if (Array.isArray(candidate)) {return `a:${candidate.length}:${hexHash(candidate.map(item => walk(item, depth + 1)).join('|'))}`;}
		const record = candidate as Record<string, unknown>;
		const entries = Object.keys(record).sort().slice(0, 2_000).map(key => `${key}:${walk(record[key], depth + 1)}`);
		return `o:${Object.keys(record).length}:${hexHash(entries.join('|'))}`;
	};
	return hexHash(walk(value, 0));
}

function commandPolicy(risk: AgentCommandRisk): NativeToolPolicy {
	if (risk === 'read_only') {return READ(['command', 'cwd']);}
	if (risk === 'verification') {return { effect: 'verification', risk: 'caution', parallelSafe: false, coalescible: false, requiresConfirmation: true, targetKeys: ['command', 'cwd'], metric: 'verification' };}
	return { ...MUTATION(['command', 'cwd']), risk: risk === 'destructive' ? 'destructive' : 'caution' };
}

function collectTargets(value: unknown, prefix: string, result: string[], depth: number): void {
	if (result.length >= 64 || depth > 4 || value === undefined || value === null) {return;}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		const text = String(value);
		result.push(`${prefix}${text.length <= 300 ? text : `${text.slice(0, 120)}#${hexHash(text)}`}`);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value.slice(0, 64)) {collectTargets(item, prefix, result, depth + 1);}
		return;
	}
	if (typeof value === 'object') {
		for (const [key, child] of Object.entries(value).slice(0, 64)) {collectTargets(child, `${prefix}${key}.`, result, depth + 1);}
	}
}

function hexHash(value: string): string { return (hash(value) >>> 0).toString(16); }
