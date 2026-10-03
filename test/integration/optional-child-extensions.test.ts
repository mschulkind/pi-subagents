/**
 * Optional child extensions against the real pi SDK: a registered observer is
 * loaded into a real foreground child session, sees its provider traffic, and
 * can never fail the child, whatever the capability ceiling says.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { createDefaultChildSessionFactory, type ChildSessionExtensionError, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { buildInProcessChildLaunch, type BuildInProcessChildLaunchInput } from "../../src/runs/shared/child-launch.ts";
import { OPTIONAL_CHILD_EXTENSIONS_KEY, type OptionalChildExtensionEntry } from "../../src/shared/optional-child-extensions.ts";

type Root = Record<PropertyKey, unknown>;
interface ObserverLog { loads: number; events: Array<{ event: string; sessionId?: string; role?: string }> }

const LOG_KEY = "pi-subagents-test.optional-observer-log";

/** A recorder like tok-stats' child entry: listens, never returns anything. */
const observerSource = `export default function (pi) {
	const log = globalThis[Symbol.for(${JSON.stringify(LOG_KEY)})];
	log.loads += 1;
	const record = (event) => (payload, ctx) => {
		log.events.push({ event, sessionId: ctx?.sessionManager?.getSessionId?.(), role: payload?.message?.role });
	};
	pi.on("session_start", record("session_start"));
	pi.on("before_agent_start", record("before_agent_start"));
	pi.on("message_end", record("message_end"));
}
`;

/** An observer whose every handler throws, including tool_call, which pi does not isolate. */
const throwingSource = `export default function (pi) {
	for (const event of ["session_start", "before_provider_request", "message_end", "tool_call", "tool_result"]) {
		pi.on(event, () => { throw new Error("observer " + event + " exploded"); });
	}
}
`;

describe("optional child extensions in a real foreground child", () => {
	let dir: string;
	let agentDir: string;
	let observer: string;
	let previousAgentDir: string | undefined;
	let savedRegistry: unknown;
	let log: ObserverLog;

	before(() => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	});
	after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	beforeEach(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-optional-child-")));
		agentDir = path.join(dir, "agent");
		fs.mkdirSync(agentDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		observer = path.join(dir, "observer.mjs");
		fs.writeFileSync(observer, observerSource);
		log = { loads: 0, events: [] };
		(globalThis as Root)[Symbol.for(LOG_KEY)] = log;
		savedRegistry = (globalThis as Root)[OPTIONAL_CHILD_EXTENSIONS_KEY];
		delete (globalThis as Root)[OPTIONAL_CHILD_EXTENSIONS_KEY];
	});

	afterEach(() => {
		if (savedRegistry === undefined) delete (globalThis as Root)[OPTIONAL_CHILD_EXTENSIONS_KEY];
		else (globalThis as Root)[OPTIONAL_CHILD_EXTENSIONS_KEY] = savedRegistry;
		delete (globalThis as Root)[Symbol.for(LOG_KEY)];
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function register(entries: Record<string, OptionalChildExtensionEntry>): void {
		(globalThis as Root)[OPTIONAL_CHILD_EXTENSIONS_KEY] = new Map(Object.entries(entries));
	}

	/** Build a foreground launch, run one prompt against a faux model, and report what happened. */
	async function runChild(overrides: Partial<BuildInProcessChildLaunchInput> = {}, responses = [fauxAssistantMessage("done")]) {
		const errors: ChildSessionExtensionError[] = [];
		let sessionId: string | undefined;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi as PiCodingAgentModule });
		const launch = buildInProcessChildLaunch({
			cwd: dir,
			host: "parent",
			sessionEnabled: false,
			childAgentName: "fixture",
			childIndex: 0,
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			...overrides,
		});
		const faux = fauxProvider({ provider: "optional-fixture", models: [{ id: "local" }], tokensPerSecond: 100000 });
		faux.setResponses(responses);
		launch.session.hooks.push({ name: "fixture-provider", factory(api) { api.registerProvider(faux.provider); } });
		launch.session.model = "optional-fixture/local";
		const child = await factory.create({ ...launch.session, onExtensionError: (error) => errors.push(error) });
		try {
			sessionId = child.sessionId;
			await child.prompt("Say done.");
			return { errors, sessionId, messages: [...child.messages], launch };
		} finally {
			await child.dispose();
			await factory.dispose();
		}
	}

	const errorText = (errors: ChildSessionExtensionError[]) => errors.map(({ extensionPath, event, error }) => `${extensionPath} ${event} ${error instanceof Error ? error.message : String(error)}`).join("\n");

	it("loads nothing extra when no registry exists", async () => {
		const { errors, messages } = await runChild();
		assert.equal(log.loads, 0);
		assert.equal(messages.at(-1)?.role, "assistant");
		assert.equal(errorText(errors).includes("optional"), false);
	});

	it("loads a registered observer into the child, which sees session_start before the child's prompt", async () => {
		register({ observer: { path: observer } });
		const { errors, sessionId } = await runChild();
		assert.equal(log.loads, 1);
		// The faux provider fires no provider hooks (before_provider_request), so the
		// prompt's own events stand in for the child's traffic here.
		const events = log.events.map(({ event }) => event);
		assert.deepEqual(events.slice(0, 2), ["session_start", "before_agent_start"]);
		assert.ok(log.events.some(({ event, role }) => event === "message_end" && role === "assistant"));
		assert.ok(log.events.every((entry) => entry.sessionId === sessionId), "every event is the child's own session");
		assert.equal(errors.length, 0, errorText(errors));
	});

	it("loads the observer under denyExtensions and extensions: [], and the child still runs", async () => {
		register({ observer: { path: observer } });
		for (const overrides of [
			{ capabilityCeiling: { version: 1 as const, denyExtensions: true, sources: ["plan-mode"] } },
			{ extensions: [] },
		]) {
			log.loads = 0;
			log.events = [];
			const { messages } = await runChild(overrides);
			assert.equal(log.loads, 1, JSON.stringify(overrides));
			assert.ok(log.events.some(({ event }) => event === "message_end"));
			assert.equal(messages.at(-1)?.role, "assistant");
		}
	});

	it("selects the pi-subagents path when the entry names one per host", async () => {
		const workflowOnly = path.join(dir, "workflow-observer.mjs");
		fs.writeFileSync(workflowOnly, "export default () => { throw new Error('wrong host'); };\n");
		register({ observer: { paths: { "pi-subagents": observer, "pi-dynamic-workflows": workflowOnly }, path: workflowOnly } });
		const { errors } = await runChild();
		assert.equal(log.loads, 1);
		assert.equal(errorText(errors).includes("wrong host"), false);
	});

	it("fails open when the registered file is missing or its factory throws", async () => {
		const broken = path.join(dir, "broken.mjs");
		fs.writeFileSync(broken, "export default () => { throw new Error('factory exploded'); };\n");
		register({ missing: { path: path.join(dir, "missing.mjs") }, broken: { path: broken }, observer: { path: observer } });
		const { errors, messages } = await runChild();
		assert.equal(messages.at(-1)?.role, "assistant", "the child completed");
		assert.equal(log.loads, 1, "a healthy observer still loads beside broken ones");
		const text = errorText(errors);
		assert.match(text, /'missing' not loaded/);
		assert.match(text, /broken\.mjs load optional child extension not loaded: .*factory exploded/);
	});

	it("isolates a throwing observer's handlers, including tool_call, so tools still run", async () => {
		const throwing = path.join(dir, "throwing.mjs");
		fs.writeFileSync(throwing, throwingSource);
		register({ throwing: { path: throwing } });
		const { errors, messages } = await runChild({ tools: ["ls"] }, [
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const toolResult = messages.find((message) => message.role === "toolResult") as { isError?: boolean } | undefined;
		assert.ok(toolResult, "the tool ran");
		assert.equal(toolResult.isError, false, "a throwing observer did not block the tool");
		assert.equal(messages.at(-1)?.role, "assistant");
		const text = errorText(errors);
		for (const event of ["session_start", "message_end", "tool_call", "tool_result"]) assert.match(text, new RegExp(`observer ${event} exploded`));
	});

	it("isolates handlers registered later through pi.on, and pi's off() still unsubscribes", async () => {
		// Registers late, from session_start: off() for an early handler, then a
		// throwing tool_call. Neither existed when the loader result was isolated.
		const late = path.join(dir, "late.mjs");
		fs.writeFileSync(late, `export default function (pi) {
	const log = globalThis[Symbol.for(${JSON.stringify(LOG_KEY)})];
	log.loads += 1;
	const off = pi.on("message_end", () => { log.events.push({ event: "unsubscribed message_end" }); });
	pi.on("session_start", () => {
		off();
		pi.on("tool_call", () => { throw new Error("late tool_call exploded"); });
		pi.on("message_end", () => { log.events.push({ event: "late message_end" }); });
	});
}
`);
		register({ late: { path: late } });
		const { errors, messages } = await runChild({ tools: ["ls"] }, [
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		assert.equal(log.loads, 1);
		const toolResult = messages.find((message) => message.role === "toolResult") as { isError?: boolean } | undefined;
		assert.ok(toolResult, "the tool ran");
		assert.equal(toolResult.isError, false, "a late throwing tool_call observer did not block the tool");
		assert.match(errorText(errors), /late\.mjs tool_call late tool_call exploded/);
		const events = log.events.map(({ event }) => event);
		assert.equal(events.includes("unsubscribed message_end"), false, "off() removed the handler");
		assert.ok(events.includes("late message_end"), "a late handler still fires");
	});

	it("loads an observer once when the agent already names it through a symlink", async () => {
		const link = path.join(dir, "observer-link.mjs");
		fs.symlinkSync(observer, link);
		register({ observer: { path: observer } });
		const { launch } = await runChild({ extensions: [link] });
		assert.equal(launch.session.optionalExtensions, undefined);
		assert.equal(log.loads, 1);
	});
});
