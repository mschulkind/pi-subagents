# QA

`test/integration/fleet-selection-geometry.test.ts` launches a real-renderer child
without the integration shim, clears NODE_TEST_CONTEXT and asserts execution of
all 31 cases. It measures every above-before-below frame, not merely settled
output. Cases cover regular/default shrink, clear-on-shrink, fullscreen, narrow
and short terminals, width/height-only resize, scroll return, topology/completion,
inspector/suspend/disposal, clocks, context mismatch, repeated measurement, theme
invalidation and UI replacement. Permanent ANSI cases feed real TUI output into
[@xterm/headless](https://github.com/xtermjs/xterm.js) 5.5.0 (dev-only, MIT; its npm
package retains upstream license notices), also used by Core's tests. They check
viewport text, input cursor, removed duplicate child rows and stable scrollback.

Run `npm run test:unit`, `npm run test:integration`, `npm run typecheck`, and
`npm run build:pkg` with worktree/import overrides unset and disposable short
TMPDIR/HOME. Candidate-local .git bounds Orca's non-git ancestor walk. Expected
red/green output and preservation audits live under
`/workspace/.yolo/durable/subagents-flicker/implementation/`.

This is not full InteractiveMode bootstrap, physical-terminal/provider testing,
or proof against every terminal repaint. Core's legitimate resize clears remain.
Human publication/package update/restart is required; no rcup/pack apply is used.

Round-two regressions cover 40×10 descendant failure/queued/attention visibility
above and below (plus actual ANSI viewport), native/materialized failure dedup,
80×40 eight-native/two-pane navigation with constant height, correct overflow,
selected pane summary and no clears, and repeated old Fleet disposal after
inspector remount on the same TUI. Round-two red/green and final gates are
archived under `implementation/round2/` at the same durable evidence root.

Urgency also leads the actual inactive/default compact Fleet and progressive
async header, within their existing row counts. Default 40×10 tests verify
clipped failed/attention/queued signals, pane attention aggregation, input and
unchanged three-above/one-below heights after urgency clears.

The compact queued unit regression now asserts urgent-first ordering at width
50 and retained usage at width 100, rather than requiring lower-priority usage
to fit after the added waiting signal at width 50.
