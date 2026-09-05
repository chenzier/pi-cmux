import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sidebarSourcePath = join(projectRoot, "extensions", "cmux-sidebar.ts");

async function createSidebarRuntime() {
	const source = await readFile(sidebarSourcePath, "utf8");
	const runtime = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: sidebarSourcePath,
	}).outputText;
	const runtimePath = join(projectRoot, "extensions", `cmux-sidebar.test-${randomUUID()}.mjs`);
	await writeFile(runtimePath, runtime);
	return runtimePath;
}

async function runSidebar(environment) {
	const runtimePath = await createSidebarRuntime();
	const outputDirectory = await mkdtemp(join(tmpdir(), "pi-cmux-sidebar-test-"));
	const outputPath = join(outputDirectory, "commands.json");
	const childProgram = `
		import sidebar from ${JSON.stringify(pathToFileURL(runtimePath).href)};
		import { writeFileSync } from "node:fs";
		const handlers = new Map();
		const commands = [];
		sidebar({
			on(event, handler) { handlers.set(event, handler); },
			async exec(command, args) {
				commands.push({ command, args });
				return { killed: false, code: 0, stdout: "", stderr: "" };
			},
		});
		await handlers.get("agent_start")({}, { sessionManager: { getBranch: () => [] } });
		await handlers.get("agent_end")({ messages: [] });
		process.on("beforeExit", () => writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ pid: process.pid, commands })));
	`;

	try {
		await execFile(process.execPath, ["--input-type=module", "--eval", childProgram], {
			env: {
				...process.env,
				CMUX_WORKSPACE_ID: "workspace-1",
				PI_CMUX_SIDEBAR_FINAL_CLEAR_MS: "20",
				...environment,
			},
		});
		return JSON.parse(await readFile(outputPath, "utf8"));
	} finally {
		await rm(runtimePath, { force: true });
		await rm(outputDirectory, { recursive: true, force: true });
	}
}

function setStatusCommand(commands) {
	return commands.filter(({ command }) => command === "cmux")
		.map(({ args }) => args)
		.find((args) => args[0] === "set-status");
}

test("sidebar statuses are owned by their cmux panel and Pi process", async () => {
	const { pid, commands } = await runSidebar({ CMUX_SURFACE_ID: "surface-1" });
	const setStatus = setStatusCommand(commands);

	assert.ok(setStatus, "expected a cmux set-status command");
	assert.deepEqual(setStatus.slice(-4), ["--panel", "surface-1", "--pid", String(pid)]);
});

test("sidebar statuses use panel identity when surface identity is unavailable", async () => {
	const { pid, commands } = await runSidebar({
		CMUX_SURFACE_ID: "",
		CMUX_PANEL_ID: "panel-1",
		CMUX_TAB_ID: "workspace-1",
	});
	const setStatus = setStatusCommand(commands);

	assert.ok(setStatus, "expected a cmux set-status command");
	assert.deepEqual(setStatus.slice(-4), ["--panel", "panel-1", "--pid", String(pid)]);
});
