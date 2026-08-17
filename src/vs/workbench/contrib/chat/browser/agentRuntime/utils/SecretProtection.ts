/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const SECRET_FILE_NAMES = /(?:^|[\\/])(?:\.env(?:\.[^\\/]+)?|\.npmrc|\.pypirc|credentials(?:\.[^\\/]+)?\.json|secrets?(?:\.[^\\/]+)?\.json|id_(?:rsa|dsa|ecdsa|ed25519)|[^\\/]+\.(?:pem|key|p12|pfx))(?:$|[\\/])/i;

export function isSensitivePath(path: string): boolean {
	return SECRET_FILE_NAMES.test(path.replace(/\\/g, '/'));
}

/** Redacts common credentials without retaining the original value in telemetry or tool output. */
export function redactSecrets(value: string): string {
	return value
		.replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/gi, '[REDACTED_TOKEN]')
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
		.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
		.replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[REDACTED]')
		.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi, '$1[REDACTED]$2');
}
