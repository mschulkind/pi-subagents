# Research

The async widget renders above the editor before Fleet below it. Publishing
workflow coverage from Fleet.render therefore changes the *next* frame, not the
one already composed. Width changes reproduced `(above, below)` heights
`(3,7), (6,7)` narrowing and `(6,7), (3,7)` widening. Workflow lane insertion and
inspector close reproduced `(16,10), (11,10)`. Selection alone was already stable.

At 20×10, a ten-line Fleet displaced input. Async used process.stdout geometry
rather than the injected terminal, and Container.invalidate did not clear its
closed-over themed lines. These are extension seams, not demonstrated Core bugs.
Core legitimately clears regular-mode scrollback on resize and inaccessible
above-viewport changes; those policies are unchanged.

Read Pi's complete installed extensions.md/tui.md and this project's VISION.md.
No public API exposes remaining height after other extensions or multiline input.

Independent round-one review identified three hypotheses. Real-renderer red tests
confirmed all three in both modes: descendant urgency vanished at 40×10; eight
natives crowded out project panes and pane selection changed height; repeated
old Fleet disposal after inspector handback unregistered the replacement.
