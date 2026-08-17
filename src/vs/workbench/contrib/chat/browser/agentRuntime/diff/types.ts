/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface DiffResult {
	success: boolean;
	content?: string;
	error?: string;
	failParts?: DiffResult[];
	details?: unknown;
}

export interface DiffStrategy {
	getName(): string;
	applyDiff(
		originalContent: string,
		diffContent: string,
		startLine?: number,
		endLine?: number
	): Promise<DiffResult>;
}
