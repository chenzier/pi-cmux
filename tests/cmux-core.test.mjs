import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { buildPiCommand } from "../extensions/cmux-core.ts";

// Test the installed Pi parser, not a copy, so dependency updates exercise the CLI contract.
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { parseArgs } = await import(new URL("./cli/args.js", piEntry).href);

function captureLaunch(t, options) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cmux-command-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project's $HOME $(printf wrong) `printf wrong`; files");
	const bin = join(root, "bin");
	const capture = join(root, "capture.cjs");
	mkdirSync(cwd);
	mkdirSync(bin);
	writeFileSync(join(cwd, "glob.txt"), "");
	writeFileSync(capture, "process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n");
	writeFileSync(join(bin, "pi"), '#!/bin/sh\nexec "$CMUX_TEST_NODE" "$CMUX_TEST_CAPTURE" "$@"\n', { mode: 0o755 });

	// Run the actual generated shell command, but capture argv instead of starting Pi or cmux.
	const result = spawnSync("/bin/sh", ["-c", buildPiCommand(cwd, options)], {
		encoding: "utf8",
		timeout: 10_000,
		env: {
			...process.env,
			PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
			CMUX_TEST_NODE: process.execPath,
			CMUX_TEST_CAPTURE: capture,
		},
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	const captured = JSON.parse(result.stdout);
	assert.equal(captured.cwd, cwd);
	const parsed = parseArgs(captured.args);
	assert.deepEqual(parsed.diagnostics, []);
	assert.equal(parsed.unknownFlags.size, 0);
	return { args: captured.args, parsed };
}

test("launch without options stays fresh and uses Pi defaults", (t) => {
	const { args, parsed } = captureLaunch(t);
	assert.deepEqual(args, []);
	assert.deepEqual(parsed.messages, []);
	assert.equal(parsed.session, undefined);
	assert.equal(parsed.continue, undefined);
	assert.equal(parsed.resume, undefined);
	assert.equal(parsed.provider, undefined);
	assert.equal(parsed.model, undefined);
	assert.equal(parsed.thinking, undefined);
});

for (const prompt of ["", " \n\t "]) {
	test(`omit empty prompt ${JSON.stringify(prompt)}`, (t) => {
		const { args, parsed } = captureLaunch(t, { prompt });
		assert.deepEqual(args, []);
		assert.deepEqual(parsed.messages, []);
	});
}

for (const prompt of [
	"Review the auth flow",
	"--help",
	"--continue",
	"--model=unintended-model",
	"--",
	"- Review these points",
	"  First line\nSecond line  ",
	'Bob\'s "quoted" task: $HOME $(printf wrong) `printf wrong`; *.txt | cat > output',
]) {
	test(`preserve prompt ${JSON.stringify(prompt)}`, (t) => {
		const { args, parsed } = captureLaunch(t, { prompt });
		assert.deepEqual(args, ["--", prompt.trim()]);
		assert.deepEqual(parsed.messages, [prompt.trim()]);
		assert.deepEqual(parsed.fileArgs, []);
		assert.equal(parsed.help, undefined);
		assert.equal(parsed.continue, undefined);
		assert.equal(parsed.model, undefined);
	});
}

test("quote session and model settings before the prompt separator", (t) => {
	const options = {
		sessionFile: "/tmp/session's $HOME $(printf wrong).jsonl",
		provider: "provider's $(printf wrong)",
		model: 'model/with "quotes"; `printf wrong` *',
		thinking: "max",
		prompt: "--help",
	};
	const { args, parsed } = captureLaunch(t, options);
	assert.deepEqual(args, [
		"--session", options.sessionFile,
		"--provider", options.provider,
		"--model", options.model,
		"--thinking", options.thinking,
		"--", options.prompt,
	]);
	assert.equal(parsed.session, options.sessionFile);
	assert.equal(parsed.provider, options.provider);
	assert.equal(parsed.model, options.model);
	assert.equal(parsed.thinking, options.thinking);
	assert.deepEqual(parsed.messages, [options.prompt]);
	assert.equal(parsed.help, undefined);
});

for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
	test(`accept thinking level ${thinking} without a prompt`, (t) => {
		const { args, parsed } = captureLaunch(t, { thinking });
		assert.deepEqual(args, ["--thinking", thinking]);
		assert.equal(parsed.thinking, thinking);
		assert.deepEqual(parsed.messages, []);
	});
}

test("preserve provider/model and model:thinking shorthand", (t) => {
	const model = "openai/example:high";
	const { args, parsed } = captureLaunch(t, { model });
	assert.deepEqual(args, ["--model", model]);
	assert.equal(parsed.model, model);
	assert.equal(parsed.provider, undefined);
});

test("retain Pi's @file input behavior after the separator", (t) => {
	const { args, parsed } = captureLaunch(t, { prompt: "@prompt file.md" });
	assert.deepEqual(args, ["--", "@prompt file.md"]);
	assert.deepEqual(parsed.fileArgs, ["prompt file.md"]);
	assert.deepEqual(parsed.messages, []);
});
