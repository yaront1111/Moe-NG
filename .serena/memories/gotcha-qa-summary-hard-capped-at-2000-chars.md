# `moe.qa_approve` summary is hard-capped at 2000 characters

`moe_qa_approve` rejects with `MCP error -32602: [INVALID_INPUT] Invalid summary: too long
(max 2000 chars)` and the call does NOT land. I burned four round-trips shaving a long evidence
summary down by eye before it fit. `moe.qa_reject` takes its detail in `reason` plus a structured
`issues[]` array, so the same squeeze does not bite there.

## What to do instead

Write the FULL evidence — command output, per-mutant red test names, the DoD-to-code map, any
judgment calls — into the Serena memory `task-<id>-qa-verdict`, which has no such limit. Then make
the `qa_approve` summary a ~1800-character index of it: gate results with counts, diff shape and
per-file line counts, drill score, one line per DoD item. The board keeps the verdict; the memory
keeps the proof.

If a summary is over budget, cut the PROSE, not the evidence. Dropping "verified independently,
not from step notes" costs a reader nothing; dropping the failing test name a mutant produced
destroys the only thing that makes the approval checkable.

Budget by feel before sending: roughly 25 lines of dense text is the ceiling. There is no
truncation and no warning — it is refuse-or-accept.
