# Plan

Approved scope: Fleet/async ownership, mounted caches, bounded terminal detail,
regressions, and documentation. No Core, runner, configuration or deployment edits.

1. Snapshot dirty bytes/index. Use a HEAD-derived disposable candidate, never the
   mixed checkout, with a local .git sentinel to bound filesystem ancestor walks.
2. Replace the first-frame resize limitation with red first-frame invariants.
   Add actual styled composition and terminal/editor regressions before fixes.
3. Register a pure per-UI Fleet projection: visible lines and exact width/height
   coverage. Above and below consult the same projection. Stale structural
   snapshots fail open; no corrective render-time publication or filesystem work.
4. Bound short-screen detail, preserving overview, selection and Enter inspection.
   Cache per mounted instance, actual rows, available budget and invalidation.
5. Run isolated full gates. Land only owned paths with an isolated index; retain
   unrelated work, verify tested tree equality, and make one conventional commit.

Round-one review corrections stay in the same approved seam: prepare prioritized
descendant signals, put panes in the bounded roster instead of trimming the
finished frame, and bind unregister/cleanup to each mount rather than the TUI.
Reproduce each hypothesis red-first, rerun bounded-concurrency gates once, then
amend only the unpublished repair with ordinary hooks and isolated staging.
