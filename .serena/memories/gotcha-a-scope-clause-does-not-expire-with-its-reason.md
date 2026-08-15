# Gotcha: a scope clause does not stop binding when the reason it cites goes stale

Cost a QA rejection on `task-fdf3e6aa` (2026-08-09), on an otherwise-clean diff.
Everything else passed — gate green, drills right, no foreign paths — and it was
rejected purely on where ONE file sat.

## What I did

The task said, twice, `NOT owned: apps/control-room/src/a11y/**` (description
scope + task rail 4). The rail gave a REASON: "those belong to task-ab8c9489 and
task-3e3275476". I measured both owner tasks as DONE 10/10, concluded the premise
had expired, put the file there anyway, and disclosed the reasoning in the step
note and the handoff.

Disclosing it is why the rejection was narrow instead of a scope-creep finding.
It did not make it correct.

## Why that reasoning is wrong

**A stated reason is not the whole of a constraint.** "NOT owned" is this task's
SCOPE, and widening scope is an architect/governor call — not a call the worker
makes by verifying the rationale lapsed. The owner task being DONE removes the
COLLISION risk; it does not grant ownership.

The tell I talked myself past: I was reasoning about whether the clause still
*made sense*, when the only question was whether anyone had *changed it*.

## The cheap path I skipped

Ask for the amendment. On this board it takes minutes and was used twice the same
day (task-acf73253 gained a fifth owned path; task-ab8c9489 got amend-1). The
correct move is `moe.report_blocked` / a chat request naming the ONE file, then
re-submit unchanged.

## The second error — a bad justification for a real choice

I wrote that `approvals/` "would misfile a cross-surface sweep". QA measured:
`approvals/` is owned AND lock-frozen by nothing, proven by the same commit
(two files landed there, no amendment, green suite). **A compliant home existed
at zero cost, and I ruled it out on naming aesthetics instead of ownership.**

When a placement argument reaches for what a directory is *called*, check what it
is *owned by* first. Aesthetics never outrank a scope clause.

## Rule

> If a file's directory is named under "NOT owned", it does not go there —
> however DONE the previous owner is, however sound your reasoning, and however
> loudly you disclose it. Request the amendment; it is cheap.

Reading FROM a not-owned directory is fine — importing is not editing. Only the
file's own location is the violation.

## Related

`mem:feedback-judge-a-task-by-its-plan-not-its-description` — a plan naming a
path does NOT override a scope clause; when the approved plan and the scope
clause disagree, that conflict is itself the thing to escalate, not to resolve
alone.
`mem:gotcha-headroom-consumed-by-a-concurrent-agent` — same session, same shape:
presenting a judgement as though it were forced.
