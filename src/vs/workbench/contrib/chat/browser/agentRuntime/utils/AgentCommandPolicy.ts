/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type AgentCommandRisk = 'read_only' | 'verification' | 'mutation' | 'destructive';

export interface VerificationAssessment {
	readonly accepted: boolean;
	readonly reason: string;
}

export interface CommandSandboxAssessment {
	readonly allowed: boolean;
	readonly reason: string;
}

const SHELL_CONTROL = /(?:\r|\n|[;&|><`]|\$\(|\$\{|\^\(|%\w+%|!\w+!)/;
const READ_ONLY_COMMAND = /^(?:git\s+(?:status|diff|log|show|ls-files|rev-parse|remote\s+-v|branch\s+(?:--show-current|--list))\b|(?:rg|grep)\b|(?:ls|dir|pwd|tree)\b|(?:get-childitem|get-location|get-content|select-string)\b|cargo\s+(?:metadata|tree|version)\b|(?:node|npm|pnpm|yarn|bun|deno|python|python3|pip|uv|poetry|go|dotnet|java|mvn|gradle|rustc)\s+(?:--?version|--?info|list|tree|metadata)\b)/i;
const TEST_COMMAND = /^(?:(?:npm|pnpm|bun)\s+(?:test\b|run\s+[\w:.-]*test[\w:.-]*\b)|yarn\s+(?:test\b|[\w:.-]*test[\w:.-]*\b)|deno\s+test\b|cargo\s+test\b|(?:python(?:3)?\s+-m\s+)?pytest\b|(?:uv\s+run\s+|poetry\s+run\s+)?pytest\b|(?:npx\s+)?(?:vitest|jest|mocha)\b|go\s+test\b|dotnet\s+test\b|(?:mvnw?|gradlew?)\s+test\b|bundle\s+exec\s+rspec\b|phpunit\b|swift\s+test\b)/i;
const BUILD_COMMAND = /^(?:(?:npm|pnpm|bun)\s+run\s+(?:build|compile|typecheck|check|lint)(?::[\w.-]+)?\b|yarn\s+(?:build|compile|typecheck|check|lint)\b|(?:npx\s+)?(?:nx|turbo)\s+(?:build|test|lint|typecheck)\b|deno\s+(?:check|lint)\b|cargo\s+(?:build|check|clippy)\b|(?:npx\s+)?tsc\b|go\s+(?:build|vet)\b|dotnet\s+build\b|(?:mvnw?|gradlew?)\s+(?:build|check|verify)\b|(?:cmake|make|bazel)\b|swift\s+build\b|composer\s+(?:validate|check-platform-reqs)\b|ruby\s+-c\b|php\s+-l\b|(?:curl|wget)\b[^\r\n]*(?:localhost|127\.0\.0\.1))/i;
const DESTRUCTIVE_COMMAND = /(?:^|[\s;&|()])(?:rm\s+-[^\r\n;&|]*r[^\r\n;&|]*f|(?:remove-item|ri)\b[^\r\n;&|]*(?:-recurse|-force)|(?:rmdir|rd|del|erase)\b[^\r\n;&|]*(?:\/(?:s|q)|-recurse|-force)|git\s+(?:reset\s+--hard|clean\s+-[^\r\n;&|]*f|push\b[^\r\n;&|]*--force)|format\s+[a-z]:|diskpart\b|(?:drop\s+(?:database|table|schema)|truncate\s+table)\b|(?:shutdown|stop-computer|restart-computer|taskkill|kill)\b|(?:reg|sc)\s+delete\b|docker\s+(?:system|volume|image)\s+prune\b|kubectl\s+delete\b|terraform\s+destroy\b|powershell(?:\.exe)?\b[^\r\n;&|]*(?:-encodedcommand|-enc)\b)/i;
const EMPTY_VERIFICATION = /(?:\bno tests? (?:found|collected|ran)\b|\b0 tests?\b|\b0 passing\b|command not found|is not recognized as an internal or external command)/i;

function normalize(command: string): string {
	return command.trim().replace(/\s+/g, ' ');
}

function canonicalForRisk(command: string): string {
	// Joining quoted command fragments is a common way to bypass token-based deny rules.
	// This is still best-effort parsing, so unknown commands remain mutations.
	return normalize(command).replace(/["']/g, '');
}

export function hasShellControlOperators(command: string): boolean {
	return SHELL_CONTROL.test(command);
}

/** Unknown/free-form terminal commands are mutations by default. */
export function classifyAgentCommand(command: string): AgentCommandRisk {
	const normalized = canonicalForRisk(command);
	if (DESTRUCTIVE_COMMAND.test(normalized)) {
		return 'destructive';
	}
	if (!normalized || hasShellControlOperators(command)) {
		return 'mutation';
	}
	if (TEST_COMMAND.test(normalized) || BUILD_COMMAND.test(normalized)) {
		return 'verification';
	}
	return READ_ONLY_COMMAND.test(normalized) ? 'read_only' : 'mutation';
}

/** An allowlist entry can never turn an unknown or state-changing command into a read-only command. */
export function isAllowlistedCommand(command: string, configuredPrefixes: readonly string[]): boolean {
	const normalized = normalize(command);
	const risk = classifyAgentCommand(normalized);
	if (!normalized || hasShellControlOperators(command) || risk === 'mutation' || risk === 'destructive') {
		return false;
	}
	return configuredPrefixes.some(value => {
		const prefix = normalize(value);
		return prefix.length > 0 && !hasShellControlOperators(prefix) && (normalized === prefix || normalized.startsWith(`${prefix} `));
	});
}

/** Fail-closed workspace boundary for free-form terminal commands. */
export function assessCommandSandbox(command: string, cwd: string): CommandSandboxAssessment {
	const normalizedCwd = normalizePath(cwd);
	if (!normalizedCwd) {return { allowed: false, reason: 'the terminal workspace is not available' };}
	if (/\0/.test(command)) {return { allowed: false, reason: 'null-containing commands are not accepted' };}
	// Shell syntax and interpreters are supported when the OS-backed sandbox is active.
	// If it is unavailable, TerminalSandboxBoundary blocks every write-capable command
	// unless the user grants the explicit unsandboxed-host permission.
	return { allowed: true, reason: 'the operating-system terminal sandbox enforces the workspace boundary' };
}

export function assessVerification(toolName: 'run_tests' | 'build' | 'run_command' | 'execute_command', command: string, exitCode: number | undefined, output: string): VerificationAssessment {
	const normalized = normalize(command);
	if (exitCode !== 0) {
		return { accepted: false, reason: `verification command exited with code ${String(exitCode)}` };
	}
	if (!normalized || hasShellControlOperators(command)) {
		return { accepted: false, reason: 'verification commands must be one direct command without shell control operators' };
	}
	const matchesRunner = toolName === 'run_tests' ? TEST_COMMAND.test(normalized) : toolName === 'build' ? BUILD_COMMAND.test(normalized) : TEST_COMMAND.test(normalized) || BUILD_COMMAND.test(normalized);
	if (!matchesRunner) {
		return { accepted: false, reason: `command is not a recognized ${toolName === 'run_tests' ? 'test runner' : toolName === 'build' ? 'build/typecheck runner' : 'test, lint, typecheck, build, or HTTP smoke verification'}` };
	}
	if (toolName === 'run_tests' && EMPTY_VERIFICATION.test(output)) {
		return { accepted: false, reason: 'the test runner did not execute any tests' };
	}
	return { accepted: true, reason: 'recognized verification command completed successfully' };
}

function normalizePath(value: string): string {
	return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
