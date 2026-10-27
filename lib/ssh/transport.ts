import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseSshTarget, type SshTarget } from "./target.ts";

export type SshFailureKind = "connection" | "spawn" | "cancelled" | "timeout" | "output-limit" | "input-limit" | "callback";
export class SshTransportError extends Error {
	readonly kind: SshFailureKind;
	readonly uncertain: boolean;
	constructor(kind: SshFailureKind, uncertain: boolean) {
		super(`SSH ${kind === "connection" ? "connection/authentication failed (exit 255)" : kind + " failure"}`
			+ (uncertain ? "; remote effects may have occurred; do not automatically retry" : "; not dispatched"));
		this.name = "SshTransportError"; this.kind = kind; this.uncertain = uncertain;
	}
}
export interface SshRequest {
	readonly target: SshTarget;
	/** Trusted adapter-generated bash program; user commands are deliberately executable shell text. */
	readonly script: string;
	readonly input?: Buffer;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly capture?: boolean;
	readonly onData?: (data: Buffer) => void;
	/** Synchronous authority check immediately before spawn, input and streamed callbacks. */
	readonly assertCurrent: () => void;
}
export interface SshResult { readonly exitCode: number; readonly stdout: Buffer; readonly stderr: Buffer }
export interface SshTransport { run(request: SshRequest): Promise<SshResult> }
export type SshSpawn = (file: string, args: string[], options: {
	shell: false; stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv;
}) => ChildProcessWithoutNullStreams;

export const SSH_MAX_INPUT = 32 * 1024 * 1024;
export const SSH_MAX_OUTPUT = 16 * 1024 * 1024;
export const SSH_DEFAULT_DEADLINE_MS = 60_000;
export const SSH_MAX_DEADLINE_MS = 600_000;
export function shellQuote(value: string): string {
	if (typeof value !== "string" || value.includes("\0")) throw new Error("SSH shell text contains NUL or is invalid");
	return "'" + value.replaceAll("'", "'\\''") + "'";
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid SSH resource limit");
	return Math.min(value, maximum);
}
/** Only these local values are available to ssh/config helpers, never copied into a remote command. */
function sshEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SSH_ASKPASS_REQUIRE: "never" };
	for (const key of ["HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "TMPDIR", "SYSTEMROOT"]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	return env;
}
export function sshArgv(target: SshTarget, script: string): string[] {
	const parsed = parseSshTarget(target); // Reject leading-dash destinations even for direct transport callers.
	if (Buffer.byteLength(script) > 128 * 1024) throw new Error("SSH command is too large");
	const remoteCommand = `cd ${shellQuote(parsed.remoteCwd)} && BASH_ENV= ENV= exec /bin/bash --noprofile --norc -c ${shellQuote(script)}`;
	return ["-T", "-oBatchMode=yes", "-oNumberOfPasswordPrompts=0", "-oPasswordAuthentication=no",
		"-oKbdInteractiveAuthentication=no", "-oStrictHostKeyChecking=yes", "-oConnectionAttempts=1",
		"-oConnectTimeout=10", "-oServerAliveInterval=15", "-oServerAliveCountMax=2",
		"-oClearAllForwardings=yes", "-oForwardAgent=no", "-oForwardX11=no", "-oPermitLocalCommand=no",
		"-oControlMaster=no", "-oControlPath=none", "-oRemoteCommand=none", "-oEscapeChar=none",
		"-oSendEnv=-*", "--", parsed.destination, remoteCommand];
}

/** One spawn per request. No retry, fallback, startup connection or local shell. */
export class OpenSshTransport implements SshTransport {
	private readonly spawnProcess: SshSpawn;
	constructor(spawnProcess: SshSpawn = spawn as SshSpawn) { this.spawnProcess = spawnProcess; }
	async run(request: SshRequest): Promise<SshResult> {
		const args = sshArgv(request.target, request.script);
		const timeout = bounded(request.timeoutMs, SSH_DEFAULT_DEADLINE_MS, SSH_MAX_DEADLINE_MS);
		const maxOutput = bounded(request.maxOutputBytes, SSH_MAX_OUTPUT, SSH_MAX_OUTPUT);
		if (request.input && request.input.length > SSH_MAX_INPUT) throw new SshTransportError("input-limit", false);
		request.assertCurrent();
		if (request.signal?.aborted) throw new SshTransportError(request.signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled", false);
		return new Promise((resolve, reject) => {
			let child: ChildProcessWithoutNullStreams;
			let settled = false, spawned = false, total = 0, offset = 0;
			const stdout: Buffer[] = [], stderr: Buffer[] = [];
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				request.signal?.removeEventListener("abort", abort);
			};
			const stop = (kind: SshFailureKind) => {
				if (settled) return;
				settled = true; cleanup();
				if (child) {
					child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
					child.kill("SIGTERM");
					// A bounded local escalation, NOT confirmation of remote process death.
					const killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 250);
					killTimer.unref();
					child.once("close", () => clearTimeout(killTimer));
				}
				reject(new SshTransportError(kind, spawned));
			};
			const abort = () => stop(request.signal?.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
			const current = () => {
				if (settled) return false;
				if (request.signal?.aborted) { abort(); return false; }
				try { request.assertCurrent(); return true; }
				catch { stop("cancelled"); return false; }
			};
			try {
				request.assertCurrent(); // No await between this check and the effect.
				child = this.spawnProcess("/usr/bin/ssh", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: sshEnvironment() });
				spawned = true;
			} catch { stop("spawn"); return; }
			request.signal?.addEventListener("abort", abort, { once: true });
			const data = (chunks: Buffer[], value: Buffer) => {
				if (!current()) return;
				total += value.length;
				if (total > maxOutput) { stop("output-limit"); return; }
				if (request.capture !== false) chunks.push(Buffer.from(value));
				try { request.onData?.(value); } catch { stop("callback"); }
			};
			child.stdout.on("data", (value: Buffer) => data(stdout, value));
			child.stderr.on("data", (value: Buffer) => data(stderr, value));
			// Keep error listeners after settlement: a late EPIPE must not escape as an unhandled event.
			child.on("error", () => stop("spawn"));
			child.stdout.on("error", () => stop("connection"));
			child.stderr.on("error", () => stop("connection"));
			// EPIPE alone is not definitive: wait for close to preserve an authentication/remote exit status.
			let inputFailed = false;
			child.stdin.on("error", () => { inputFailed = true; });
			child.on("close", (code, signal) => {
				if (!current()) return;
				if (code === 255 || code === null || signal || (inputFailed && code === 0)) { stop("connection"); return; }
				settled = true; cleanup();
				resolve({ exitCode: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
			});
			timer = setTimeout(() => stop("timeout"), timeout);
			// Send content on stdin in bounded chunks, respecting stream backpressure. Never in argv.
			const pump = () => {
				if (!current() || child.stdin.destroyed) return;
				const input = request.input;
				try {
					while (input && offset < input.length) {
						if (!current()) return;
						const end = Math.min(offset + 64 * 1024, input.length);
						const chunk = input.subarray(offset, end); offset = end;
						if (!child.stdin.write(chunk)) { child.stdin.once("drain", pump); return; }
					}
					if (current()) child.stdin.end();
				} catch { stop("connection"); }
			};
			pump(); // Also observes an abort that raced listener installation.
		});
	}
}
