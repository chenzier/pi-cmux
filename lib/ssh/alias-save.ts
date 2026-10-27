import { constants, lstatSync, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, unlinkSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { t } from "../../extensions/i18n.ts";
import { dirname, isAbsolute, join, parse } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SshExecutionAdapter } from "./adapter.ts";
import { assertSshAction, strictFields, type SshActionAuthority } from "./connect.ts";

const MAX_CONFIG = 256 * 1024;
export interface AliasParameters { readonly alias: string; readonly hostname: string; readonly user?: string; readonly port?: number }
function fail(): never { throw new Error("SSH alias save refused: unsafe parameters, unsupported config or concurrent change. No automatic retry; inspect config locally."); }
export function validateAlias(value: unknown): AliasParameters {
	const v = strictFields(value, ["alias", "hostname", "user", "port"]);
	const name = (s: unknown, limit: number): s is string => typeof s === "string" && s.length <= limit && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s);
	if (!name(v.alias, 64) || !name(v.hostname, 253)) return fail();
	if (v.user !== undefined && (typeof v.user !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(v.user))) return fail();
	if (v.port !== undefined && (!Number.isSafeInteger(v.port) || (v.port as number) < 1 || (v.port as number) > 65535)) return fail();
	return Object.freeze({ alias: v.alias, hostname: v.hostname,
		...(v.user !== undefined ? { user: v.user as string } : {}), ...(v.port !== undefined ? { port: v.port as number } : {}) });
}
export function aliasAddition(value: AliasParameters): string {
	const p = validateAlias(value);
	return `\nHost ${p.alias}\n  HostName ${p.hostname}\n${p.user ? `  User ${p.user}\n` : ""}${p.port ? `  Port ${p.port}\n` : ""}`;
}
interface Snapshot { bytes: Buffer; identity?: string }
function identity(s: Stats): string {
	return [s.dev, s.ino, s.size, s.mode, s.uid, s.gid, s.nlink, s.mtimeMs, s.ctimeMs].join(":");
}
function safeFile(s: Stats): void {
	if (!s.isFile() || s.uid !== process.getuid?.() || s.nlink !== 1 || (s.mode & 0o022) || s.size > MAX_CONFIG) fail();
}
/** No path supplied by the model. Refuse symlinks in every existing parent.
 * Ancestors must be owned by this uid/root and not writable by others (root sticky tmp allowed). */
function safeDirectory(home: string): string {
	if (!isAbsolute(home) || home === parse(home).root) return fail();
	const directory = join(home, ".ssh");
	for (let path = directory; ; path = dirname(path)) {
		const s = lstatSync(path);
		if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== process.getuid?.() && s.uid !== 0)) fail();
		if ((s.mode & 0o022) && !(s.uid === 0 && (s.mode & 0o1000) && path !== directory && path !== home)) fail();
		if ((path === home || path === directory) && s.uid !== process.getuid?.()) fail();
		if (path === dirname(path)) break;
	}
	return directory;
}
function snapshot(path: string): Snapshot {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: Buffer.alloc(0) }; throw error; }
	try {
		const before = fstatSync(fd); safeFile(before);
		const bytes = Buffer.alloc(MAX_CONFIG + 1);
		// A bounded regular file read, never an unbounded readFile on a substituted FIFO/device.
		let total = 0;
		while (total < bytes.length) { const count = readSync(fd, bytes, total, bytes.length - total, null); if (!count) break; total += count; }
		const after = fstatSync(fd); safeFile(after);
		if (total > MAX_CONFIG || identity(before) !== identity(after) || total !== after.size) fail();
		const named = lstatSync(path);
		if (named.isSymbolicLink() || identity(named) !== identity(after)) fail();
		return { bytes: bytes.subarray(0, total), identity: identity(after) };
	} finally { closeSync(fd); }
}
function equal(a: Snapshot, b: Snapshot): boolean { return a.identity === b.identity && a.bytes.equals(b.bytes); }
/** Deliberately narrow grammar. Includes, Match, patterns/negations, continuations,
 * global options, quoting and unknown directives cannot be proved conflict-free here. */
function inspect(bytes: Buffer, p: AliasParameters): "existing" | "new" {
	const text = bytes.toString("utf8");
	if (!Buffer.from(text).equals(bytes) || /[^\x09\x0a\x0d\x20-\x7e]/.test(text) || /\r(?!\n)/.test(text)) return fail();
	const entries = new Map<string, Map<string, string>>();
	let current: Map<string, string> | undefined;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || /^\s*#/.test(line)) continue;
		const match = /^\s*([A-Za-z]+)\s+([^#"'\\]+?)(?:\s+#.*)?\s*$/.exec(line);
		if (!match) return fail();
		const key = match[1]!.toLowerCase(), value = match[2]!.trim();
		if (key === "host") {
			current = new Map();
			for (const host of value.split(/\s+/)) {
				if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(host) || entries.has(host.toLowerCase())) return fail();
				entries.set(host.toLowerCase(), current);
			}
		} else {
			if (!current || !["hostname", "user", "port", "identityfile", "identitiesonly", "forwardagent", "serveraliveinterval", "serveralivecountmax"].includes(key)
				|| current.has(key) || !/^[A-Za-z0-9_./~:@+-]+$/.test(value)) return fail();
			current.set(key, value);
		}
	}
	const old = entries.get(p.alias.toLowerCase());
	if (!old) return "new";
	if (old.get("hostname") !== p.hostname || old.get("user") !== p.user || old.get("port") !== (p.port === undefined ? undefined : String(p.port))) return fail();
	return "existing";
}
function append(directory: string, before: Snapshot, addition: Buffer, guard: () => void): void {
	const path = join(directory, "config"), lockPath = join(directory, ".pi-cmux-config.lock");
	let lock: number | undefined, fd: number | undefined, lockIdentity: { dev: number; ino: number } | undefined;
	try {
		guard();
		lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		lockIdentity = fstatSync(lock);
		if (!equal(before, snapshot(path))) fail();
		if (before.bytes.length + addition.length > MAX_CONFIG) fail();
		guard();
		fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK
			| (before.identity === undefined ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
		const opened = fstatSync(fd); safeFile(opened);
		if (before.identity !== undefined && identity(opened) !== before.identity) fail();
		if (before.identity !== undefined && !equal(before, snapshot(path))) fail();
		guard();
		// Exactly one append syscall, no truncate/rename, no write retry or rollback.
		if (writeSync(fd, addition) !== addition.length) throw new Error("uncertain write");
		fsyncSync(fd);
		const after = snapshot(path);
		if (!after.bytes.equals(Buffer.concat([before.bytes, addition])) || lstatSync(path).ino !== opened.ino) throw new Error("uncertain write");
	} catch {
		throw new Error("SSH alias was not safely saved or the write outcome is uncertain. Inspect ~/.ssh/config locally; do not retry automatically.");
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (lock !== undefined) {
			closeSync(lock);
			try { const named = lstatSync(lockPath); if (named.dev === lockIdentity?.dev && named.ino === lockIdentity?.ino) unlinkSync(lockPath); } catch { /* Never remove someone else's lock. */ }
		}
	}
}
export function createAliasSaver(adapter: SshExecutionAdapter, authority: SshActionAuthority, home: string = homedir()) {
	let busy = false;
	return async (value: unknown, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> => {
		const p = validateAlias(value);
		const guard = () => assertSshAction(adapter, authority, ctx, "alias-save", p, signal);
		guard();
		if (busy) throw new Error("An SSH alias save is already in progress");
		const finish = authority.begin?.(ctx, "alias-save", p);
		busy = true;
		try {
			const directory = safeDirectory(home), path = join(directory, "config"), before = snapshot(path);
			if (inspect(before.bytes, p) === "existing") return "SSH alias already exists; no save needed.";
			const addition = aliasAddition(p);
			if (!ctx.hasUI) throw new Error("Alias saving requires trusted interactive user confirmation");
			// Approval is obtained afresh from the real UI, NEVER a tool parameter or persisted flag.
			const approved = await ctx.ui.confirm(t("ssh.alias.confirm"), `Append exactly the following to ~/.ssh/config (including the leading newline):\n\n${addition}`, {
				signal: AbortSignal.any([...(signal ? [signal] : []), ...(ctx.signal ? [ctx.signal] : [])]),
			});
			guard();
			if (approved !== true) return "Alias not saved. An explicitly requested one-off SSH connection is still available.";
			if (safeDirectory(home) !== directory) fail();
			append(directory, before, Buffer.from(addition), guard);
			return "SSH alias saved. No connection was initiated.";
		} finally { busy = false; finish?.(); }
	};
}
const registered = new WeakSet<ExtensionAPI>();
/** Bundled separately gated action; registration performs no config I/O, connection or target binding. */
export function registerSshAliasSave(pi: ExtensionAPI, adapter: SshExecutionAdapter, authority: SshActionAuthority, home?: string): void {
	if (registered.has(pi)) return;
	registered.add(pi);
	const save = createAliasSaver(adapter, authority, home);
	pi.registerTool({
		name: "ssh_alias_save", label: "Save SSH alias",
		description: "Optional separate SSH alias save. Only when explicitly requested now. Trusted UI previews exact ~/.ssh/config addition and asks yes/no. Never supply approval or secrets as parameters. Existing aliases need no save prompt; declining never blocks one-off connection.",
		parameters: { type: "object", required: ["alias", "hostname"], additionalProperties: false,
			properties: { alias: { type: "string" }, hostname: { type: "string" }, user: { type: "string" }, port: { type: "integer" } } } as any,
		executionMode: "sequential",
		async execute(_id, parameters, signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: await save(parameters, ctx, signal) }], details: {} };
		},
	});
}
