# `moe.report_blocked` silently caps `reason` at 2000 chars — and rejects, it does not truncate

Hit 2026-08-09 on `task-9449ce65`. A measured, symbol-by-symbol block report is exactly the
output the board wants, and it is exactly the shape that blows the cap.

```
MCP error -32602: [INVALID_INPUT] Invalid reason: too long (5242 chars). Maximum 2000 characters allowed.
```

The limit is undocumented in the tool schema. The call **fails**, so the block is not
recorded — you have already spent the whole audit by the time you learn this, and if the
session dies there you leave a WORKING task with no block on the board.

## Do this instead

1. `moe.add_comment` with the full evidence FIRST. Comments have no comparable cap
   (a 5.2k-char comment was accepted without complaint).
2. Then `moe.report_blocked` with a compressed reason that **names the comment id**, e.g.
   "full symbol-by-symbol evidence in comment-81bfe196d1f2418588c44f66b705966c".

That ordering also survives a mid-sequence session death: the evidence is already durable
before the status transition is attempted.

## Trimming is worse than it sounds

Going 5242 → 2000 took five rejected attempts; the last one failed at **2002** chars. Budget
to ~1900 and stop, rather than shaving a sentence at a time. Nothing reports the length
until the call fails, so each attempt costs a round trip.

## Same family, different tools

`moe.qa_approve`'s `summary` has its own 2000-char cap
(`mem:gotcha-qa-summary-hard-capped-at-2000-chars`). `moe.complete_step`'s `note` does NOT
appear to share it — a ~3.6k-char step note was accepted on the same task. Do not assume the
cap is uniform across the API; assume it applies to any short "reason"/"summary" field and
put the real content in a comment.

## Related

`mem:gotcha-qa-summary-hard-capped-at-2000-chars`,
`mem:gotcha-report-blocked-does-not-overwrite-an-existing-blocked-reason`,
`mem:task-task-9449ce65fae544ef9809691ec079f599-handoff`.
