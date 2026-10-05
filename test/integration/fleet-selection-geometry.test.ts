import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Editor, TuiAltScreen, TuiMainScreen, visibleWidth, type Component, type Terminal } from "@earendil-works/pi-tui";
import { FLEET_STATUS_WIDGET_KEY, SubagentFleetStatus } from "../../src/tui/fleet-status.ts";
import { renderWidget, setInlineWorkflowCoverage } from "../../src/tui/render.ts";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";

// The integration loader substitutes render.ts's TUI components. Re-execute
// without that loader so these composition regressions exercise real components.
if (!process.env.PI_SUBAGENTS_REAL_GEOMETRY_TEST) {
	it("runs Fleet selection geometry with the actual TUI renderer", (t) => {
		const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENTS_REAL_GEOMETRY_TEST: "1" };
		// Node suppresses nested --test discovery when this marker is inherited.
		delete env.NODE_TEST_CONTEXT;
		const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", fileURLToPath(new URL("../support/isolated-temp-root.mjs", import.meta.url)), "--test", fileURLToPath(import.meta.url)], {
			env, stdio: "pipe", encoding: "utf8",
		});
		assert.match(output, /tests 10\b/, "the actual-renderer child must execute every regression");
		t.diagnostic(output.trim());
	});
} else {
	class RegularScreen extends TuiMainScreen {
		pending = false;
		requestRender() { this.pending = true; }
		flush() { this.pending = false; this.doRender(); }
	}
	class Fullscreen extends TuiAltScreen {
		pending = false;
		requestRender() { this.pending = true; }
		flush() { this.pending = false; this.doRender(); }
	}
	const theme = { fg: (_name: string, text: string) => `\x1b[36m${text}\x1b[39m`, bg: (_name: string, text: string) => text, bold: (text: string) => text };
	type Frame = { above: string[]; below: string[] };
	function harness(mode: "regular" | "fullscreen" = "regular", columns = 80, rows = 24, clear = false, maxAgentRows = 6) {
		const originalNow = Date.now;
		Date.now = () => 10_000;
		let input: ((data: string) => void) | undefined;
		const writes: string[] = [];
		const terminal = {
			columns, rows, kittyProtocolActive: false,
			start(onInput: (data: string) => void) { input = onInput; }, stop() {}, async drainInput() {},
			write(data: string) { writes.push(data); }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
			clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		} satisfies Terminal;
		const screen = mode === "regular" ? new RegularScreen(terminal) : new Fullscreen(terminal);
		screen.setClearOnShrink(clear);
		const editor = new Editor(screen, { borderColor: (s: string) => s, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } });
		const above = new Container(), below = new Container();
		const mounted = new Map<string, Component & { dispose?(): void }>();
		const frames: Frame[] = [];
		const coverage: string[][] = [];
		const state = { currentSessionId: "geometry-test", asyncJobs: new Map(), foregroundControls: new Map() } as unknown as SubagentState;
		screen.addChild({ render: () => Array.from({ length: 30 }, (_, n) => `transcript-${n}`), invalidate() {} });
		screen.addChild({ render(width) { const lines = above.render(width); frames.push({ above: lines, below: [] }); return lines; }, invalidate() { above.invalidate(); } });
		screen.addChild(editor);
		screen.addChild({ render(width) { const lines = below.render(width); frames.at(-1)!.below = lines; return lines; }, invalidate() { below.invalidate(); } });
		screen.addChild({ render: () => ["FOOTER"], invalidate() {} });
		screen.setFocus(editor);
		let expanded = false;
		const ctx = { hasUI: true, ui: { theme, getToolsExpanded: () => expanded, getEditorText: () => editor.getText(), notify() {},
			onTerminalInput: (handler: Parameters<RegularScreen["addInputListener"]>[0]) => screen.addInputListener(handler),
			setWidget(key: string, factory: ((tui: typeof screen, factoryTheme: typeof theme) => Component) | undefined, options?: { placement?: string }) {
				const previous = mounted.get(key);
				if (previous) { previous.dispose?.(); above.removeChild(previous); below.removeChild(previous); mounted.delete(key); }
				if (factory) { const component = factory(screen, theme); mounted.set(key, component); (options?.placement === "belowEditor" ? below : above).addChild(component); }
				screen.requestRender();
			},
		} } as unknown as ExtensionContext;
		let releaseInspector: (() => void) | undefined;
		const fleet = new SubagentFleetStatus(state, () => new Promise<void>((resolve) => { releaseInspector = resolve; }), {
			refreshMs: 60_000, detailMode: "detailed", maxAgentRows,
			onWorkflowCoverageChange(ui, value) { coverage.push([...value.keys()]); setInlineWorkflowCoverage(ui, value); },
		});
		function settle() {
			const start = frames.length;
			for (let n = 0; screen.pending && n < 8; n++) screen.flush();
			assert.equal(screen.pending, false, "coverage repaint must converge");
			return frames.slice(start);
		}
		return { state, terminal, screen, fleet, mounted, frames, coverage, writes,
			start() { fleet.setContext(ctx); renderWidget(ctx, [...state.asyncJobs.values()]); screen.start(); return settle(); },
			update() { fleet.refresh(); renderWidget(ctx, [...state.asyncJobs.values()]); return settle(); },
			key(data: string) { assert.ok(input); input(data); return settle(); },
			resize(width: number) { terminal.columns = width; screen.requestRender(); return settle(); },
			settle, setExpanded(value: boolean) { expanded = value; }, finishInspector() { assert.ok(releaseInspector); releaseInspector(); },
			close() { fleet.dispose(); for (const component of mounted.values()) component.dispose?.(); screen.stop({ preserveScreen: true }); Date.now = originalNow; },
		};
	}
	function job(id: string, agent = id): AsyncJobState {
		return { asyncId: id, asyncDir: "/tmp/inert-geometry", mode: "single", status: "running", agents: [agent], startedAt: Date.now() };
	}
	function workflow(h: ReturnType<typeof harness>) {
		const owner = { ...job("workflow"), mode: "workflow" as const, steps: [{ workflowKey: "script-lane", agent: "script-worker", status: "running" as const }] };
		const child = { ...job("child", "attached-worker"), parentWorkflowRunId: owner.asyncId };
		h.state.asyncJobs.set(owner.asyncId, owner); h.state.asyncJobs.set(child.asyncId, child);
		return { owner, child };
	}
	const text = (lines: string[]) => lines.join("\n");
	for (const mode of ["regular", "fullscreen"] as const) {
		for (const [columns, rows] of [[80, 24], [20, 10]]) {
			for (const clear of mode === "regular" ? [false, true] : [false]) {
				it(`${mode} ${columns}x${rows} clear=${clear}: native Down/Up keeps one overflow row`, () => {
					const h = harness(mode, columns, rows, clear);
					try {
						for (let n = 0; n < 8; n++) h.state.asyncJobs.set(`native-${n}`, job(`native-${n}`, `worker-${n}`));
						h.start(); h.key("\x1b[B");
						const initialState = h.screen instanceof RegularScreen ? h.screen.captureRenderState() : undefined;
						const redraws = h.screen.fullRedraws;
						h.writes.length = 0;
						const heights: number[] = [];
						for (let n = 0; n < 8; n++) for (const frame of h.key("\x1b[B")) heights.push(frame.below.length);
						for (let n = 0; n < 8; n++) for (const frame of h.key("\x1b[A")) heights.push(frame.below.length);
						assert.ok(heights.length >= 16);
						assert.deepEqual([...new Set(heights)], [10], JSON.stringify(heights));
						assert.ok(h.frames.every((frame) => [...frame.above, ...frame.below].every((line) => visibleWidth(line) <= columns)));
						if (columns === 80 && h.screen instanceof RegularScreen) {
							const finalState = h.screen.captureRenderState();
							assert.equal(finalState.hardwareCursorRow, initialState!.hardwareCursorRow);
							assert.equal(finalState.previousViewportTop, initialState!.previousViewportTop);
							assert.equal(finalState.maxLinesRendered, initialState!.maxLinesRendered);
							assert.equal(h.screen.fullRedraws, redraws);
							assert.ok(h.writes.every((write) => !write.includes("\x1b[3J") && !write.includes("\x1b[2J")), "arrows must preserve scrollback and avoid clearing renders");
						}
					} finally { h.close(); }
				});
			}
		}
		it(`${mode}: unchanged workflow ownership never expands the actual above-first frame`, () => {
			const h = harness(mode, 120, 40);
			try {
				workflow(h); h.start();
				const initial = h.frames.at(-1)!;
				assert.match(text(initial.above), /Workflow children shown in Fleet roster/);
				assert.match(text(initial.below), /script-worker/);
				assert.match(text(initial.below), /attached-worker/);
				const coverageStart = h.coverage.length;
				for (const key of ["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[A", "\x1b[A", "\x1b[A"]) {
					const frames = h.key(key);
					for (const frame of frames) {
						assert.equal(frame.above.length, initial.above.length, "above renders before Fleet, not after settling");
						assert.doesNotMatch(text(frame.above), /script-worker|attached-worker/);
						assert.match(text(frame.below), /script-worker/);
						assert.match(text(frame.below), /attached-worker/);
					}
					assert.equal(frames.length, 1, "selection must not schedule a corrective coverage frame");
				}
				assert.ok(h.coverage.slice(coverageStart).every((ids) => ids.includes("workflow")));
			} finally { h.close(); }
		});
	}
	it("real ownership changes restore script and materialized detail; inspector and teardown release coverage", async () => {
		const h = harness("regular", 120, 80, false, 6);
		try {
			h.setExpanded(true);
			const { owner, child } = workflow(h);
			for (let n = 0; n < 5; n++) h.state.asyncJobs.set(`later-${n}`, { ...job(`later-${n}`), startedAt: Date.now() + 10 + n });
			h.start();
			for (let n = 0; n < 5; n++) h.key("\x1b[B");
			const scrolled = h.key("\x1b[B");
			assert.ok(scrolled.every((frame) => /attached-worker/.test(text(frame.above))), "scroll revokes coverage before composing above");
			for (let n = 0; n < 6; n++) h.key("\x1b[A");
			owner.steps!.push({ workflowKey: "arrival", agent: "arriving-worker", status: "running" });
			const topology = h.update();
			assert.match(text(topology[0]!.above), /arriving-worker/);
			assert.match(text(topology.at(-1)!.below), /arriving-worker/);
			child.context = "fork";
			assert.match(text(h.update()[0]!.above), /attached-worker/);
			h.key("\x1b[B"); h.key("\x1b[B");
			const inspector = h.key("\r");
			assert.match(text(inspector[0]!.above), /attached-worker/);
			assert.equal(inspector[0]!.below.length, 0);
			await Promise.resolve(); h.finishInspector();
			await new Promise((resolve) => setImmediate(resolve)); h.settle();
			h.state.widgetsSuspended = true;
			assert.match(text(h.update()[0]!.above), /attached-worker/);
			h.state.widgetsSuspended = false; h.update();
			h.fleet.dispose(); h.screen.requestRender();
			assert.match(text(h.settle()[0]!.above), /attached-worker/);
			assert.equal(h.mounted.has(FLEET_STATUS_WIDGET_KEY), false);
		} finally { h.close(); }
	});
	it("width changes expose the known first-frame handoff limitation but converge without losing children", () => {
		const h = harness("regular", 120, 40);
		try {
			workflow(h); h.start();
			const narrow = h.resize(40);
			assert.doesNotMatch(text(narrow[0]!.above), /attached-worker/, "previous coverage survives until the below widget observes width");
			assert.ok(narrow.length > 1, "width must request a corrective frame");
			assert.match(text(narrow.at(-1)!.above), /attached-worker/);
			assert.doesNotMatch(text(narrow.at(-1)!.above), /Workflow children shown in Fleet roster/);
			const wide = h.resize(120);
			assert.match(text(wide[0]!.above), /attached-worker/);
			assert.match(text(wide.at(-1)!.below), /attached-worker/);
			assert.match(text(wide.at(-1)!.above), /Workflow children shown in Fleet roster/);
		} finally { h.close(); }
	});
}
