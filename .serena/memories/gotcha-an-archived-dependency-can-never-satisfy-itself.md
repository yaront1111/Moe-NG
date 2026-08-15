# An ARCHIVED dependency can never satisfy itself — blocking on it waits forever

Found 2026-08-10 planning task-667b1085 (Control-room journey gate), whose hard dependency
task-779d6804 (Graph operator journeys) is **ARCHIVED, never built**.

## Why this is not an ordinary block

The usual block calculus is "wait for the producer." It assumes the producer can still act.
An ARCHIVED task has no owner, is not in any claim pool, and nothing on the board will ever
move it — so the condition that would clear the block has no path to becoming true. Same
structural shape as the "permanent dead end by construction" a governor named on
task-10cab3e5, where the remedy task was specified but never created.

Blocking is the *reflexively safe* answer and the wrong one. It reads as diligence and
produces an item that sits forever.

## What to do instead

Check the dependency's **status**, not just its existence, before deciding to wait:

```bash
python -c "import json;d=json.load(open('.moe/tasks/<id>.json'));print(d['title'],'|',d['status'])"
```

- `WORKING` / `PLANNING` → a real wait; block if the surface is genuinely absent.
- `DONE` → re-measure; the block may already be stale in the "gap claimed present,
  actually closed" direction.
- `ARCHIVED` / nonexistent → **do not wait.** Cover what exists, record the rest as typed
  UNKNOWN naming the dead owner, and say in the completion evidence that the owner is
  archived so a governor knows it must be revived or re-created.

## The record has to be able to rot loudly

A typed UNKNOWN naming an archived owner will outlive the gap it describes unless it can
fail. Pair it with an assertion that the gap is *still open* — e.g. that the five missing
`cr.graph.*` ids still resolve to zero production files. The day someone ships one, the
gate goes red and demands the record be updated, instead of the UNKNOWN quietly becoming
false.

Also assert that every case marked COVERED resolves to a real file on disk. That single
assertion is what makes narrowing a gate into a false pass structurally impossible rather
than merely discouraged.

## The neighbouring trap

Covering the missing half against a placeholder is worse than not covering it. Clause 2
calls a proof that only proves the shapes "worse than no proof" because it **retires** the
scenario while certifying nothing. Never create a stub carrying a real production id to
give a sweep something to find.

Related: `mem:gotcha-clean-vs-head-plus-fresh-mtime-means-live-committer` (the opposite
error — waiting is right, but on a live writer, not a dead one).
