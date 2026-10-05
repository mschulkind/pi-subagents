import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { makeAgent } from "../support/helpers.ts";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import {
	installAsyncExecutionHooks, available, isAsyncAvailable, executeAsyncSingle,
	tempDir, readAsyncPayload,
} from "../support/async-execution-fixture.ts";

describe("detached runner runtime root", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();
	it("propagates the resolved absolute root to a real runner with a different cwd", { skip: !isAsyncAvailable() ? "runner not available" : undefined }, async () => {
		const cwd = path.join(tempDir, "child-cwd");
		fs.mkdirSync(cwd, { recursive: true });
		const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
		// Simulate a later env change / relative launch override: the parent already resolved its root.
		process.env.PI_SUBAGENTS_TEMP_ROOT = "relative-runtime-root";
		const id = `runtime-root-${Date.now().toString(36)}`;
		try {
			const launch = executeAsyncSingle!(id, {
				agent: "external", task: "Report runner environment",
				agentConfig: makeAgent("external", {
					runner: { type: "external-cli", command: process.execPath, args: ["-e", "console.log(JSON.stringify({root:process.env.PI_SUBAGENTS_TEMP_ROOT,cwd:process.cwd()}))"] },
				} as never),
				ctx: { pi: { events: { emit() {} } }, cwd, currentSessionId: "runtime-root-session" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
			});
			assert.equal(launch.isError, undefined, launch.content[0]?.text);
			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, true, payload.error);
			const reported = JSON.parse(payload.results[0]?.output?.trim() ?? "{}");
			assert.equal(reported.root, TEMP_ROOT_DIR);
			assert.equal(path.isAbsolute(reported.root), true);
			assert.equal(reported.cwd, cwd);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
			else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
		}
	});
});
