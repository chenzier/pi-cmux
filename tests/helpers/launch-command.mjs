import { readFileSync } from "node:fs";

/**
 * Long dispatch commands are sent as `/bin/sh '<script>'` so the cmux socket
 * request stays small (see lib/launch-command.ts). Tests assert the effective
 * command, not the transport wrapper.
 */
const SCRIPTED = /^\/bin\/sh '((?:[^']|'\\'')*)'$/;

export function effectiveCommand(value) {
	if (typeof value !== "string") return value;
	const match = SCRIPTED.exec(value);
	if (!match) return value;
	const path = match[1].replace(/'\\''/g, "'");
	return readFileSync(path, "utf8").replace(/\n$/, "");
}

/** Resolve a cmux argv array, replacing the value after `--command`. */
export function effectiveArgv(args) {
	const index = args.indexOf("--command");
	if (index < 0 || index === args.length - 1) return args;
	const copy = [...args];
	copy[index + 1] = effectiveCommand(copy[index + 1]);
	return copy;
}

/** Resolve the `initial_command` field of an RPC params object. */
export function effectiveInitialCommand(params) {
	return { ...params, initial_command: effectiveCommand(params.initial_command) };
}
