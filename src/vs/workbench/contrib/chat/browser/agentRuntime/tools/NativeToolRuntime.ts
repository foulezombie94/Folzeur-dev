/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatProgress } from '../../../common/chatService/chatService.js';
import { INativeTool } from './INativeTool.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { redactSecrets } from '../utils/SecretProtection.js';
import { hashToolParameters, isMutationEffect, resolveNativeToolPolicy } from './NativeToolPolicyRegistry.js';
import { hasKey } from '../../../../../../base/common/types.js';

interface JsonSchema {
	readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly enum?: readonly unknown[];
	readonly items?: JsonSchema;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly additionalProperties?: boolean;
}

const MAX_PARAMETER_CHARACTERS = 2_000_000;

/** Validates, bounds and coalesces tool execution at the LLM trust boundary. */
export class NativeToolRuntime {
	private readonly pending: Array<{ resolve: () => void; reject: (error: Error) => void; cancellation: IDisposable }> = [];
	private readonly inFlight = new Map<string, Promise<unknown>>();
	private readonly resourceTails = new Map<string, Promise<void>>();
	private active = 0;

	constructor(private readonly maxConcurrency = 4) { }

	public validate(tool: INativeTool, parameters: unknown): void {
		const errors: string[] = [];
		validateValue(parameters, tool.inputSchema as JsonSchema, '$', errors);
		if (errors.length) {
			throw new Error(`Invalid parameters for ${tool.name}: ${errors.slice(0, 8).join('; ')}`);
		}
		this.validateSemantic(parameters);
	}

	public async execute(tool: INativeTool, parameters: Record<string, unknown>, cwd: string, progress?: (part: IChatProgress) => void, token: CancellationToken = CancellationToken.None): Promise<unknown> {
		const policy = resolveNativeToolPolicy(tool.name, parameters);
		const key = policy.coalescible ? `${tool.name}:${hashToolParameters(parameters)}:${cwd}` : undefined;
		if (key) {
			const existing = this.inFlight.get(key);
			if (existing) {return existing;}
		}
		if (token.isCancellationRequested) {throw new Error('Tool execution cancelled.');}
		const resources = isMutationEffect(policy.effect) ? mutationResources(parameters, cwd, policy.targetKeys) : [];
		const operation = this.runBounded(() => this.withResourceLocks(resources, async () => sanitizeResult(await tool.execute(parameters, cwd, progress, token)), token), token);
		if (key) {this.inFlight.set(key, operation);}
		try {
			return await operation;
		} finally {
			if (key) {this.inFlight.delete(key);}
		}
	}

	private validateSemantic(parameters: unknown): void {
		let serialized: string;
		try { serialized = JSON.stringify(parameters); } catch { throw new Error('Tool parameters must be JSON-serializable.'); }
		if (serialized.length > MAX_PARAMETER_CHARACTERS) {throw new Error(`Tool parameters exceed the ${MAX_PARAMETER_CHARACTERS}-character safety limit.`);}
		const inspect = (value: unknown, depth: number): void => {
			if (depth > 32) {throw new Error('Tool parameters exceed the maximum nesting depth.');}
			if (typeof value === 'string' && value.includes('\0')) {throw new Error('Tool parameters may not contain NUL characters.');}
			if (Array.isArray(value)) { for (const child of value) {inspect(child, depth + 1);} return; }
			if (value && typeof value === 'object') {
				const prototype = Object.getPrototypeOf(value);
				if (prototype !== Object.prototype && prototype !== null) {throw new Error('Tool parameters must contain plain JSON objects only.');}
				for (const [key, child] of Object.entries(value)) {
					if (key === '__proto__' || key === 'prototype' || key === 'constructor') {throw new Error(`Unsafe tool parameter key: ${key}.`);}
					inspect(child, depth + 1);
				}
			}
		};
		inspect(parameters, 0);
	}

	private async withResourceLocks<T>(resources: readonly string[], operation: () => Promise<T>, token: CancellationToken): Promise<T> {
		const keys = [...new Set(resources.map(normalizeResource).filter(Boolean))].sort();
		if (!keys.length) {return operation();}
		const predecessors = keys.map(key => this.resourceTails.get(key) ?? Promise.resolve());
		let release!: () => void;
		const tail = new Promise<void>(resolve => release = resolve);
		for (const key of keys) {this.resourceTails.set(key, tail);}
		try {
			await waitForPromisesOrCancellation(predecessors, token);
			if (token.isCancellationRequested) {throw new Error('Tool execution cancelled while waiting for a resource lock.');}
			return await operation();
		} finally {
			release();
			for (const key of keys) {if (this.resourceTails.get(key) === tail) {this.resourceTails.delete(key);}}
		}
	}

	private async runBounded<T>(operation: () => Promise<T>, token: CancellationToken): Promise<T> {
		if (this.active >= this.maxConcurrency) {
			await new Promise<void>((resolve, reject) => {
				let cancelled = false;
				const emptyCancellation: IDisposable = { dispose() { } };
				const entry = { resolve: () => { entry.cancellation.dispose(); resolve(); }, reject, cancellation: emptyCancellation };
				entry.cancellation = token.onCancellationRequested(() => {
					cancelled = true;
					const index = this.pending.indexOf(entry);
					if (index >= 0) {this.pending.splice(index, 1);}
					reject(new Error('Tool execution cancelled while waiting for capacity.'));
				});
				if (!cancelled) {this.pending.push(entry);}
			});
		}
		if (token.isCancellationRequested) {throw new Error('Tool execution cancelled.');}
		this.active++;
		try {
			return await operation();
		} finally {
			this.active--;
			this.pending.shift()?.resolve();
		}
	}
}

function waitForPromisesOrCancellation(promises: readonly Promise<void>[], token: CancellationToken): Promise<void> {
	if (token.isCancellationRequested) {return Promise.reject(new Error('Tool execution cancelled while waiting for a resource lock.'));}
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const cancellation = token.onCancellationRequested(() => {
			if (settled) {return;}
			settled = true;
			reject(new Error('Tool execution cancelled while waiting for a resource lock.'));
		});
		Promise.all(promises).then(() => {
			if (settled) {return;}
			settled = true;
			cancellation.dispose();
			resolve();
		}, error => {
			if (settled) {return;}
			settled = true;
			cancellation.dispose();
			reject(error);
		});
	});
}

function mutationResources(parameters: Record<string, unknown>, cwd: string, targetKeys: readonly string[]): string[] {
	const paths: string[] = [];
	if (targetKeys.includes('changes') && Array.isArray(parameters.changes)) {
		for (const change of parameters.changes) {if (change && typeof change === 'object' && typeof (change as Record<string, unknown>).filePath === 'string') {paths.push((change as Record<string, string>).filePath);}}
	}
	for (const key of ['path', 'filePath']) {if (targetKeys.includes(key) && typeof parameters[key] === 'string') {paths.push(parameters[key] as string);}}
	return paths.length ? paths : [cwd];
}

function normalizeResource(value: string): string {
	return value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

function sanitizeResult<T>(value: T, depth = 0): T {
	if (depth > 16) {return value;}
	if (typeof value === 'string') {return redactSecrets(value) as T;}
	if (Array.isArray(value)) {return value.map(child => sanitizeResult(child, depth + 1)) as T;}
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {result[key] = sanitizeResult(child, depth + 1);}
		return result as T;
	}
	return value;
}

function validateValue(value: unknown, schema: JsonSchema | undefined, path: string, errors: string[]): void {
	if (!schema || errors.length >= 8) {return;}
	if (schema.enum && !schema.enum.some(candidate => candidate === value)) {errors.push(`${path} must be one of ${schema.enum.join(', ')}`);}
	if (schema.type === 'object') {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path} must be an object`); return; }
		const record = value as Record<string, unknown>;
		for (const required of schema.required ?? []) {if (!hasKey(record, { [required]: true })) {errors.push(`${path}.${required} is required`);}}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {if (hasKey(record, { [key]: true })) {validateValue(record[key], child, `${path}.${key}`, errors);}}
		if (schema.additionalProperties === false) {for (const key of Object.keys(record)) {if (!hasKey(schema.properties ?? {}, { [key]: true })) {errors.push(`${path}.${key} is not allowed`);}}}
		return;
	}
	if (schema.type === 'array') {
		if (!Array.isArray(value)) { errors.push(`${path} must be an array`); return; }
		if (schema.minItems !== undefined && value.length < schema.minItems) {errors.push(`${path} must contain at least ${schema.minItems} items`);}
		if (schema.maxItems !== undefined && value.length > schema.maxItems) {errors.push(`${path} must contain at most ${schema.maxItems} items`);}
		value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, errors));
		return;
	}
	if (schema.type === 'string') {
		if (typeof value !== 'string') { errors.push(`${path} must be a string`); return; }
		if (schema.minLength !== undefined && value.length < schema.minLength) {errors.push(`${path} is too short`);}
		if (schema.maxLength !== undefined && value.length > schema.maxLength) {errors.push(`${path} is too long`);}
		return;
	}
	if (schema.type === 'boolean' && typeof value !== 'boolean') {errors.push(`${path} must be a boolean`);}
	if ((schema.type === 'number' || schema.type === 'integer')) {
		if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) { errors.push(`${path} must be a finite ${schema.type}`); return; }
		if (schema.minimum !== undefined && value < schema.minimum) {errors.push(`${path} must be >= ${schema.minimum}`);}
		if (schema.maximum !== undefined && value > schema.maximum) {errors.push(`${path} must be <= ${schema.maximum}`);}
	}
}
