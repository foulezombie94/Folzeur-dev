/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { isWindows } from '../../../../../../base/common/platform.js';
import { extUriBiasedIgnorePathCase } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { LocalAppServerRegistry } from '../utils/LocalAppServerRegistry.js';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { TerminalSandboxBoundary } from '../terminal/TerminalSandboxBoundary.js';
import { INativeTool } from './INativeTool.js';

interface PackageManifest {
	readonly scripts?: Readonly<Record<string, unknown>>;
}

type LaunchTarget =
	| { readonly kind: 'command'; readonly command: string }
	| { readonly kind: 'static'; readonly entryFile: string };

/** Selects a local application entrypoint from repository evidence instead of model guesses. */
export class NativeLaunchLocalAppTool implements INativeTool {
	public readonly name = 'launch_local_app';
	public readonly description = 'Inspect the project manifests and lockfiles, select the declared local application entrypoint, and launch it. Static HTML projects are served from the complete project directory on a loopback HTTP URL instead of opening one file with the Windows file association.';
	public readonly inputSchema = {
		type: 'object',
		additionalProperties: false,
		properties: {
			path: { type: 'string', minLength: 1, maxLength: 32_768, description: 'Optional absolute project directory. Defaults to the workspace root.' }
		}
	};

	constructor(
		@IFileService private readonly fileService: IFileService,
		private readonly terminalManager: TerminalManager,
		private readonly sandboxBoundary: TerminalSandboxBoundary,
		private readonly localAppServerRegistry: LocalAppServerRegistry,
	) { }

	public async execute(parameters: { path?: string }, cwd: string, _progress?: unknown, token: CancellationToken = CancellationToken.None): Promise<unknown> {
		if (token.isCancellationRequested) {
			throw new Error('Local application launch was cancelled.');
		}
		const projectPath = parameters.path?.trim() || cwd;
		const root = await this.canonicalizeRoot(URI.file(projectPath));
		const existingUrl = this.localAppServerRegistry.getKnownUrl(root);
		if (existingUrl) {
			return `Reusing the already running local application at ${existingUrl}`;
		}
		const target = await this.resolveLaunchTarget(root);
		if (target.kind === 'static') {
			const url = await this.localAppServerRegistry.launch(root, target.entryFile, token);
			return `Static project is available at ${url}`;
		}
		const prepared = await this.sandboxBoundary.prepare(target.command, projectPath);
		return this.terminalManager.executeCommand(prepared.command, projectPath, true, undefined, token);
	}

	private async resolveLaunchTarget(root: URI): Promise<LaunchTarget> {
		const nativeLauncher = URI.joinPath(root, 'scripts', isWindows ? 'code.bat' : 'code.sh');
		if (await this.fileService.exists(nativeLauncher)) {
			return { kind: 'command', command: isWindows ? '.\\scripts\\code.bat' : './scripts/code.sh' };
		}

		const packageUri = URI.joinPath(root, 'package.json');
		if (await this.fileService.exists(packageUri)) {
			const manifest = this.parsePackageManifest((await this.fileService.readFile(packageUri)).value.toString());
			const script = ['dev', 'start', 'serve', 'preview'].find(candidate => typeof manifest.scripts?.[candidate] === 'string');
			if (script) {
				if (await this.fileService.exists(URI.joinPath(root, 'pnpm-lock.yaml'))) { return { kind: 'command', command: `pnpm run ${script}` }; }
				if (await this.fileService.exists(URI.joinPath(root, 'yarn.lock'))) { return { kind: 'command', command: `yarn ${script}` }; }
				return { kind: 'command', command: `npm run ${script}` };
			}
		}

		if (await this.fileService.exists(URI.joinPath(root, 'Cargo.toml'))) { return { kind: 'command', command: 'cargo run' }; }
		if (await this.fileService.exists(URI.joinPath(root, 'go.mod'))) { return { kind: 'command', command: 'go run .' }; }

		const children = (await this.fileService.resolve(root)).children ?? [];
		if (children.some(child => !child.isDirectory && child.name.endsWith('.csproj'))) { return { kind: 'command', command: 'dotnet run' }; }
		const indexFile = children.find(child => !child.isDirectory && child.name.toLowerCase() === 'index.html');
		if (indexFile) { return { kind: 'static', entryFile: indexFile.name }; }
		throw new Error('No supported application entrypoint was found. Inspect package.json, Cargo.toml, go.mod, pyproject.toml, or the project documentation before running a command.');
	}

	private async canonicalizeRoot(root: URI): Promise<URI> {
		const stat = await this.fileService.stat(root);
		if (!stat.isDirectory) {
			throw new Error('The local application path must be a project directory.');
		}
		const canonicalRoot = await this.fileService.realpath(root).catch(() => undefined) ?? root;
		return extUriBiasedIgnorePathCase.normalizePath(canonicalRoot);
	}

	private parsePackageManifest(content: string): PackageManifest {
		const value: unknown = JSON.parse(content);
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('package.json must contain a JSON object.'); }
		const scripts = (value as { scripts?: unknown }).scripts;
		return { scripts: scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts as Readonly<Record<string, unknown>> : undefined };
	}
}
