/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { getMediaOrTextMime } from '../../../base/common/mime.js';
import { ILocalAppServerService } from '../common/localAppServer.js';

interface Registration {
	readonly server: Server;
	readonly url: string;
	readonly rootPath: string;
	readonly entryFile: string;
}

/** Loopback static server owned by the Node shared process, not the renderer. */
export class LocalAppServerService extends Disposable implements ILocalAppServerService {
	private readonly servers = new Map<string, Registration>();

	public async launch(rootPath: string, entryFile: string, token: CancellationToken): Promise<string> {
		if (token.isCancellationRequested) {
			throw new Error('Local application launch was cancelled.');
		}
		const root = await this.canonicalDirectory(rootPath);
		const existing = this.servers.get(root);
		if (existing) {
			return existing.url;
		}
		if (!/^[-a-zA-Z0-9._ ]+\.html$/.test(entryFile) || entryFile.startsWith('.')) {
			throw new Error('Invalid static entry file.');
		}
		const server = createServer((request, response) => void this.handle(root, entryFile, request, response));
		const port = await this.listen(server);
		const registration = { server, url: `http://127.0.0.1:${port}/`, rootPath: root, entryFile };
		this.servers.set(root, registration);
		return registration.url;
	}

	public override dispose(): void {
		for (const registration of this.servers.values()) {
			registration.server.close();
		}
		this.servers.clear();
		super.dispose();
	}

	private async handle(root: string, entryFile: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const method = request.method?.toUpperCase() ?? 'GET';
		if (method !== 'GET' && method !== 'HEAD') {
			response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
			response.end('Method not allowed');
			return;
		}
		try {
			const parsed = new URL(request.url ?? '/', 'http://127.0.0.1');
			const segments = parsed.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
			if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0') || segment.startsWith('.'))) {
				this.respond(response, 403, 'Forbidden');
				return;
			}
			let target = path.resolve(root, ...(segments.length ? segments : [entryFile]));
			if (!this.isInside(root, target) || this.isSensitive(target)) {
				this.respond(response, 403, 'Forbidden');
				return;
			}
			const stat = await fs.stat(target);
			if (stat.isDirectory()) {
				target = path.resolve(target, entryFile);
			}
			const realTarget = await fs.realpath(target);
			if (!this.isInside(root, realTarget) || this.isSensitive(realTarget)) {
				this.respond(response, 403, 'Forbidden');
				return;
			}
			const content = await fs.readFile(realTarget);
			response.writeHead(200, {
				'Content-Type': this.contentType(realTarget),
				'Content-Length': content.byteLength,
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff',
			});
			response.end(method === 'HEAD' ? undefined : content);
		} catch {
			this.respond(response, 404, 'Not found');
		}
	}

	private async canonicalDirectory(rootPath: string): Promise<string> {
		const root = await fs.realpath(path.resolve(rootPath));
		const stat = await fs.stat(root);
		if (!stat.isDirectory()) {
			throw new Error('The local application path must be a project directory.');
		}
		return root;
	}

	private listen(server: Server): Promise<number> {
		return new Promise((resolve, reject) => {
			const onError = (error: Error) => {
				server.off('error', onError);
				reject(error);
			};
			server.once('error', onError);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', onError);
				server.on('error', () => { /* Do not crash the shared process on a late socket error. */ });
				const address = server.address();
				if (!address || typeof address === 'string') {
					server.close();
					reject(new Error('The local HTTP server did not provide a usable loopback port.'));
					return;
				}
				resolve(address.port);
			});
		});
	}

	private isInside(root: string, target: string): boolean {
		const relative = path.relative(root, target);
		return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	}

	private isSensitive(target: string): boolean {
		const name = path.basename(target).toLowerCase();
		return name === '.env' || name.startsWith('.env.') || name === 'credentials' || name.includes('secret') || name.includes('token');
	}

	private respond(response: ServerResponse, status: number, body: string): void {
		response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
		response.end(body);
	}

	private contentType(filePath: string): string {
		const known = getMediaOrTextMime(filePath.toLowerCase());
		if (known) {
			return known.startsWith('text/') ? `${known}; charset=utf-8` : known;
		}
		if (/\.(json|map)$/i.test(filePath)) { return 'application/json; charset=utf-8'; }
		if (/\.wasm$/i.test(filePath)) { return 'application/wasm'; }
		if (/\.woff2$/i.test(filePath)) { return 'font/woff2'; }
		if (/\.ttf$/i.test(filePath)) { return 'font/ttf'; }
		return 'application/octet-stream';
	}
}
