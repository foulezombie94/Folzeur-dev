/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { INativeTool } from './INativeTool.js';
import { SymbolRelationKind, WorkspaceOutlineIndex } from '../utils/WorkspaceOutlineIndex.js';
import { SemanticCodeGraphService } from '../utils/SemanticCodeGraphService.js';

interface CodeGraphParameters {
	action?: 'repo_map' | 'definitions' | 'references' | 'callers' | 'callees' | 'dependencies';
	query?: string;
	limit?: number;
}

export class NativeCodeGraphTool implements INativeTool {
	public readonly name = 'code_graph';
	public readonly description = 'Inspect the repository symbol map and structural relationships: definitions, references, callers, callees, imports, inheritance and implementations.';
	public readonly inputSchema = {
		type: 'object',
		properties: {
			action: { type: 'string', enum: ['repo_map', 'definitions', 'references', 'callers', 'callees', 'dependencies'] },
			query: { type: 'string', description: 'Symbol or module name. Optional only for repo_map.' },
			limit: { type: 'number', minimum: 1, maximum: 500 }
		},
		required: ['action']
	};

	constructor(private readonly outline: WorkspaceOutlineIndex, private readonly semantic?: SemanticCodeGraphService) { }

	public async execute(parameters: CodeGraphParameters, _cwd: string, _progress?: never, token: CancellationToken = CancellationToken.None): Promise<string> {
		await this.outline.ready();
		const limit = Math.max(1, Math.min(500, Math.floor(parameters.limit ?? 80)));
		if (parameters.action === 'repo_map') {
			return this.outline.repositoryMap(limit) || 'Repository map is empty.';
		}
		const query = parameters.query?.trim();
		if (!query) {throw new Error('query is required for this graph action');}
		if (this.semantic && (parameters.action === 'definitions' || parameters.action === 'references' || parameters.action === 'callers' || parameters.action === 'callees')) {
			const resolved = await this.semantic.resolve(query, parameters.action, limit, token);
			if (resolved.length) {return resolved.join('\n');}
		}
		if (parameters.action === 'definitions') {
			const symbols = this.outline.search(query, limit);
			return symbols.length ? symbols.map(symbol => `${symbol.filePath}:${symbol.lineStart}-${symbol.lineEnd} ${symbol.kind} ${symbol.name} ${symbol.signature}`).join('\n') : 'No definitions found.';
		}
		const kinds = relationKinds(parameters.action);
		const relations = parameters.action === 'callers'
			? this.outline.incoming(query, kinds, limit)
			: parameters.action === 'callees' || parameters.action === 'dependencies'
				? this.outline.outgoing(query, kinds, limit)
				: this.outline.related(query, kinds, limit);
		return relations.length ? relations.map(relation => `${relation.filePath}:${relation.line} ${relation.from} -[${relation.kind}]-> ${relation.to}`).join('\n') : 'No structural relationships found.';
	}
}

function relationKinds(action: CodeGraphParameters['action']): readonly SymbolRelationKind[] {
	switch (action) {
		case 'callers': return ['calls'];
		case 'callees': return ['calls'];
		case 'dependencies': return ['imports', 'extends', 'implements'];
		default: return ['references', 'calls', 'imports', 'extends', 'implements', 'exports'];
	}
}
