# A DoD that enumerates N invariants can ship with one silently unrecorded

Found reviewing `task-667b1085` (control-room journey gate), 2026-08-10.
See `mem:task-task-667b1085b3e04915a88336c7424045a1-qa-verdict`.

## The shape

The DoD item read:

> "Truth, provenance, keyboard, narrow-window, **loading**, degraded, and latency
> invariants pass globally."

The deliverable asserted five of the seven and recorded **latency** as an explicit
typed UNKNOWN with cause and owner. `loading` appeared **nowhere** — no assertion, no
ledger entry, no mention in the completion evidence.

Nothing was red. Nothing was false. The artifact simply did not mention it, and an
omission reads exactly like coverage.

## Why it survives every habitual check

- The gate exits 0 and the test count is non-zero, so DoD 4 passes cleanly.
- The task's honesty artifact is *unusually good* — 17 typed UNKNOWNs, each with
  `missingInput` and `owner`, plus rot guards. Quality elsewhere buys trust here.
- One UNKNOWN **was** recorded (latency), which makes the record read as exhaustive:
  "they disclosed the gaps" is the conclusion, not "they disclosed *these* gaps".
- The ledger's own tests assert its arithmetic (20 = 3 + 17) — but the arithmetic is
  over the **scenario matrix**, a different list from the DoD's invariant list. A
  self-consistent artifact policing list A tells you nothing about list B.

## The check

**Count the nouns in the DoD sentence and match each one to a named assertion or a
named UNKNOWN record.** Seven nouns, five assertions, one record — the seventh is the
finding. Do this before running anything; it costs a minute and no gate will do it
for you.

Corollary, and it is how I confirmed this one was real rather than pedantic: when a
worker correctly diagnoses a **class** of defect (here `SURFACE_NOT_COMPOSED` — file
exists, nothing mounts it, so a browser can never reach it), enumerate the other
members of that class yourself. They found it for `cr.runs`/`cr.resources` and missed
`loading`, which has the same cause and the same one-line fix.

Related: `mem:gotcha-file-exists-but-is-composed-by-nothing`,
`mem:qa-generated-table-cannot-police-its-own-generator` (same family: an artifact
that validates itself over the wrong list).
