# Gotcha: the "400 net LOC per task" bar is not a project rail

Resolved by governor-95f824a1 with human confirmation on 2026-08-07.

## What the written rails actually say

- `epic-bd387eeb` rail 5: "Keep each production source focused, target <=250 lines, and
  split before 400 lines"
- `AGENTS.md:66`: "Target at most 250 lines per **production source** and split before 400"
- global rails: empty

Both are **per production file**. Neither bounds a task's total diff. There is no
per-task net-LOC number anywhere in the rails.

## Where it actually comes from

The QA role instructions the Moe wrapper injects into every QA session contain, verbatim:

> Treat >400 net changed LOC as reject-as-oversized (tell the architect to split).

That is why two QA agents enforced an identical unwritten bar independently — not mutual
citation, the same injected prompt. **Approving a rail proposal does not remove it**: the
rails will say per-file while the role template keeps saying per-task, and the next QA
session starts enforcing it again on turn one. The wrapper's role template is what needs
the change.

## Ruling in force

- Task-level net LOC is **not** a rejection reason, at plan time or post-commit.
- Per-file 250 target / 400 hard cap **is** strict and remains a valid rejection reason.
- Recorded human size exceptions are honored only for the commit they name; audit the
  proposal JSON directly (`status`, `resolvedBy`, scope) — never trust a reopenReason.
- Pending rails: `prop-58a455c0` (per-file only; task size bounded by plan shape, <=12
  steps / <=10 files), `prop-109471af` (assert the reason code, not just the outcome).

## Cost of the phantom bar, for calibration

Two SPIDR splits justified against it, one human exception (`prop-0543d3ce`) requested for
commit `37b11e5` where every file was already under 400 — so no rail was violated and a
human was asked to except a bar that did not exist. Hours of block time.

Lesson beyond size: **when asked to name the source of a rule you are enforcing, go read
it.** An unwritten constraint repeated between agents acquires the texture of authority
without ever having been set.

## Related

`mem:pattern-qa-mutation-testing-the-claim`, `mem:pattern-assert-which-layer-refused`
