/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function addLineNumbers(content: string, startLine: number = 1): string {
	if (content === '') {
		return startLine === 1 ? '' : `${startLine} | \n`;
	}

	const lines = content.split('\n');
	const lastLineEmpty = lines[lines.length - 1] === '';
	if (lastLineEmpty) {
		lines.pop();
	}

	const maxLineNumberWidth = String(startLine + lines.length - 1).length;
	const numberedContent = lines
		.map((line, index) => {
			const lineNumber = String(startLine + index).padStart(maxLineNumberWidth, ' ');
			return `${lineNumber} | ${line}`;
		})
		.join('\n');

	return numberedContent + '\n';
}

export function everyLineHasLineNumbers(content: string): boolean {
	const lines = content.split(/\r?\n/);
	return lines.length > 0 && lines.every((line) => /^\s*\d+\s+\|(?!\|)/.test(line));
}

export function stripLineNumbers(content: string, aggressive: boolean = false): string {
	const lines = content.split(/\r?\n/);

	const processedLines = lines.map((line) => {
		const match = aggressive ? line.match(/^\s*(?:\d+\s)?\|\s(.*)$/) : line.match(/^\s*\d+\s+\|(?!\|)\s?(.*)$/);
		return match ? match[1] : line;
	});

	const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
	let result = processedLines.join(lineEnding);

	if (content.endsWith(lineEnding)) {
		if (!result.endsWith(lineEnding)) {
			result += lineEnding;
		}
	}

	return result;
}
