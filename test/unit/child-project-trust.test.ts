import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { resolveChildProjectTrust } from "../../src/runs/shared/child-project-trust.ts";

test("child trust uses saved decisions before the global default and never prompts", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "child-trust-"));
	const agentDir = path.join(cwd, "agent");
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(path.join(cwd, ".pi", "mcp.json"), "{}");
	const loader = new pi.DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
	});
	try {
		await loader.reload();
		const result = loader.getExtensions();
		const settings = (defaultProjectTrust: pi.DefaultProjectTrust) =>
			pi.SettingsManager.inMemory({ defaultProjectTrust });
		const resolve = (defaultProjectTrust: pi.DefaultProjectTrust) =>
			resolveChildProjectTrust(
				pi,
				{ cwd },
				settings(defaultProjectTrust),
				agentDir,
				result,
			);
		assert.equal(await resolve("ask"), false);
		assert.equal(await resolve("never"), false);
		assert.equal(await resolve("always"), true);
		const store = new pi.ProjectTrustStore(agentDir);
		store.set(cwd, false);
		assert.equal(await resolve("always"), false);
		store.set(cwd, true);
		assert.equal(await resolve("never"), true);
		const decider = new pi.DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			extensionFactories: [
				(api) => {
					api.on("project_trust", (_event, ctx) => {
						assert.equal(ctx.hasUI, false);
						return { trusted: "no", remember: true };
					});
				},
			],
		});
		await decider.reload();
		assert.equal(
			await resolveChildProjectTrust(
				pi,
				{ cwd },
				settings("always"),
				agentDir,
				decider.getExtensions(),
			),
			false,
		);
		assert.equal(store.get(cwd), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
