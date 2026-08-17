/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Position } from '../../../../../../editor/common/core/position.js';
import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { getDefinitionsAtPosition, getReferencesAtPosition } from '../../../../../../editor/contrib/gotoSymbol/browser/goToSymbol.js';
import { WorkspaceOutlineIndex } from './WorkspaceOutlineIndex.js';
import { CallHierarchyModel } from '../../../../callHierarchy/common/callHierarchy.js';

export type SemanticGraphAction = 'definitions' | 'references' | 'callers' | 'callees';

/** Resolves graph edges through active language providers instead of guessing them from source text. */
export class SemanticCodeGraphService {
	constructor(
		private readonly workspace: URI,
		private readonly outline: WorkspaceOutlineIndex,
		private readonly textModelService: ITextModelService,
		private readonly languageFeaturesService: ILanguageFeaturesService,
	) { }

	public async resolve(query: string, action: SemanticGraphAction, limit: number, token: CancellationToken): Promise<readonly string[]> {
		await this.outline.ready();
		const symbols = this.outline.search(query, Math.min(12, limit));
		const output = new Set<string>();
		for (const symbol of symbols) {
			if (token.isCancellationRequested || output.size >= limit) {break;}
			const resource = URI.joinPath(this.workspace, symbol.filePath);
			let reference;
			try {
				reference = await this.textModelService.createModelReference(resource);
				const model = reference.object.textEditorModel;
				const line = model.getLineContent(Math.min(symbol.lineStart, model.getLineCount()));
				const simpleName = symbol.name.split('.').pop() ?? symbol.name;
				const column = Math.max(1, line.indexOf(simpleName) + 1);
				const position = new Position(symbol.lineStart, column);
				if (action === 'callers' || action === 'callees') {
					const hierarchy = await CallHierarchyModel.create(model, position, token);
					try {
						for (const root of hierarchy?.roots ?? []) {
							if (action === 'callers') {
								for (const call of await hierarchy!.resolveIncomingCalls(root, token)) {
									if (output.size >= limit) { break; }
									output.add(`${call.from.uri.fsPath}:${call.from.range.startLineNumber} ${call.from.name} -[calls]-> ${root.uri.fsPath}:${root.range.startLineNumber} ${root.name}`);
								}
							} else {
								for (const call of await hierarchy!.resolveOutgoingCalls(root, token)) {
									if (output.size >= limit) { break; }
									output.add(`${root.uri.fsPath}:${root.range.startLineNumber} ${root.name} -[calls]-> ${call.to.uri.fsPath}:${call.to.range.startLineNumber} ${call.to.name}`);
								}
							}
						}
					} finally {
						hierarchy?.dispose();
					}
					if (output.size || action === 'callees') { continue; }
				}
				const links = action === 'definitions'
					? await getDefinitionsAtPosition(this.languageFeaturesService.definitionProvider, model, position, false, token)
					: await getReferencesAtPosition(this.languageFeaturesService.referenceProvider, model, position, false, false, token);
				for (const link of links) {
					if (output.size >= limit) {break;}
					const range = link.range;
					const relation = action === 'definitions' ? 'defines' : action === 'callers' ? 'referenced-by' : 'references';
					output.add(`${link.uri.fsPath}:${range.startLineNumber}:${range.startColumn} ${symbol.name} -[${relation}]-> ${resource.fsPath}:${symbol.lineStart}`);
				}
			} catch {
				// A language server may not be installed or ready. The structural graph remains available.
			} finally {
				reference?.dispose();
			}
		}
		return [...output];
	}
}
