# A refusal case can be answered by a LATER guard in the same function

Found on task-f6c9011b (3 instances in one task). The board's project rail 1
names this class; here is the concrete mechanism and how to detect it cheaply.

## Shape

A validator runs guards in sequence, all throwing the SAME stable code from the
SAME layer. A fixture written for guard #1 is often ALSO rejected by guard #3.
Delete guard #1 and the test stays green — it now measures guard #3.

Asserting code AND layer does not protect you. Both guards report
`RUNNER_SCOPE_STATUS_MALFORMED` / `GIT_OBSERVER`, so the assertion is maximally
specific and still detached. The rail's "which layer refused" clause only helps
when the guards live at DIFFERENT boundaries.

## Worked example

`parseRefListing` checks `!text.endsWith("\n")`, then `fields.length !== 4`.
Fixture `refs/heads/main\0<COMMIT>\0commit\0` (no LF). Remove the LF guard and
`text.slice(0, -1)` chops the trailing NUL instead of an LF, leaving 3 fields —
the field-count guard answers identically. The case is a duplicate of the
`truncated-field-count` case sitting two entries below it in the same table.

Same pattern with `{ fatal: true }` UTF-8 decoding: lenient decode turns the
fixture into 2 fields, and the field-count guard answers again.

## Detect it

Neuter one guard at a time and require the NAMED case to go red. Prefer
`if (false && <orig>)` as the anchor — no escaping, and `grep -c` gives you a
count to assert `== 1` BEFORE running. A perl substitution containing `\n`
inside shell single quotes silently matches a real newline and applies to
nothing; the run then "passes" and reads as a strong guard. **Always assert the
anchor count; a 0-count mutation run is evidence of nothing.** See
`mem:qa-mutation-drill-can-redden-for-wrong-reason` for the mirror failure.

## Design the fixture backwards

A fixture only pins guard N if it is ACCEPTED when guard N alone is removed.
For the LF guard that means a trailing junk byte (`...\0commit\0X`) — four
fields survive the chop, so nothing downstream objects.

## Restore hygiene in a shared worktree

Back up to `mktemp -d` OUTSIDE the repo (a foreign whole-tree hook cannot sweep
it), restore in a `trap ... EXIT`, then verify with sha256 AND an empty
`git diff --stat` on the path.
