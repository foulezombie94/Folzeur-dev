/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const SENSITIVE_PATH_COMPONENT = /(?:^|[\\/])(?:\.history|\.idea|\.vscode)(?:$|[\\/])/i;
const SECRET_FILE_NAMES = /(?:^|[\\/])(?:\.DS_Store|Thumbs\.db|\.env(?:\.[^\\/]+)?|\.npmrc|\.pypirc|credentials(?:\.[^\\/]+)?\.json|secrets?(?:\.[^\\/]+)?\.json|id_(?:rsa|dsa|ecdsa|ed25519)|[^\\/]+\.(?:db|der|dump|jks|key|keystore|log|ovpn|p12|pfx|pem|sql|sqlite|sqlite3))(?:$|[\\/])/i;

export function isSensitivePath(path: string): boolean {
	const normalized = path.replace(/\\/g, '/');
	return SENSITIVE_PATH_COMPONENT.test(normalized) || SECRET_FILE_NAMES.test(normalized);
}

/** Redacts common credentials without retaining the original value in telemetry or tool output. */
export function redactSecrets(value: string): string {
	const redacted = value
		.replace(/\b(?:sk(?:-proj)?|gh[pousr]|github_pat|glpat|xox[baprs]|npm|pypi|hf)[-_A-Za-z0-9]{12,}\b/gi, '[REDACTED_TOKEN]')
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
		.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
		.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
		.replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[REDACTED]')
		.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi, '$1[REDACTED]$2');
	return redacted.split(/(\s+|["'`,;(){}\[\]])/).map(token => isHighEntropySecret(token) ? '[REDACTED_HIGH_ENTROPY]' : token).join('');
}

export function sanitizeRepositoryTextForModel(path: string, value: string): string {
	if (isSensitivePath(path)) {
		return '[REDACTED_SENSITIVE_FILE]';
	}
	return redactSecrets(value);
}

function isHighEntropySecret(token: string): boolean {
	if (token.length < 28 || token.length > 512 || /^(?:https?:|[A-Za-z]:[\\/]|\.{0,2}[\\/])/.test(token)) {
		return false;
	}
	// Content hashes and structured identifiers are high entropy by design, but are
	// routinely present in source, manifests and logs without containing credentials.
	if (/^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128})$/i.test(token)
		|| /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
		|| /^(?:sha(?:1|224|256|384|512)|md5)[-=:][A-Za-z0-9+/=_-]{20,}$/i.test(token)
		|| /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(token)) {
		return false;
	}
	if (!/[a-z]/.test(token) || !/[A-Z0-9]/.test(token) || !/^[A-Za-z0-9_+/.=-]+$/.test(token)) {
		return false;
	}
	const counts = new Map<string, number>();
	for (const character of token) {counts.set(character, (counts.get(character) ?? 0) + 1);}
	let entropy = 0;
	for (const count of counts.values()) {const probability = count / token.length; entropy -= probability * Math.log2(probability);}
	return entropy >= 4.25;
}
