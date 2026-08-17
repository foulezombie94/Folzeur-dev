/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const NORMALIZATION_MAPS = {
	SMART_QUOTES: {
		'\u201C': '"', // Left double quote
		'\u201D': '"', // Right double quote
		'\u2018': '\'', // Left single quote
		'\u2019': '\'', // Right single quote
	},
	TYPOGRAPHIC: {
		'\u2026': '...', // Ellipsis
		'\u2014': '-', // Em dash
		'\u2013': '-', // En dash
		'\u00A0': ' ', // Non-breaking space
	},
};

export interface NormalizeOptions {
	smartQuotes?: boolean;
	typographicChars?: boolean;
	extraWhitespace?: boolean;
	trim?: boolean;
}

const DEFAULT_OPTIONS: NormalizeOptions = {
	smartQuotes: true,
	typographicChars: true,
	extraWhitespace: true,
	trim: true,
};

export function normalizeString(str: string, options: NormalizeOptions = DEFAULT_OPTIONS): string {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	let normalized = str;

	if (opts.smartQuotes) {
		for (const [smart, regular] of Object.entries(NORMALIZATION_MAPS.SMART_QUOTES)) {
			normalized = normalized.replace(new RegExp(smart, 'g'), regular);
		}
	}

	if (opts.typographicChars) {
		for (const [typographic, regular] of Object.entries(NORMALIZATION_MAPS.TYPOGRAPHIC)) {
			normalized = normalized.replace(new RegExp(typographic, 'g'), regular);
		}
	}

	if (opts.extraWhitespace) {
		normalized = normalized.replace(/\s+/g, ' ');
	}

	if (opts.trim) {
		normalized = normalized.trim();
	}

	return normalized;
}

export function unescapeHtmlEntities(text: string): string {
	if (!text) {
		return text;
	}
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, '\'')
		.replace(/&apos;/g, '\'')
		.replace(/&#91;/g, '[')
		.replace(/&#93;/g, ']')
		.replace(/&lsqb;/g, '[')
		.replace(/&rsqb;/g, ']')
		.replace(/&amp;/g, '&');
}
