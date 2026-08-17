/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../../../editor/common/services/resolverService.js';

interface SnapshotEntry {
	readonly content: string;
	readonly source: URI;
	readonly size: number;
}

const MAX_SNAPSHOTS = 500;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** Read-only, bounded content provider used by native diff editors for completed agent edits. */
export class AgentSnapshotContentProvider extends Disposable implements ITextModelContentProvider {
	static readonly scheme = 'folzeur-agent-snapshot';

	private readonly entries = new Map<string, SnapshotEntry>();
	private totalBytes = 0;
	private sequence = 0;

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(AgentSnapshotContentProvider.scheme, this));
	}

	add(sessionId: string, source: URI, content: string, side: 'before' | 'after'): URI {
		const resource = URI.from({
			scheme: AgentSnapshotContentProvider.scheme,
			path: source.path,
			query: `session=${encodeURIComponent(sessionId)}&side=${side}&version=${++this.sequence}`,
		});
		const size = content.length * 2;
		this.entries.set(resource.toString(), { content, source, size });
		this.totalBytes += size;
		this.prune();
		return resource;
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this.modelService.getModel(resource);
		if (existing && !existing.isDisposed()) {
			return existing;
		}
		const entry = this.entries.get(resource.toString());
		if (!entry) {
			return null;
		}
		return this.modelService.createModel(entry.content, this.languageService.createByFilepathOrFirstLine(entry.source), resource);
	}

	private prune(): void {
		while (this.entries.size > MAX_SNAPSHOTS || this.totalBytes > MAX_SNAPSHOT_BYTES) {
			const oldest = this.entries.entries().next().value as [string, SnapshotEntry] | undefined;
			if (!oldest) {
				break;
			}
			this.entries.delete(oldest[0]);
			this.totalBytes -= oldest[1].size;
		}
	}

	override dispose(): void {
		this.entries.clear();
		this.totalBytes = 0;
		super.dispose();
	}
}
