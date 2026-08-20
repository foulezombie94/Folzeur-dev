/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../../../../../base/common/buffer.js';

const ENCRYPTION_VERSION = 'aesgcm1';

/** Cryptographic integrity and confidentiality for durable agent state. */
export class AgentStateCrypto {
	private constructor(private readonly rawKey: Uint8Array) { }

	public static fromBase64(secret: string): AgentStateCrypto {
		const key = decodeBase64(secret).buffer;
		if (key.byteLength !== 32) {throw new Error('Invalid agent-state encryption key.');}
		return new AgentStateCrypto(new Uint8Array(key));
	}

	public static generateKey(): string {
		const key = new Uint8Array(32);
		globalThis.crypto.getRandomValues(key);
		return encodeBase64(VSBuffer.wrap(key));
	}

	public async sha256(value: string): Promise<string> {
		return sha256(value);
	}

	public async sign(value: string): Promise<string> {
		const key = await globalThis.crypto.subtle.importKey('raw', toArrayBuffer(this.rawKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const signature = await globalThis.crypto.subtle.sign('HMAC', key, toArrayBuffer(VSBuffer.fromString(value).buffer));
		return encodeBase64(VSBuffer.wrap(new Uint8Array(signature)));
	}

	public async verify(value: string, signature: string): Promise<boolean> {
		const key = await globalThis.crypto.subtle.importKey('raw', toArrayBuffer(this.rawKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
		return globalThis.crypto.subtle.verify('HMAC', key, toArrayBuffer(decodeBase64(signature).buffer), toArrayBuffer(VSBuffer.fromString(value).buffer));
	}

	public async encrypt(value: string): Promise<string> {
		const iv = new Uint8Array(12);
		globalThis.crypto.getRandomValues(iv);
		const key = await globalThis.crypto.subtle.importKey('raw', toArrayBuffer(this.rawKey), 'AES-GCM', false, ['encrypt']);
		const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(VSBuffer.fromString(value).buffer)));
		const payload = new Uint8Array(iv.byteLength + encrypted.byteLength);
		payload.set(iv, 0);
		payload.set(encrypted, iv.byteLength);
		return `${ENCRYPTION_VERSION}:${encodeBase64(VSBuffer.wrap(payload))}`;
	}

	public async decrypt(value: string): Promise<string> {
		const [version, encoded] = value.split(':', 2);
		if (version !== ENCRYPTION_VERSION || !encoded) {throw new Error('Unsupported encrypted agent-state blob.');}
		const payload = decodeBase64(encoded).buffer;
		if (payload.byteLength < 29) {throw new Error('Encrypted agent-state blob is truncated.');}
		const iv = payload.slice(0, 12);
		const ciphertext = payload.slice(12);
		const key = await globalThis.crypto.subtle.importKey('raw', toArrayBuffer(this.rawKey), 'AES-GCM', false, ['decrypt']);
		const plaintext = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(ciphertext));
		return VSBuffer.wrap(new Uint8Array(plaintext)).toString();
	}
}

/** Collision-resistant identity for file contents and durable state. */
export async function sha256(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(VSBuffer.fromString(value).buffer));
	return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
	let result = '';
	for (const byte of bytes) {result += byte.toString(16).padStart(2, '0');}
	return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}
