import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	LAUNCH_SCRIPT_TTL_MS,
	MAX_INLINE_COMMAND_BYTES,
	launchScriptDirectory,
	prepareLaunchCommand,
} from "../lib/launch-command.ts";

function withTmpRoot(t, prefix = "pi-cmux-launch-test-") {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = root;
	t.after(() => {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

test("short commands stay inline and create no files", (t) => {
	const root = withTmpRoot(t);
	const command = "cd '/tmp' && exec pi -- 'hello'";
	const prepared = prepareLaunchCommand(command);
	assert.deepEqual(prepared, { command, originalBytes: Buffer.byteLength(command) });
	assert.equal(existsSync(join(root, "pi-cmux-launch")), false);
});

test("a command at the inline limit stays inline, one byte over goes to a script", (t) => {
	withTmpRoot(t);
	const exact = "x".repeat(MAX_INLINE_COMMAND_BYTES);
	assert.equal(prepareLaunchCommand(exact).scriptPath, undefined);
	const over = "x".repeat(MAX_INLINE_COMMAND_BYTES + 1);
	const prepared = prepareLaunchCommand(over);
	assert.ok(prepared.scriptPath);
	assert.notEqual(prepared.command, over);
});

test("long commands become a short /bin/sh command backed by a 0600 script", (t) => {
	const root = withTmpRoot(t);
	const command = `cd '/tmp' && exec pi -- '${"prompt ".repeat(400)}'`;
	const prepared = prepareLaunchCommand(command);
	assert.match(prepared.command, /^\/bin\/sh '/);
	assert.ok(prepared.command.length < 160, `dispatch command is short: ${prepared.command.length}`);
	assert.equal(prepared.originalBytes, Buffer.byteLength(command));
	assert.ok(prepared.scriptPath?.startsWith(join(root, "pi-cmux-launch")));
	assert.equal(statSync(prepared.scriptPath).mode & 0o777, 0o600);
	assert.equal(readFileSync(prepared.scriptPath, "utf8"), `${command}\n`);
	assert.equal(statSync(join(root, "pi-cmux-launch")).mode & 0o777, 0o700);
});

test("the dispatched command really runs, including paths with spaces and quotes", (t) => {
	const root = withTmpRoot(t, "pi-cmux launch test ");
	const marker = join(root, "ran marker.txt");
	const command = `printf '%s' "it's fine" > ${`'${marker}'`}`;
	const prepared = prepareLaunchCommand(`${command} # ${"pad ".repeat(400)}`);
	assert.ok(prepared.scriptPath);
	execFileSync("/bin/sh", ["-c", prepared.command], { stdio: "pipe" });
	assert.equal(readFileSync(marker, "utf8"), "it's fine");
});

test("each long launch gets its own script and stale scripts are swept", (t) => {
	const root = withTmpRoot(t);
	const first = prepareLaunchCommand(`echo one # ${"a".repeat(2000)}`);
	const second = prepareLaunchCommand(`echo two # ${"b".repeat(2000)}`);
	assert.notEqual(first.scriptPath, second.scriptPath);
	assert.equal(readFileSync(first.scriptPath, "utf8").startsWith("echo one"), true);
	assert.equal(readFileSync(second.scriptPath, "utf8").startsWith("echo two"), true);

	const directory = launchScriptDirectory();
	const stale = join(directory, "launch-stale.sh");
	writeFileSync(stale, "echo stale\n", { mode: 0o600 });
	const old = (Date.now() - LAUNCH_SCRIPT_TTL_MS - 1000) / 1000;
	utimesSync(stale, old, old);
	const fresh = join(directory, "launch-fresh.sh");
	writeFileSync(fresh, "echo fresh\n", { mode: 0o600 });
	chmodSync(fresh, 0o600);
	// Unrelated files in the directory are never touched.
	const unrelated = join(directory, "notes.txt");
	writeFileSync(unrelated, "keep\n");

	prepareLaunchCommand(`echo three # ${"c".repeat(2000)}`);
	assert.equal(existsSync(stale), false, "stale script is swept");
	assert.equal(existsSync(fresh), true, "recent script is kept");
	assert.equal(existsSync(unrelated), true, "unrelated files are kept");
});

test("size accounting matches the socket payload that used to fail", (t) => {
	withTmpRoot(t);
	// 5 KB command: the observed failure size for cmux 0.65.2 dispatches.
	const command = `exec pi -- '${"x".repeat(5000)}'`;
	const prepared = prepareLaunchCommand(command);
	assert.ok(prepared.command.length < 200);
	assert.ok(prepared.originalBytes > 5000);
	// respawn-pane duplicates the command, so the inline form would exceed 4 KiB.
	const inline = `/bin/sh -c '${command.replace(/'/g, `'\\''`)}'`;
	assert.ok(Buffer.byteLength(inline, "utf8") * 2 > 4096, "inline dispatch would cross the 4 KiB window");
});
