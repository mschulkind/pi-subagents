import assert from "node:assert/strict";
import test from "node:test";
import { resolveMcpDirectToolResolution } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";

test("native MCP selectors need no adapter cache and preserve the native namespace", () => {
	assert.deepEqual(resolveMcpDirectToolResolution(["demo/ping"]), {
		selections: [{ name: "mcp__demo__ping", selector: "demo/ping" }],
		unresolvedSelectors: [],
	});
});

test("whole-server selections are explicit and invalid native server names fail closed", () => {
	assert.deepEqual(
		resolveMcpDirectToolResolution([
			"demo",
			"bad.server/ping",
			"demo/ping/extra",
		]),
		{
			selections: [{ name: "mcp__demo__*", selector: "demo" }],
			unresolvedSelectors: ["bad.server/ping", "demo/ping/extra"],
		},
	);
});
