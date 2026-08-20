/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../../../base/common/resources.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { isAbsolute } from '../../../../../../base/common/path.js';
import { IgnoreFile } from '../../../../../services/search/common/ignoreFile.js';
import { isSensitivePath } from './SecretProtection.js';

const SECURITY_IGNORE_RULES = [
	'.git/', 'node_modules/', 'dist/', 'build/', 'target/', '.folzeur/',
	'.history/', '**/.history/', '.idea/', '**/.idea/', '.vscode/', '**/.vscode/',
	'.env', '.env.*', '**/.env', '**/.env.*',
	'*.pem', '**/*.pem', '*.der', '**/*.der', '*.key', '**/*.key', '*.p12', '**/*.p12', '*.pfx', '**/*.pfx',
	'*.jks', '**/*.jks', '*.keystore', '**/*.keystore', '*.ovpn', '**/*.ovpn',
	'*.sqlite', '**/*.sqlite', '*.sqlite3', '**/*.sqlite3', '*.db', '**/*.db', '*.sql', '**/*.sql', '*.dump', '**/*.dump',
	'*.log', '**/*.log', '.DS_Store', '**/.DS_Store', 'Thumbs.db', '**/Thumbs.db',
	'credentials.json', '**/credentials.json', 'secrets.json', '**/secrets.json',
	'id_rsa', '**/id_rsa', 'id_dsa', '**/id_dsa', 'id_ecdsa', '**/id_ecdsa', 'id_ed25519', '**/id_ed25519',
	'.npmrc', '**/.npmrc', '.pypirc', '**/.pypirc'
];

export class WorkspaceIgnoreGuard {
	private readonly securityIgnoreMatcher = new IgnoreFile(SECURITY_IGNORE_RULES.join('\n'), '');
	private repositoryIgnoreMatcher = new IgnoreFile('', '');
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
		const repositoryRules: string[] = [];
		for (const name of ['.gitignore', '.agentignore']) {
			try {
				const ignoreFileUri = URI.joinPath(URI.file(this.cwd), name);
				const stat = await this.fileService.resolve(ignoreFileUri);
				if (stat.isFile) {
					const content = (await this.fileService.readFile(ignoreFileUri)).value.toString();
					const userRules = content.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line && (!line.startsWith('#') || line.startsWith('\\#')));
					repositoryRules.push(...userRules);
				}
			} catch {
				// A missing or unreadable optional ignore file does not disable defaults.
			}
		}
		this.repositoryIgnoreMatcher = new IgnoreFile(repositoryRules.join('\n'), '');
	}

	public isIgnored(filePath: string): boolean {
		if (isSensitivePath(filePath)) {return true;}
		const resource = extUriBiasedIgnorePathCase.normalizePath(URI.file(filePath));
		if (!extUriBiasedIgnorePathCase.isEqualOrParent(resource, this.workspace)) {
			return false;
		}
		const relativePath = resource.path.slice(this.workspace.path.length).replace(/^\//, '').replace(/\/$/, '');
		if (!relativePath) {return false;}
		const ignorePath = `/${relativePath}`;
		return this.securityIgnoreMatcher.isArbitraryPathIgnored(ignorePath, false)
			|| this.securityIgnoreMatcher.isArbitraryPathIgnored(ignorePath, true)
			|| this.repositoryIgnoreMatcher.isArbitraryPathIgnored(ignorePath, false)
			|| this.repositoryIgnoreMatcher.isArbitraryPathIgnored(ignorePath, true);
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
