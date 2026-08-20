/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { TerminalSandboxBoundary } from '../terminal/TerminalSandboxBoundary.js';
import { INativeTool } from './INativeTool.js';

type GitOperation = 'branch_create' | 'branch_delete' | 'branch_list' | 'tag_create' | 'switch' | 'restore' | 'add' | 'stash_push' | 'stash_pop' | 'stash_list' | 'commit' | 'fetch' | 'pull' | 'push' | 'show' | 'blame' | 'rev_parse' | 'worktree_list' | 'worktree_add' | 'worktree_remove' | 'merge' | 'merge_abort' | 'rebase' | 'rebase_abort';

export class NativeGitOperationTool implements INativeTool {
	readonly name = 'git_operation';
	readonly description = 'Perform one structured Git operation without accepting free-form shell syntax. Restore and deletion operations always require destructive confirmation.';
	readonly inputSchema = {
		type: 'object', additionalProperties: false,
		properties: {
			operation: { type: 'string', enum: ['branch_create', 'branch_delete', 'branch_list', 'tag_create', 'switch', 'restore', 'add', 'stash_push', 'stash_pop', 'stash_list', 'commit', 'fetch', 'pull', 'push', 'show', 'blame', 'rev_parse', 'worktree_list', 'worktree_add', 'worktree_remove', 'merge', 'merge_abort', 'rebase', 'rebase_abort'] },
			name: { type: 'string', minLength: 1, maxLength: 200 },
			ref: { type: 'string', minLength: 1, maxLength: 200 },
			path: { type: 'string', minLength: 1, maxLength: 32_768 },
			message: { type: 'string', minLength: 1, maxLength: 500 },
			remote: { type: 'string', minLength: 1, maxLength: 200 },
			branch: { type: 'string', minLength: 1, maxLength: 200 },
			timeoutMs: { type: 'integer', minimum: 1_000, maximum: 3_600_000 },
			allowUnsandboxedHost: { type: 'boolean' },
		},
		required: ['operation'],
	};

	constructor(private readonly terminalManager: TerminalManager, private readonly sandboxBoundary: TerminalSandboxBoundary) { }

	async execute(parameters: { operation?: GitOperation; name?: string; ref?: string; path?: string; message?: string; remote?: string; branch?: string; timeoutMs?: number; allowUnsandboxedHost?: boolean }, cwd: string, _progress?: unknown, token: CancellationToken = CancellationToken.None) {
		const command = resolveGitOperation(parameters);
		const prepared = await this.sandboxBoundary.prepare(command, cwd, parameters.allowUnsandboxedHost === true);
		return this.terminalManager.executeCommand(prepared.command, cwd, false, parameters.timeoutMs, token);
	}
}

export function resolveGitOperation(parameters: { operation?: GitOperation; name?: string; ref?: string; path?: string; message?: string; remote?: string; branch?: string }): string {
	const operation = parameters.operation;
	if (!operation) {throw new Error('operation is required');}
	if (operation === 'branch_create') {return `git branch ${gitName(parameters.name)}`;}
	if (operation === 'branch_delete') {return `git branch -d ${gitName(parameters.name)}`;}
	if (operation === 'branch_list') {return 'git branch --list';}
	if (operation === 'tag_create') {return `git tag ${gitName(parameters.name)}`;}
	if (operation === 'switch') {return `git switch ${gitName(parameters.name ?? parameters.branch)}`;}
	if (operation === 'restore') {return `git restore -- ${gitPath(parameters.path)}`;}
	if (operation === 'add') {return `git add -- ${gitPath(parameters.path)}`;}
	if (operation === 'stash_push') {return parameters.message ? `git stash push -m ${gitMessage(parameters.message)}` : 'git stash push';}
	if (operation === 'stash_pop') {return 'git stash pop';}
	if (operation === 'stash_list') {return 'git stash list';}
	if (operation === 'commit') {return `git commit -m ${gitMessage(parameters.message)}`;}
	if (operation === 'fetch') {return `git fetch ${gitName(parameters.remote ?? 'origin')}`;}
	if (operation === 'pull') {return `git pull --ff-only ${gitName(parameters.remote ?? 'origin')} ${gitName(parameters.branch)}`;}
	if (operation === 'push') {return `git push ${gitName(parameters.remote ?? 'origin')} ${gitName(parameters.branch)}`;}
	if (operation === 'show') {return `git show --stat --oneline ${gitName(parameters.ref ?? 'HEAD')}`;}
	if (operation === 'blame') {return `git blame -- ${gitPath(parameters.path)}`;}
	if (operation === 'rev_parse') {return `git rev-parse ${gitName(parameters.ref ?? 'HEAD')}`;}
	if (operation === 'worktree_list') {return 'git worktree list --porcelain';}
	if (operation === 'worktree_add') {return `git worktree add ${gitPath(parameters.path)} ${gitName(parameters.ref ?? parameters.branch)}`;}
	if (operation === 'worktree_remove') {return `git worktree remove ${gitPath(parameters.path)}`;}
	if (operation === 'merge') {return `git merge --no-edit ${gitName(parameters.ref ?? parameters.branch)}`;}
	if (operation === 'merge_abort') {return 'git merge --abort';}
	if (operation === 'rebase') {return `git rebase ${gitName(parameters.ref ?? parameters.branch)}`;}
	return 'git rebase --abort';
}

function gitName(value: string | undefined): string {
	if (!value || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) || value.includes('..') || value.endsWith('.lock')) {throw new Error('Invalid Git name.');}
	return value;
}

function gitPath(value: string | undefined): string {
	if (!value || !/^[A-Za-z0-9._/@:+\\/ -]+$/.test(value) || /[\r\n"']/.test(value) || /^(?:[A-Za-z]:|[\\/])/.test(value) || value.replace(/\\/g, '/').split('/').includes('..')) {throw new Error('Invalid workspace-relative Git path.');}
	return `"${value}"`;
}

function gitMessage(value: string | undefined): string {
	if (!value || !/^[A-Za-z0-9À-ž .,;:_/()\[\]-]{1,500}$/.test(value)) {throw new Error('Git message contains unsupported shell-sensitive characters.');}
	return `"${value}"`;
}
