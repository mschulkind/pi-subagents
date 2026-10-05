# Implementation

Fleet prepares roster snapshots during refresh. Its pure projection computes
visible lines and complete workflow coverage with the existing styled row
width checks. A per-UI registration lets async query that projection before it
renders. Below uses the same calculation; rendering does not publish ownership
or request corrective frames. Instance-safe unregister prevents stale disposal
from removing a replacement. Structural mismatches retain async child detail.

At ten terminal rows, detailed Fleet becomes three lines: counts, selected state
and identity, and inspection/navigation hint. Async uses a one-line overview.
Larger terminals progressively restore rows. The six-row reserve accounts for a
three-line editor, above spacer, footer and transcript row in the tested fixture;
it is not a guarantee about other extensions or multiline input. Existing Enter
inspection retains full details. Extremely short/narrow terminals can still clip
content; navigation and inspection remain available.

Async layout state is instance-local. Cache dependencies include actual terminal
rows and shared available rows; invalidate clears themed output and layout state.
Mounted updates still invalidate content without replacing the widget key.

Reviewer corrections: compact summaries prepare prioritized failed/blocked/paused,
attention and queued signals from full descendants/checklists, not just wrappers.
Materialized/native representations and repeated wrapper outcomes are deduplicated;
separate urgent states retain separate labels. Normal-height project panes share
the bounded roster body and overflow count, with a persistent pane/attention notice
in the header. Selection never triggers short-screen replacement. Each Fleet
mount captures its own unregister closure; late old disposal cannot clear a new
mount sharing the same TUI.

Urgency also leads the actual inactive/default compact Fleet and progressive
async header, within their existing row counts. Default 40×10 tests verify
clipped failed/attention/queued signals, pane attention aggregation, input and
unchanged three-above/one-below heights after urgency clears.
