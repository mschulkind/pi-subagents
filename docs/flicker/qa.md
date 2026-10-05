# QA

`test/integration/fleet-selection-geometry.test.ts` launches a real-renderer child
without the integration shim, clears NODE_TEST_CONTEXT and asserts execution of
all 23 cases. It measures every above-before-below frame, not merely settled
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
