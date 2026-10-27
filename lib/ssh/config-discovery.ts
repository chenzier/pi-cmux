import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseSshTarget } from "./target.ts";

export type DiscoveryDiagnostic =
	| "config-unavailable" | "unsafe-path" | "unsupported-syntax" | "conditional-include"
	| "include-cycle" | "depth-limit" | "file-limit" | "byte-limit" | "line-limit"
	| "directory-limit" | "candidate-limit" | "alias-skipped"
	| "cmux-unavailable" | "cmux-malformed" | "workspace-limit";
export interface DiscoveryLimits {
	depth: number; files: number; fileBytes: number; totalBytes: number;
	lines: number; candidates: number; directoryEntries: number;
}
export const DEFAULT_DISCOVERY_LIMITS: Readonly<DiscoveryLimits> = Object.freeze({
	depth: 8, files: 32, fileBytes: 64 * 1024, totalBytes: 256 * 1024,
	lines: 8192, candidates: 256, directoryEntries: 256,
});
export interface ConfigDiscoveryOptions {
	enabled: boolean;
	homeDirectory?: string;
	configPath?: string;
	/** Values may lower, but never increase, the hard bounds. */
	limits?: Partial<DiscoveryLimits>;
}
export interface AliasCandidate { readonly kind: "alias"; readonly destination: string }
export interface ConfigDiscoveryResult {
	readonly aliases: readonly AliasCandidate[];
	readonly diagnostics: readonly DiscoveryDiagnostic[];
	readonly partial: boolean;
}
export function discoveryLimits(input?: Partial<DiscoveryLimits>): DiscoveryLimits {
	const result = { ...DEFAULT_DISCOVERY_LIMITS };
	for (const key of Object.keys(result) as (keyof DiscoveryLimits)[]) {
		const value = input?.[key];
		if (typeof value === "number" && Number.isInteger(value) && value > 0) result[key] = Math.min(value, result[key]);
	}
	return result;
}
/** Validate only; the placeholder directory is never returned as a suggestion. */
export function concreteDestination(value: unknown): string | undefined {
	try { return parseSshTarget({ destination: value, remoteCwd: "/" }).destination; } catch { return undefined; }
}

// Deliberately not a full OpenSSH lexer: backslash continuations/escapes are refused.
function tokens(line: string): string[] | undefined {
	const out: string[] = [];
	let word = "", quote = "", started = false;
	for (const c of line) {
		if (c === "\\" || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c)) return undefined;
		if (quote) { if (c === quote) quote = ""; else word += c; started = true; }
		else if (c === '"' || c === "'") { quote = c; started = true; }
		else if (c === "#") break;
		else if (/\s/.test(c)) { if (started) { out.push(word); word = ""; started = false; } }
		else { word += c; started = true; }
	}
	if (quote) return undefined;
	if (started) out.push(word);
	return out;
}
function allowedName(name: string): boolean {
	return !/^id_/i.test(name) && !/known_hosts/i.test(name) && !/\.(pub|key|pem)$/i.test(name)
		&& (name === "config" || /^[A-Za-z0-9_.-]+\.conf$/.test(name));
}

/** Opt-in filesystem-only discovery. No config command is interpreted or executed. */
export async function discoverSshConfig(options: ConfigDiscoveryOptions): Promise<ConfigDiscoveryResult> {
	const aliases: AliasCandidate[] = [], diagnostics = new Set<DiscoveryDiagnostic>();
	const finish = (): ConfigDiscoveryResult => Object.freeze({ aliases: Object.freeze(aliases),
		diagnostics: Object.freeze([...diagnostics]), partial: diagnostics.size > 0 });
	if (options.enabled !== true) return finish();
	const limits = discoveryLimits(options.limits), seen = new Set<string>(), active = new Set<string>();
	const home = resolve(options.homeDirectory ?? homedir());
	// OpenSSH resolves user Include paths relative to ~/.ssh, including when
	// the root config itself is a nested/custom file. Keep this trusted tree
	// fixed rather than widening it to an arbitrary configPath's parent.
	const base = join(home, ".ssh"), config = resolve(options.configPath ?? join(base, "config"));
	let files = 0, bytes = 0, lines = 0, entries = 0;
	const note = (code: DiscoveryDiagnostic) => { diagnostics.add(code); };
	// Check each component below the trusted configured root, not just the leaf.
	async function safe(path: string): Promise<boolean> {
		const rel = relative(base, path);
		if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) { note("unsafe-path"); return false; }
		let current = base;
		for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
			if (part) current = join(current, part);
			try {
				const st = await lstat(current);
				if (st.isSymbolicLink() || (current !== path && !st.isDirectory())) { note("unsafe-path"); return false; }
			} catch { note("config-unavailable"); return false; }
		}
		return true;
	}
	async function expand(pattern: string): Promise<string[]> {
		if (pattern.startsWith("~/")) pattern = join(home, pattern.slice(2));
		if (/[~$%\\\[\]{}!]/.test(pattern)) { note("unsafe-path"); return []; }
		const path = isAbsolute(pattern) ? resolve(pattern) : resolve(base, pattern);
		const rel = relative(base, path), parts = rel.split(sep);
		if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
			|| parts.length > 8 || parts.slice(0, -1).some(p => !/^[A-Za-z0-9_.-]+$/.test(p) || /^(?:id_.*|keys?|private(?:-keys?)?)$/i.test(p))) {
			note("unsafe-path"); return [];
		}
		const name = basename(path);
		if (!/[?*]/.test(name)) {
			if (!allowedName(name)) { note("unsafe-path"); return []; }
			return [path];
		}
		if (!/^[A-Za-z0-9_.*?-]+\.conf$/.test(name) || /^id_/i.test(name) || /known_hosts/i.test(name)) {
			note("unsafe-path"); return [];
		}
		const dir = dirname(path);
		if (entries >= limits.directoryEntries) { note("directory-limit"); return []; }
		if (!await safe(dir)) return [];
		const matcher = new RegExp(`^${name.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
		const found: string[] = [];
		try {
			const directory = await opendir(dir);
			for await (const entry of directory) {
				if (++entries > limits.directoryEntries) { note("directory-limit"); break; }
				if (!matcher.test(entry.name)) continue;
				if (!allowedName(entry.name) || entry.isSymbolicLink()) { note("unsafe-path"); continue; }
				if (entry.isFile()) found.push(join(dir, entry.name));
			}
		} catch { note("config-unavailable"); }
		if (!found.length) note("config-unavailable");
		return found.sort();
	}
	// true means context is conditional OR unknown; it must never become global again.
	async function visit(path: string, depth: number, conditional: boolean): Promise<boolean> {
		if (depth > limits.depth) { note("depth-limit"); return true; }
		if (active.has(path)) { note("include-cycle"); return true; }
		if (files >= limits.files) { note("file-limit"); return true; }
		if (!allowedName(basename(path))) { note("unsafe-path"); return true; }
		files++;
		if (!await safe(path)) return true;
		let text: string;
		try {
			const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
			try {
				const st = await handle.stat();
				if (!st.isFile()) { note("unsafe-path"); return true; }
				const available = Math.min(limits.fileBytes, limits.totalBytes - bytes);
				if (st.size > available || available <= 0) { note("byte-limit"); return true; }
				const buffer = Buffer.alloc(available + 1);
				let used = 0;
				while (used < buffer.length) {
					const read = await handle.read(buffer, used, buffer.length - used, null);
					if (!read.bytesRead) break;
					used += read.bytesRead;
				}
				bytes += used;
				if (used > available) { note("byte-limit"); return true; }
				text = buffer.subarray(0, used).toString("utf8");
			} finally { await handle.close(); }
		} catch { note("config-unavailable"); return true; }
		active.add(path);
		try {
			for (const line of text.split(/\r?\n/)) {
				if (++lines > limits.lines) { note("line-limit"); return true; }
				// Normalize only the directive's optional '='; never touch argument bodies.
				const normalized = line.replace(/^(\s*[A-Za-z]+)\s*=\s*/, "$1 ");
				const words = tokens(normalized);
				if (!words) { note("unsupported-syntax"); conditional = true; continue; }
				const directive = words.shift()?.toLowerCase();
				if (directive === "host") {
					conditional = true;
					if (!words.length) note("alias-skipped");
					// Do not offer a positive token its own negation may exclude.
					// Host patterns match hostnames, not the user@host SSH destination.
					if (words.some(word => word.startsWith("!"))) { note("alias-skipped"); continue; }
					for (const word of words) {
						const destination = concreteDestination(word);
						if (!destination || /[*?!@]/.test(word)) { note("alias-skipped"); continue; }
						if (seen.has(destination)) continue;
						if (aliases.length >= limits.candidates) { note("candidate-limit"); break; }
						seen.add(destination); aliases.push(Object.freeze({ kind: "alias", destination }));
					}
				} else if (directive === "match") {
					conditional = true; note("unsupported-syntax");
				} else if (directive === "include") {
					if (conditional) { note("conditional-include"); continue; }
					if (!words.length) { note("unsupported-syntax"); conditional = true; }
					for (const pattern of words) {
						if (conditional) { note("conditional-include"); break; }
						const paths = await expand(pattern);
						if (!paths.length) conditional = true;
						for (const child of paths) {
							if (conditional) { note("conditional-include"); break; }
							conditional = await visit(child, depth + 1, conditional);
						}
					}
				}
			}
			return conditional;
		} finally { active.delete(path); }
	}
	await visit(config, 0, false);
	return finish();
}
