import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	ASYNC_DIR,
	CHAIN_RUNS_DIR,
	RESULTS_DIR,
	TEMP_ARTIFACTS_DIR,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveTempScopeId,
} from "../../src/shared/types.ts";

describe("resolveTempScopeId", () => {
	it("prefers uid when available", () => {
		const scope = resolveTempScopeId({
			getuid: () => 501,
			env: { USER: "alice" },
			userInfo: () => ({ username: "alice" }),
		});
		assert.equal(scope, "uid-501");
	});

	it("falls back to environment usernames when uid is unavailable", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: { USERNAME: "Alice Example" },
			userInfo: () => ({ username: "ignored" }),
		});
		assert.equal(scope, "user-Alice-Example");
	});

	it("falls back to os.userInfo when environment is missing", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => ({ username: "svc_account" }),
		});
		assert.equal(scope, "user-svc_account");
	});

	it("falls back to home path when os.userInfo throws", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => {
				throw new Error("uv_os_get_passwd returned ENOENT");
			},
			homedir: () => "/home/12345/app user",
		});
		assert.equal(scope, "home-home-12345-app-user");
	});
});

// Fresh processes bypass the test preload's explicit root and exercise import-time defaults.
function readFreshRuntimePaths(env: NodeJS.ProcessEnv, cwd: string): { root: string; dirs: Record<string, string>; fallback: string; scope: string } {
	const moduleUrl = new URL("../../src/shared/types.ts", import.meta.url).href;
	const script = `
import * as os from "node:os";
import * as path from "node:path";
import { TEMP_ROOT_DIR, DIRS, resolveTempScopeId } from ${JSON.stringify(moduleUrl)};
process.env.PI_SUBAGENTS_TEMP_ROOT = "changed-after-import";
process.env.YOLO_DURABLE_DIR = "changed-after-import";
const again = await import(${JSON.stringify(moduleUrl)});
if (again.TEMP_ROOT_DIR !== TEMP_ROOT_DIR) throw new Error("root changed after import");
console.log(JSON.stringify({ root: TEMP_ROOT_DIR, dirs: DIRS, scope: resolveTempScopeId(), fallback: path.join(os.tmpdir(), "pi-subagents-" + resolveTempScopeId()) }));`;
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
		encoding: "utf-8", env, cwd,
	});
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim());
}

describe("import-time runtime root", () => {
	it("uses workspace-local durable jail storage across fresh processes and changed child cwd", () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-durable-root-"));
		try {
			const childCwd = path.join(fixture, "child-worktree");
			fs.mkdirSync(childCwd);
			const env = { ...process.env, PI_SUBAGENTS_TEMP_ROOT: "", YOLO_DURABLE_DIR: path.join(fixture, "workspace-a", ".yolo", "durable") };
			const first = readFreshRuntimePaths(env, fixture);
			const expected = path.join(env.YOLO_DURABLE_DIR, "pi-subagents", "jail", first.scope);
			assert.equal(first.root, expected);
			assert.deepEqual(first.dirs, {
				results: path.join(expected, "async-subagent-results"), async: path.join(expected, "async-subagent-runs"),
				chain: path.join(expected, "chain-runs"), artifacts: path.join(expected, "artifacts"),
			});
			// Only disposable terminal fixtures: persistence does not restart a runner.
			const statusPath = path.join(first.dirs.async, "terminal-fixture", "status.json");
			const receiptPath = path.join(first.dirs.chain, "terminal-fixture", "workflow-receipt.json");
			for (const file of [statusPath, receiptPath]) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, JSON.stringify({ runId: "terminal-fixture", state: "complete" }));
			}
			const restarted = readFreshRuntimePaths(env, childCwd);
			assert.deepEqual(restarted, first);
			for (const file of [statusPath, receiptPath]) assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).state, "complete");
			const other = readFreshRuntimePaths({ ...env, YOLO_DURABLE_DIR: path.join(fixture, "workspace-b", ".yolo", "durable") }, childCwd);
			assert.notEqual(other.root, first.root);
			assert.equal(other.root, path.join(fixture, "workspace-b", ".yolo", "durable", "pi-subagents", "jail", first.scope));
		} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
	});

	it("preserves explicit root precedence including relative overrides", () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-root-precedence-"));
		try {
			for (const override of [path.join(fixture, "explicit"), "relative root"]) {
				const result = readFreshRuntimePaths({ ...process.env, PI_SUBAGENTS_TEMP_ROOT: `  ${override}  `, YOLO_DURABLE_DIR: path.join(fixture, "durable") }, fixture);
				assert.equal(result.root, path.resolve(fixture, override));
			}
		} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
	});

	it("keeps the non-jail default when durable env is absent, blank or relative", () => {
		for (const durable of [undefined, "", "  ", "relative/durable"]) {
			const env = { ...process.env, PI_SUBAGENTS_TEMP_ROOT: "  " };
			delete env.YOLO_DURABLE_DIR;
			if (durable !== undefined) env.YOLO_DURABLE_DIR = durable;
			const result = readFreshRuntimePaths(env, os.tmpdir());
			assert.equal(result.root, result.fallback);
		}
	});
});

describe("shared temp paths", () => {
	it("uses the explicit temp root before shared paths resolve", () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-temp-override-"));
		const override = path.join(fixture, "async state");
		const isolatedHome = path.join(fixture, "home");
		try {
			const moduleUrl = new URL("../../src/shared/types.ts", import.meta.url).href;
			const script = `import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify({ ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR }));`;
			const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
				encoding: "utf-8",
				env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, PI_SUBAGENTS_TEMP_ROOT: override },
			});
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(JSON.parse(result.stdout.trim()), {
				ASYNC_DIR: path.join(override, "async-subagent-runs"),
				RESULTS_DIR: path.join(override, "async-subagent-results"),
				TEMP_ROOT_DIR: override,
			});
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("isolates agent-dir profile writes from an inherited PI_CODING_AGENT_DIR", () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-isolation-"));
		const tempRoot = path.join(fixture, "temp-root");
		const callerAgentDir = path.join(fixture, "caller-agent");
		try {
			const loaderUrl = new URL("../support/isolated-temp-root.mjs", import.meta.url).href;
			const profilesUrl = new URL("../../src/profiles/profiles.ts", import.meta.url).href;
			const utilsUrl = new URL("../../src/shared/utils.ts", import.meta.url).href;
			const script = `
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applySubagentProfile, getSubagentProfilesDir } from ${JSON.stringify(profilesUrl)};
import { getAgentDir } from ${JSON.stringify(utilsUrl)};

const profilesDir = getSubagentProfilesDir();
fs.mkdirSync(profilesDir, { recursive: true });
fs.writeFileSync(path.join(profilesDir, "isolated.json"), JSON.stringify({ subagents: { agentOverrides: { worker: { thinking: "high" } } } }));
const result = applySubagentProfile("isolated");
console.log(JSON.stringify({ agentDir: getAgentDir(), profilePath: path.join(profilesDir, "isolated.json"), settingsPath: result.settingsPath, tempDir: os.tmpdir(), testParentPid: process.env.PI_SUBAGENTS_TEST_PARENT_PID }));
`;
			const env = {
				...process.env,
				PI_CODING_AGENT_DIR: callerAgentDir,
				PI_SUBAGENTS_TEMP_ROOT: tempRoot,
			};
			delete env.PI_SUBAGENTS_TEST_LOADER;
			const result = spawnSync(process.execPath, [
				"--experimental-strip-types",
				"--import", loaderUrl,
				"--input-type=module",
				"--eval", script,
			], {
				cwd: process.cwd(),
				encoding: "utf-8",
				env,
			});
			assert.equal(result.status, 0, result.stderr);
			const output = JSON.parse(result.stdout.trim()) as { agentDir: string; profilePath: string; settingsPath: string; tempDir: string; testParentPid: string };
			const isolatedAgentDir = path.join(tempRoot, "home", ".pi", "agent");
			assert.equal(output.agentDir, isolatedAgentDir);
			assert.equal(output.profilePath, path.join(isolatedAgentDir, "profiles", "pi-subagents", "isolated.json"));
			assert.equal(output.settingsPath, path.join(isolatedAgentDir, "settings.json"));
			assert.equal(output.tempDir, tempRoot);
			assert.equal(output.testParentPid, String(result.pid));
			if (process.platform === "darwin") assert.equal(fs.existsSync(path.join(tempRoot, ".metadata_never_index")), true);
			assert.equal(fs.existsSync(output.profilePath), true);
			assert.equal(fs.existsSync(output.settingsPath), true);
			assert.equal(fs.existsSync(callerAgentDir), false);
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("records a nested test process as the runner parent", () => {
		const loaderUrl = new URL("../support/isolated-temp-root.mjs", import.meta.url).href;
		const result = spawnSync(process.execPath, [
			"--import", loaderUrl,
			"--input-type=module",
			"--eval", "console.log(process.env.PI_SUBAGENTS_TEST_PARENT_PID)",
		], {
			encoding: "utf-8",
			env: { ...process.env, PI_SUBAGENTS_TEST_LOADER: "loaded", PI_SUBAGENTS_TEST_PARENT_PID: String(process.pid) },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), String(result.pid));
	});

	it("anchors shared temp directories under one scoped root", () => {
		assert.equal(path.dirname(RESULTS_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(ASYNC_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(CHAIN_RUNS_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(TEMP_ARTIFACTS_DIR), TEMP_ROOT_DIR);
		assert.match(path.basename(TEMP_ROOT_DIR), /^pi-subagents-/);
		assert.equal(path.basename(RESULTS_DIR), "async-subagent-results");
		assert.equal(path.basename(ASYNC_DIR), "async-subagent-runs");
		assert.equal(path.basename(CHAIN_RUNS_DIR), "chain-runs");
		assert.equal(path.basename(TEMP_ARTIFACTS_DIR), "artifacts");
	});

	it("stops a test runner before consuming config when its test parent is gone", () => {
		const configPath = path.join(os.tmpdir(), "orphan-check.json");
		fs.writeFileSync(configPath, "{}", "utf-8");
		try {
			const result = spawnSync(process.execPath, [
				"--experimental-strip-types",
				"--import", new URL("../support/register-loader.mjs", import.meta.url).href,
				fileURLToPath(new URL("../../src/runs/background/subagent-runner-bootstrap.ts", import.meta.url)),
				configPath,
			], {
				env: { ...process.env, PI_SUBAGENTS_TEST_PARENT_PID: "2147483647" },
				encoding: "utf-8",
				timeout: 10_000,
			});
			assert.equal(result.status, 1, result.stderr);
			assert.equal(fs.existsSync(configPath), true);
		} finally {
			fs.rmSync(configPath, { force: true });
		}
	});

	it("writes async config files under the same scoped temp root", () => {
		assert.equal(path.dirname(getAsyncConfigPath("abc123")), TEMP_ROOT_DIR);
		assert.equal(path.basename(getAsyncConfigPath("abc123")), "async-cfg-abc123.json");
	});
});
