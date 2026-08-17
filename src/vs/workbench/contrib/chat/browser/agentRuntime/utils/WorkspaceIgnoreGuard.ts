/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../../../base/common/resources.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { isAbsolute } from '../../../../../../base/common/path.js';
import { isSensitivePath } from './SecretProtection.js';

export class WorkspaceIgnoreGuard {
	private rules: string[] = [
		'.git/', 'node_modules/', 'dist/', 'build/', 'target/', '.folzeur/',
		'.env', '.env.*', '**/.env', '**/.env.*', '*.pem', '*.key', '*.p12', '*.pfx',
		'credentials.json', '**/credentials.json', 'secrets.json', '**/secrets.json',
		'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.pypirc'
	];
	private readonly workspace: URI;
	private readonly explicitGrants: URI[] = [];
	private readonly loading: Promise<void>;

	constructor(
		private readonly fileService: IFileService,
		private readonly cwd: string
	) {
		this.workspace = extUriBiasedIgnorePathCase.normalizePath(URI.file(cwd));
		this.loading = this.loadIgnoreRules();
	}

	public ready(): Promise<void> {
		return this.loading;
	}

	private async loadIgnoreRules() {
		for (const name of ['.gitignore', '.agentignore']) {
			try {
				const ignoreFileUri = URI.joinPath(URI.file(this.cwd), name);
				const stat = await this.fileService.resolve(ignoreFileUri);
				if (stat.isFile) {
					const content = (await this.fileService.readFile(ignoreFileUri)).value.toString();
					const userRules = content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('!'));
					this.rules.push(...userRules);
				}
			} catch {
				// A missing or unreadable optional ignore file does not disable defaults.
			}
		}
	}

	public isIgnored(filePath: string): boolean {
		if (isSensitivePath(filePath)) {return true;}
		const resource = extUriBiasedIgnorePathCase.normalizePath(URI.file(filePath));
		if (!extUriBiasedIgnorePathCase.isEqualOrParent(resource, this.workspace)) {
			return false;
		}
		const relativePath = resource.path.slice(this.workspace.path.length).replace(/^\//, '');
		return this.rules.some(rule => globMatches(relativePath, rule));
	}

	public async isInsideWorkspace(filePath: string): Promise<boolean> {
		const canonical = await this.canonicalize(URI.file(filePath));
		const root = await this.canonicalize(this.workspace);
		return extUriBiasedIgnorePathCase.isEqualOrParent(canonical, root);
	}

	/** Grants one explicitly confirmed external path. Descendants are covered for directory grants. */
	public async grantExternalPath(filePath: string): Promise<void> {
		const canonical = await this.canonicalize(URI.file(filePath));
		if (!this.explicitGrants.some(grant => extUriBiasedIgnorePathCase.isEqual(grant, canonical))) {
			this.explicitGrants.push(canonical);
		}
	}

	public async assertAllowed(filePath: string): Promise<URI> {
		await this.loading;
		if (!filePath || !isAbsolute(filePath)) {
			throw new Error('A valid absolute path is required.');
		}
		const resource = extUriBiasedIgnorePathCase.normalizePath(URI.file(filePath));
		const canonical = await this.canonicalize(resource);
		const root = await this.canonicalize(this.workspace);
		const covered = extUriBiasedIgnorePathCase.isEqualOrParent(canonical, root)
			|| this.explicitGrants.some(grant => extUriBiasedIgnorePathCase.isEqualOrParent(canonical, grant));
		if (!covered) {
			throw new Error(`Security violation: Path ${filePath} is outside the workspace and was not explicitly granted.`);
		}
		if (this.isIgnored(canonical.fsPath)) {
			throw new Error(`Security violation: Path ${filePath} is excluded by workspace rules.`);
		}
		return canonical;
	}

	private async canonicalize(resource: URI): Promise<URI> {
		const normalized = extUriBiasedIgnorePathCase.normalizePath(resource);
		const real = await this.fileService.realpath(normalized).catch(() => undefined);
		if (real) {
			return extUriBiasedIgnorePathCase.normalizePath(real);
		}
		const missing: string[] = [];
		let current = normalized;
		while (true) {
			const parent = extUriBiasedIgnorePathCase.dirname(current);
			if (extUriBiasedIgnorePathCase.isEqual(parent, current)) {
				return normalized;
			}
			missing.unshift(extUriBiasedIgnorePathCase.basename(current));
			const realParent = await this.fileService.realpath(parent).catch(() => undefined);
			if (realParent) {
				return extUriBiasedIgnorePathCase.joinPath(realParent, ...missing);
			}
			current = parent;
		}
	}
}

function globMatches(relativePath: string, rule: string): boolean {
	const directoryRule = /[\\/]$/.test(rule);
	const normalizedRule = rule.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '');
	if (!normalizedRule) {return false;}
	let expression = '';
	for (let index = 0; index < normalizedRule.length; index++) {
		const character = normalizedRule[index];
		if (character === '*' && normalizedRule[index + 1] === '*') {
			expression += '.*';
			index++;
		} else if (character === '*') {
			expression += '[^/]*';
		} else if (character === '?') {
			expression += '[^/]';
		} else {
			expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
		}
	}
	const anywherePrefix = normalizedRule.includes('/') ? '' : '(?:.*/)?';
	return new RegExp(`^${anywherePrefix}${expression}${directoryRule ? '(?:/.*)?' : ''}$`, 'i').test(relativePath);
}
