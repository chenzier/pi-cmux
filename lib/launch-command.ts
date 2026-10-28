/**
 * Size-independent cmux launches.
 *
 * cmux 0.65.2 classifies socket requests by the first 4 KiB of the request
 * line. A long `initial_command` (or the duplicated `--command` of
 * `respawn-pane`) can push `"method"` past that window, and the server then
 * closes the socket without dispatching anything (manaflow-ai/cmux#21222,
 * fixed on main by #21345 but not in the stable 0.65.2 builds).
 *
 * Keeping every dispatch request small avoids the bug entirely: long commands
 * are written to a private script and the socket only carries `/bin/sh <path>`.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Kept local to avoid importing cmux-core, which imports this module.
function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Commands at or below this size stay inline; the rest go through a script. */
export const MAX_INLINE_COMMAND_BYTES = 1024;
/** Leftover scripts older than this are removed on the next launch. */
export const LAUNCH_SCRIPT_TTL_MS = 60 * 60 * 1000;
const SCRIPT_PREFIX = "launch-";

export interface PreparedLaunchCommand {
	/** The short command to send over the cmux socket. */
	command: string;
	/** Present only when the original command was written to a script. */
	scriptPath?: string;
	/** UTF-8 size of the command before preparation, for diagnostics. */
	originalBytes: number;
}

export function launchScriptDirectory(): string {
	return join(tmpdir(), "pi-cmux-launch");
}

function sweep(directory: string, now: number): void {
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(SCRIPT_PREFIX) || !entry.endsWith(".sh")) continue;
		const path = join(directory, entry);
		try {
			if (now - statSync(path).mtimeMs < LAUNCH_SCRIPT_TTL_MS) continue;
			rmSync(path, { force: true });
		} catch {
			// A launch may be reading it; leftover scripts are retried next time.
		}
	}
}

/**
 * Return a small command that runs the original one. Short commands are left
 * untouched so the common case keeps a single, inspectable dispatch request.
 */
export function prepareLaunchCommand(command: string, options: { now?: number } = {}): PreparedLaunchCommand {
	const originalBytes = Buffer.byteLength(command, "utf8");
	if (originalBytes <= MAX_INLINE_COMMAND_BYTES) return { command, originalBytes };
	const directory = launchScriptDirectory();
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	sweep(directory, options.now ?? Date.now());
	// `wx` refuses to reuse a name; the private directory keeps the script
	// readable only by this user.
	const scriptPath = join(directory, `${SCRIPT_PREFIX}${process.pid}-${randomUUID()}.sh`);
	writeFileSync(scriptPath, `${command}\n`, { mode: 0o600, flag: "wx" });
	// writeFileSync applies the mode on creation; assert it for umask edge cases.
	try { chmodSync(scriptPath, 0o600); } catch { /* best effort; creation mode already applied */ }
	return { command: `/bin/sh ${shellEscape(scriptPath)}`, scriptPath, originalBytes };
}
