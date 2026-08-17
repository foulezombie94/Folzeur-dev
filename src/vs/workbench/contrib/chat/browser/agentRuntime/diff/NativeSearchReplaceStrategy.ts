/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { rustEngine } from '../native/rustEngine.js';

export interface DiffResult {
	success: boolean;
	content?: string;
	error?: string;
}

export interface DiffStrategy {
	getName(): string;
	applyDiff(
		originalContent: string,
		diffContent: string,
		paramStartLine?: number,
		paramEndLine?: number,
		filePath?: string,
	): Promise<DiffResult>;
}

export class NativeSearchReplaceStrategy implements DiffStrategy {
	getName(): string {
		return 'NativeASTDiff_Myers';
	}

	async applyDiff(
		originalContent: string,
		diffContent: string,
		_paramStartLine?: number,
		_paramEndLine?: number,
		filePath?: string,
	): Promise<DiffResult> {
		// Delegate to the native Rust engine for AST parsing and Search/Replace Diffing
		return rustEngine.applySearchReplaceBlocks(originalContent, diffContent, filePath);
	}
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
