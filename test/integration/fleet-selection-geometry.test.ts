import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import xterm from "@xterm/headless";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Editor, TuiAltScreen, TuiMainScreen, visibleWidth, type Component, type Terminal } from "@earendil-works/pi-tui";
import { FLEET_STATUS_WIDGET_KEY, SubagentFleetStatus } from "../../src/tui/fleet-status.ts";
import { renderWidget, setInlineWorkflowCoverage } from "../../src/tui/render.ts";
import { WIDGET_KEY, type AsyncJobState, type SubagentState } from "../../src/shared/types.ts";

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
		assert.match(output, /tests 23\b/, "the actual-renderer child must execute every regression");
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
		let now = 10_000;
		Date.now = () => now;
		let input: ((data: string) => void) | undefined;
		const writes: string[] = [];
		const emulator = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
		const terminal = {
			columns, rows, kittyProtocolActive: false,
			start(onInput: (data: string) => void) { input = onInput; }, stop() {}, async drainInput() {},
			write(data: string) { writes.push(data); emulator.write(data); }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
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
		screen.addChild({ render(width) { const lines = above.render(width); frames.push({ above: lines, below: [] }); return lines.length ? ["", ...lines] : [""]; }, invalidate() { above.invalidate(); } });
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
			async viewport() {
				await new Promise<void>((resolve) => emulator.write("", resolve));
				const buffer = emulator.buffer.active;
				return { lines: Array.from({ length: emulator.rows }, (_, n) => buffer.getLine(buffer.viewportY + n)?.translateToString(true) ?? ""),
					cursor: { x: buffer.cursorX, y: buffer.cursorY },
					scrollback: Array.from({ length: buffer.baseY }, (_, n) => buffer.getLine(n)?.translateToString(true) ?? "") };
			},
			start() { fleet.setContext(ctx); renderWidget(ctx, [...state.asyncJobs.values()]); screen.start(); return settle(); },
			update() { fleet.refresh(); renderWidget(ctx, [...state.asyncJobs.values()]); return settle(); },
			key(data: string) { assert.ok(input); input(data); return settle(); },
			resize(width: number, height = terminal.rows) { terminal.columns = width; terminal.rows = height; emulator.resize(width, height); screen.requestRender(); return settle(); },
			ctx, above, below, editor, tick(value: number) { now = value; screen.requestRender(); return settle(); }, settle, setExpanded(value: boolean) { expanded = value; }, finishInspector() { assert.ok(releaseInspector); releaseInspector(); },
			close() { fleet.dispose(); for (const component of mounted.values()) component.dispose?.(); screen.stop({ preserveScreen: true }); emulator.write("", () => emulator.dispose()); Date.now = originalNow; },
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
						assert.deepEqual([...new Set(heights)], [rows === 10 ? 3 : 10], JSON.stringify(heights));
						if (rows === 10) {
							h.key("\x1b[B"); h.key("\x1b[B");
							assert.match(h.frames.at(-1)!.below[1]!, /running/, "selected state must survive narrow compact rendering");
						}
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
				assert.equal(h.coverage.length, coverageStart, "rendering does not publish corrective coverage");
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
			assert.equal(topology.length, 1);
			assert.doesNotMatch(text(topology[0]!.above), /arriving-worker/);
			assert.match(text(topology.at(-1)!.below), /arriving-worker/);
			child.context = "fork";
			assert.doesNotMatch(text(h.update()[0]!.above), /attached-worker/);
			h.key("\x1b[B"); h.key("\x1b[B");
			const inspector = h.key("\r");
			assert.match(text(inspector[0]!.above), /attached-worker/);
			assert.equal(inspector[0]!.below.length, 0);
			await Promise.resolve(); h.finishInspector();
			await new Promise((resolve) => setImmediate(resolve)); const closed = h.settle();
			assert.equal(closed.length, 1);
			assert.doesNotMatch(text(closed[0]!.above), /attached-worker/);
			h.state.widgetsSuspended = true;
			assert.match(text(h.update()[0]!.above), /attached-worker/);
			h.state.widgetsSuspended = false; h.update();
			h.fleet.dispose(); h.screen.requestRender();
			assert.match(text(h.settle()[0]!.above), /attached-worker/);
			assert.equal(h.mounted.has(FLEET_STATUS_WIDGET_KEY), false);
		} finally { h.close(); }
	});

	for (const mode of ["regular", "fullscreen"] as const) {
		it(`${mode}: width handoff is correct in the first composed frame`, () => {
			const h = harness(mode, 120, 40);
			try {
				workflow(h); h.start();
				const narrow = h.resize(40);
				assert.equal(narrow.length, 1);
				assert.match(text(narrow[0]!.above), /attached-worker/);
				assert.doesNotMatch(text(narrow[0]!.above), /Workflow children shown in Fleet roster/);
				const wide = h.resize(120);
				assert.equal(wide.length, 1);
				assert.doesNotMatch(text(wide[0]!.above), /attached-worker/);
				assert.match(text(wide[0]!.below), /attached-worker/);
			} finally { h.close(); }
		});
		it(`${mode}: height-only resize bounds both panels and keeps input and inspector reachable`, async () => {
			const h = harness(mode, 80, 40);
			try {
				for (let n = 0; n < 8; n++) h.state.asyncJobs.set(`native-${n}`, job(`native-${n}`, `worker-${n}`));
				h.setExpanded(true); h.start(); h.key("\x1b[B"); h.key("\x1b[B");
				for (const rows of [10, 24, 8, 40, 10]) {
					const frames = h.resize(80, rows);
					assert.equal(frames.length, 1);
					const f = frames[0]!;
					assert.ok(f.above.length + f.below.length + 6 <= Math.max(rows, 10), JSON.stringify([rows, f.above.length, f.below.length]));
					if (rows <= 10) {
						assert.equal(f.below.length, 3);
						assert.match(text(f.below), /8/);
						assert.match(text(f.below), /worker-0/);
						assert.match(text(f.below), /inspect/);
					}
					if (rows === 10 && h.screen instanceof RegularScreen) {
						const state = h.screen.captureRenderState();
						assert.ok(state.hardwareCursorRow - state.previousViewportTop >= 0);
						assert.ok(state.hardwareCursorRow - state.previousViewportTop < rows);
					}
				}
				h.key("\r"); await Promise.resolve(); h.finishInspector();
				await new Promise((resolve) => setImmediate(resolve)); h.settle();
				h.key("\x1b"); h.key("typed"); assert.equal(h.editor.getText(), "typed");
			} finally { h.close(); }
		});
		it(`${mode}: covered membership, completion, scroll return and clock updates are single-frame`, () => {
			const h = harness(mode, 120, 80);
			try {
				const { owner, child } = workflow(h); h.start();
				for (const mutate of [
					() => owner.steps!.push({ workflowKey: "second", agent: "second-worker", status: "running" }),
					() => { child.context = "fork"; },
					() => { owner.steps![0]!.status = "complete"; },
					() => { h.state.asyncJobs.delete(child.asyncId); },
				]) {
					mutate(); const frames = h.update(); assert.equal(frames.length, 1);
					assert.doesNotMatch(text(frames[0]!.above), /script-worker|second-worker|attached-worker/);
				}
				for (let n = 0; n < 6; n++) h.state.asyncJobs.set(`later-${n}`, { ...job(`later-${n}`), startedAt: Date.now() + n + 10 });
				h.update(); for (let n = 0; n < 7; n++) assert.equal(h.key("\x1b[B").length, 1);
				for (let n = 0; n < 7; n++) assert.equal(h.key("\x1b[A").length, 1);
				assert.doesNotMatch(text(h.frames.at(-1)!.above), /second-worker/);
				const frames = h.tick(70_000); assert.equal(frames.length, 1);
			} finally { h.close(); }
		});
	}
	it("mounted async caches honor theme invalidation and separate UI geometry", () => {
		const a = harness("regular", 80, 40), b = harness("regular", 80, 10);
		try {
			for (const h of [a, b]) { for (let n = 0; n < 3; n++) h.state.asyncJobs.set(`job-${n}`, job(`job-${n}`)); h.start(); }
			const before = a.above.render(80);
			const oldFg = theme.fg; theme.fg = (_name, value) => `\x1b[35m${value}\x1b[39m`;
			try { a.above.invalidate(); assert.notDeepEqual(a.above.render(80), before); } finally { theme.fg = oldFg; }
			assert.ok(b.above.render(80).length <= 1);
			assert.ok(a.above.render(80).length > b.above.render(80).length);
		} finally { b.close(); a.close(); }
	});
	for (const mode of ["regular", "fullscreen"] as const) {
		it(`${mode}: actual ANSI preserves tiny-screen editor, selection and ordinary scrollback`, async () => {
			const h = harness(mode, 40, 10);
			try {
				for (let n = 0; n < 8; n++) h.state.asyncJobs.set(`job-${n}`, job(`job-${n}`, `worker-${n}`));
				h.start(); h.key("\x1b[B"); const initial = await h.viewport();
				h.writes.length = 0;
				for (const key of ["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[A"]) {
					assert.equal(h.key(key).length, 1);
					const view = await h.viewport();
					assert.match(text(view.lines), /8 jobs/);
					assert.match(text(view.lines), /worker-/);
					assert.match(text(view.lines), /inspect/);
					assert.match(text(view.lines), /FOOTER/);
					assert.ok(view.cursor.y >= 0 && view.cursor.y < 10);
					assert.match(view.lines[view.cursor.y]!, /^│|^─|^\s*$/);
					assert.deepEqual(view.scrollback, initial.scrollback);
				}
				assert.ok(h.writes.every((write) => !write.includes("\x1b[2J") && !write.includes("\x1b[3J")), "stable tiny-screen arrows must not clear screen or scrollback");
				h.key("\x1b"); h.key("input"); const typed = await h.viewport();
				assert.match(text(typed.lines), /input/); assert.equal(h.editor.getText(), "input");
			} finally { h.close(); }
		});
		it(`${mode}: actual ANSI width handoff removes duplicate detail in its first frame`, async () => {
			const h = harness(mode, 120, 40);
			try {
				workflow(h); h.start(); await h.viewport();
				assert.equal(h.resize(40).length, 1);
				const narrow = await h.viewport();
				assert.match(text(narrow.lines), /attached-worker/);
				assert.doesNotMatch(text(narrow.lines), /Workflow children shown in Fleet roster/);
				assert.equal(h.resize(120).length, 1);
				const wide = await h.viewport();
				assert.match(text(wide.lines), /Workflow children shown in Fleet roster/);
				assert.equal(text(wide.lines).match(/attached-worker/g)?.length, 1, "no stale child rows left above or below");
				assert.ok(wide.cursor.y >= 0 && wide.cursor.y < 40);
			} finally { h.close(); }
		});
	}

	it("current-frame measurement is pure, and update invalidates identical mounted component content", () => {
		const h = harness("regular", 120, 40);
		try {
			const { child } = workflow(h); h.start();
			const component = h.mounted.get(WIDGET_KEY)!;
			const before = component.render(120);
			const coverageCount = h.coverage.length;
			for (let n = 0; n < 4; n++) { assert.deepEqual(component.render(120), before); h.below.render(120); }
			assert.equal(h.screen.pending, false); assert.equal(h.coverage.length, coverageCount);
			child.context = "fork";
			renderWidget(h.ctx, [...h.state.asyncJobs.values()]);
			assert.equal(h.mounted.get(WIDGET_KEY), component);
			assert.notDeepEqual(component.render(120), before, "snapshot mismatch cannot reuse covered cached lines");
			assert.match(text(component.render(120)), /attached-worker/);
			h.fleet.refresh(); const settled = h.settle(); assert.equal(settled.length, 1);
			assert.doesNotMatch(text(settled[0]!.above), /attached-worker/);
		} finally { h.close(); }
	});
	it("late UI replacement and repeated disposal do not remove the new mounted projection or cache", () => {
		const h = harness("regular", 120, 40);
		try {
			workflow(h); h.start(); const old = h.mounted.get(WIDGET_KEY)!;
			const next = { ...h.ctx, ui: { ...h.ctx.ui } } as ExtensionContext;
			h.fleet.setContext(next); renderWidget(next, [...h.state.asyncJobs.values()]);
			assert.match(text(old.render(120)), /attached-worker/, "old UI fails open after unregister");
			old.dispose?.();
			const frames = h.settle(); assert.equal(frames.length, 1);
			assert.doesNotMatch(text(frames[0]!.above), /attached-worker/);
			const current = h.mounted.get(WIDGET_KEY);
			renderWidget(next, [...h.state.asyncJobs.values()]); assert.equal(h.mounted.get(WIDGET_KEY), current);
		} finally { h.close(); }
	});

	it("live usage crossing the styled width-fit boundary changes ownership in the same frame", () => {
		const h = harness("regular", 120, 40);
		try {
			const { child } = workflow(h);
			child.agents = ["long-attached-worker-identity-".repeat(3)];
			child.totalTokens = { total: 999 } as AsyncJobState["totalTokens"];
			h.start();
			let boundary = 0;
			for (let width = 40; width < 200; width++) {
				if (/Workflow children shown in Fleet roster/.test(text(h.above.render(width)))) { boundary = width; break; }
			}
			assert.ok(boundary);
			h.resize(boundary);
			child.totalTokens = { total: 1_000_000 } as AsyncJobState["totalTokens"];
			const frames = h.update(); assert.equal(frames.length, 1);
			assert.doesNotMatch(text(frames[0]!.above), /Workflow children shown in Fleet roster/);
			assert.match(text(frames[0]!.above), /long-attached-worker/);
		} finally { h.close(); }
	});

}
