import assert from "node:assert/strict";
import test from "node:test";
import { openMixedWorkflow, readMixedWorkflows, releaseMixedWorkflows } from "../../src/tui/mixed-workflows.ts";

const slot = Symbol.for("pi.mixed-work.fleet.v1");

test("mixed roster rejects stale sessions and unsafe rows without acknowledging or invoking the owner", async () => {
	const opened: string[] = [];
	const entry = {
		version: 1, sessionId: "session-a", accepted: false,
		rows: [{ id: "run-1", name: "Audit", status: "running", phase: "Scan", done: 1, total: 2, startedAt: 1000 }],
		open: async (id: string) => { opened.push(id); },
	};
	(globalThis as Record<symbol, unknown>)[slot] = entry;
	try {
		assert.deepEqual(readMixedWorkflows("session-b"), []);
		assert.equal(entry.accepted, false);
		assert.equal(await openMixedWorkflow("session-a", "run-1"), false);
		entry.rows[0]!.name = "unsafe\nlabel";
		assert.deepEqual(readMixedWorkflows("session-a"), []);
		assert.equal(entry.accepted, false);
		entry.rows[0]!.name = "Audit";
		assert.equal(readMixedWorkflows("session-a").length, 1);
		assert.equal(entry.accepted, true);
		entry.rows[0]!.name = "unsafe\nlabel";
		assert.deepEqual(readMixedWorkflows("session-a"), []);
		assert.equal(entry.accepted, false, "a rejected update restores the standalone panel");
		entry.rows[0]!.name = "Audit";
		assert.equal(readMixedWorkflows("session-a").length, 1);
		assert.equal(await openMixedWorkflow("session-a", "not-run-1"), false);
		assert.equal(await openMixedWorkflow("session-a", "run-1"), true);
		assert.deepEqual(opened, ["run-1"]);
		releaseMixedWorkflows("session-b");
		assert.equal(entry.accepted, true);
		releaseMixedWorkflows("session-a");
		assert.equal(entry.accepted, false);
	} finally {
		delete (globalThis as Record<symbol, unknown>)[slot];
	}
});
