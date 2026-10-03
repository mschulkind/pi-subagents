import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	isolateOptionalExtensionHandlers,
	OPTIONAL_CHILD_EXTENSIONS_KEY,
	PI_SUBAGENTS_OPTIONAL_HOST,
	resolveOptionalChildExtensions,
	type OptionalChildExtensionEntry,
} from "../../src/shared/optional-child-extensions.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

type Root = Record<PropertyKey, unknown>;

function setRegistry(value: unknown): void {
	if (value === undefined) delete (globalThis as Root)[OPTIONAL_CHILD_EXTENSIONS_KEY];
	else (globalThis as Root)[OPTIONAL_CHILD_EXTENSIONS_KEY] = value;
}

function baseInput() {
	return { sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, cwd: process.cwd(), childAgentName: "worker", childIndex: 0, host: "parent" as const };
}

describe("optional child extension registry", () => {
	let dir: string;
	let observer: string;
	let other: string;
	let saved: unknown;

	beforeEach(() => {
		saved = (globalThis as Root)[OPTIONAL_CHILD_EXTENSIONS_KEY];
		setRegistry(undefined);
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-optional-ext-")));
		observer = path.join(dir, "observer.mjs");
		other = path.join(dir, "other.mjs");
		fs.writeFileSync(observer, "export default () => {};\n");
		fs.writeFileSync(other, "export default () => {};\n");
	});

	afterEach(() => {
		setRegistry(saved);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("uses the cross-package Symbol.for key", () => {
		assert.equal(OPTIONAL_CHILD_EXTENSIONS_KEY, Symbol.for("pi.optional-child-extensions.v1"));
		assert.equal(PI_SUBAGENTS_OPTIONAL_HOST, "pi-subagents");
	});

	it("changes nothing when no registry exists", () => {
		assert.deepEqual(resolveOptionalChildExtensions(PI_SUBAGENTS_OPTIONAL_HOST), { extensions: [], diagnostics: [] });
		const launch = buildInProcessChildLaunch(baseInput());
		assert.equal("optionalExtensions" in launch.session, false);
		assert.equal("optionalExtensionDiagnostics" in launch.session, false);
		// An empty Map is the same as no registry.
		setRegistry(new Map());
		const withEmpty = buildInProcessChildLaunch(baseInput());
		assert.deepEqual(Object.keys(withEmpty.session).sort(), Object.keys(launch.session).sort());
	});

	it("selects paths[host] over path, and skips entries that name only other hosts", () => {
		setRegistry(new Map<string, OptionalChildExtensionEntry>([
			["specific", { paths: { "pi-subagents": observer, "pi-dynamic-workflows": "/nonexistent/workflow.mjs" }, path: "/nonexistent/fallback.mjs" }],
			["elsewhere", { paths: { "pi-dynamic-workflows": other } }],
			["fallback", { paths: { "pi-dynamic-workflows": "/nonexistent/workflow.mjs" }, path: other }],
		]));
		const resolved = resolveOptionalChildExtensions(PI_SUBAGENTS_OPTIONAL_HOST);
		assert.deepEqual(resolved.extensions.map(({ id, path: p }) => [id, p]), [["specific", observer], ["fallback", other]]);
		assert.deepEqual(resolved.diagnostics, []);
	});

	it("fails open on malformed registries, entries and paths", () => {
		setRegistry({ not: "a map" });
		const notMap = resolveOptionalChildExtensions(PI_SUBAGENTS_OPTIONAL_HOST);
		assert.deepEqual(notMap.extensions, []);
		assert.match(notMap.diagnostics[0] ?? "", /not a Map/);

		const throwing = { get path(): string { throw new Error("getter exploded"); } };
		setRegistry(new Map<string, unknown>([
			["null", null],
			["number", { path: 42 }],
			["relative", { path: "relative/observer.mjs" }],
			["missing", { path: path.join(dir, "missing.mjs") }],
			["directory", { path: dir }],
			["throws", throwing],
			["good", { path: observer }],
		]));
		const resolved = resolveOptionalChildExtensions(PI_SUBAGENTS_OPTIONAL_HOST);
		assert.deepEqual(resolved.extensions.map(({ id }) => id), ["good"]);
		const text = resolved.diagnostics.join("\n");
		for (const pattern of [/'null'.*not an object/, /'number'.*non-empty string/, /'relative'.*not an absolute path/, /'missing'.*not a readable file/, /'directory'.*not a readable file/, /'throws'.*getter exploded/]) {
			assert.match(text, pattern);
		}
	});

	it("never throws on registries that resist being read, and keeps the healthy entries", () => {
		// A key String() cannot convert: one bad key must not hide the good entries.
		setRegistry(new Map<unknown, unknown>([[Object.create(null), { path: observer }], ["good", { path: other }]]));
		const nullKey = resolveOptionalChildExtensions(PI_SUBAGENTS_OPTIONAL_HOST);
		assert.deepEqual(nullKey.extensions.map(({ id, path: p }) => [id, p]), [["<unprintable key>", observer], ["good", other]]);

		// A Proxy registry whose getPrototypeOf trap throws defeats `instanceof Map`.
		setRegistry(new Proxy(new Map(), { getPrototypeOf() { throw new Error("prototype trap"); } }));
		const trapped = resolveOptionalChildExtensions(PI_SUBAGENTS_OPTIONAL_HOST);
		assert.deepEqual(trapped.extensions, []);
		assert.match(trapped.diagnostics[0] ?? "", /registry is unreadable: prototype trap/);

		// An entry getter that throws a value String() cannot convert.
		const nullThrower = { get path(): string { throw Object.create(null); } };
		setRegistry(new Map<string, unknown>([["null-throw", nullThrower], ["good", { path: other }]]));
		const thrown = resolveOptionalChildExtensions(PI_SUBAGENTS_OPTIONAL_HOST);
		assert.deepEqual(thrown.extensions.map(({ id }) => id), ["good"]);
		assert.match(thrown.diagnostics.join("\n"), /'null-throw' ignored: <unprintable error>/);

		// And a launch built on any of them still succeeds.
		setRegistry(new Proxy(new Map(), { getPrototypeOf() { throw Object.create(null); } }));
		const launch = buildInProcessChildLaunch(baseInput());
		assert.equal("optionalExtensions" in launch.session, false);
		assert.match(launch.session.optionalExtensionDiagnostics?.[0] ?? "", /registry is unreadable: <unprintable error>/);
	});

	it("deduplicates by realpath against loaded paths and earlier entries", () => {
		const link = path.join(dir, "link.mjs");
		fs.symlinkSync(observer, link);
		setRegistry(new Map<string, OptionalChildExtensionEntry>([
			["via-link", { path: link }],
			["direct", { path: observer }],
			["other", { path: other }],
		]));
		const fresh = resolveOptionalChildExtensions(PI_SUBAGENTS_OPTIONAL_HOST);
		assert.deepEqual(fresh.extensions.map(({ id, realPath }) => [id, realPath]), [["via-link", observer], ["other", other]]);
		assert.equal(fresh.extensions[0]?.path, link, "the loader imports the path the entry named");

		// Already loaded for the child, by a relative spec through the symlink: dropped.
		const loaded = resolveOptionalChildExtensions(PI_SUBAGENTS_OPTIONAL_HOST, ["builtin:mcp", "npm:some-package", "link.mjs"], dir);
		assert.deepEqual(loaded.extensions.map(({ id }) => id), ["other"]);
	});

	it("adds observers to foreground children after ceilings, denyExtensions and extensions: []", () => {
		setRegistry(new Map<string, OptionalChildExtensionEntry>([["observer", { path: observer }]]));
		const variants = [
			{},
			{ extensions: [] },
			{ capabilityCeiling: { version: 1 as const, denyExtensions: true, sources: ["plan-mode"] } },
			{ capabilityCeiling: { version: 1 as const, allowedTools: ["read"], denyExtensions: true, sources: ["plan-mode"] }, tools: ["read"] },
		];
		for (const variant of variants) {
			const launch = buildInProcessChildLaunch({ ...baseInput(), ...variant });
			assert.deepEqual(launch.session.optionalExtensions?.map(({ id, path: p }) => [id, p]), [["observer", observer]], JSON.stringify(variant));
			// Observers are not part of the launch contract or the configured extension set.
			assert.equal(launch.session.extensionPaths.includes(observer), false);
			assert.equal(JSON.stringify(launch.launchResolvedExtensions).includes(observer), false);
			assert.equal(JSON.stringify(launch.toolPlan).includes(observer), false);
		}
	});

	it("does not add an observer the agent already loads", () => {
		setRegistry(new Map<string, OptionalChildExtensionEntry>([["observer", { path: observer }]]));
		const launch = buildInProcessChildLaunch({ ...baseInput(), extensions: [observer] });
		assert.equal(launch.session.extensionPaths.includes(observer), true);
		assert.equal("optionalExtensions" in launch.session, false);
	});

	it("leaves detached runner and pane-native remote children alone", () => {
		setRegistry(new Map<string, OptionalChildExtensionEntry>([["observer", { path: observer }], ["missing", { path: path.join(dir, "missing.mjs") }]]));
		const runner = buildInProcessChildLaunch({ ...baseInput(), host: "runner" });
		assert.equal("optionalExtensions" in runner.session, false);
		assert.equal("optionalExtensionDiagnostics" in runner.session, false);
		const remote = buildInProcessChildLaunch({ ...baseInput(), machine: { provider: "herdr", machineId: "remote" } as never });
		assert.equal("optionalExtensions" in remote.session, false);
	});

	it("carries skip reasons to the session as diagnostics instead of failing the launch", () => {
		setRegistry(new Map<string, OptionalChildExtensionEntry>([["missing", { path: path.join(dir, "missing.mjs") }]]));
		const launch = buildInProcessChildLaunch(baseInput());
		assert.equal("optionalExtensions" in launch.session, false);
		assert.match(launch.session.optionalExtensionDiagnostics?.[0] ?? "", /'missing' not loaded/);
	});
});

describe("isolateOptionalExtensionHandlers", () => {
	it("reports throwing and rejecting handlers as returning nothing, and keeps successful results and shape", async () => {
		const reported: string[] = [];
		const handlers = new Map<string, Array<(...args: never[]) => unknown>>([
			["tool_call", [() => { throw new Error("sync boom"); }]],
			["message_end", [async () => { throw new Error("async boom"); }]],
			["context", [() => ({ messages: ["kept"] })]],
			["provider_stream_event", [() => undefined]],
		]);
		const extension = { path: "/x/observer.mjs", handlers };
		isolateOptionalExtensionHandlers(extension, (event, error) => reported.push(`${event}: ${error instanceof Error ? error.message : String(error)}`));
		assert.equal(extension.handlers.get("tool_call")![0]!(), undefined);
		const rejected = extension.handlers.get("message_end")![0]!();
		assert.ok(rejected instanceof Promise);
		assert.equal(await rejected, undefined);
		assert.deepEqual(extension.handlers.get("context")![0]!(), { messages: ["kept"] });
		assert.equal(extension.handlers.get("provider_stream_event")![0]!(), undefined, "a sync handler stays sync");
		assert.deepEqual(reported, ["tool_call: sync boom", "message_end: async boom"]);
	});
});
