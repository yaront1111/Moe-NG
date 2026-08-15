# An ARCHIVED dependency can never reach DONE — reword unblock conditions against the CAPABILITY

Found governing the board 2026-08-10 on `task-5e43a9e2` (Foundation daemon
ingress surface, CRITICAL).

## The trap

Unblock conditions are routinely written as *"wait until task-XXXX is DONE"*.
If that task is later **ARCHIVED**, the condition becomes **unsatisfiable as
written** — archive is terminal and dependents will wait forever.

`task-5e43a9e2` names five hard dependencies. Two are now archived:
- `task-8470a860` — archived as a confirmed duplicate (`task-318379ea` shipped
  its deliverables). Its block note still describes it as "in flight".
- `task-4afcb064` — archived deliberately because **BACKLOG does not hold**
  (`claim_next_task` re-serves demoted tasks) and it had already been wastefully
  re-served once. Its own block is unchanged and correct.

## The important nuance — capability can arrive without the task

`task-4afcb064`'s three CHILDREN are all DONE, and they delivered the very
surface its parent was supposed to provide. The block said

> COORDINATION ops = ABSENT. `ls apps/daemon/src/coordination/` → No such file

That directory **now exists** (`recipient-registry.ts` et al) via
`task-04e43674`. The capability arrived from the far end of the chain while the
named task will never transition.

**So: word unblock conditions against a measurable capability — a path, a
symbol, a passing probe — not against a task id.** A task id is a proxy that can
be archived, split, superseded or renamed out from under the condition.

## Scanning for these dead-ends

Blocked reasons cite ids in BOTH short (`task-4afcb064`, 8 hex) and full (32
hex) form. A regex of `task-[0-9a-f]{32}` silently misses every short reference
— my first scan returned "no dead-ends found" and was wrong. Use
`task-[0-9a-f]{8,32}` and normalise to the first 13 characters before lookup.

## Also worth knowing

Not every archive is a mistake. Of four archived tasks I examined, three were
legitimate and well-reasoned: one superseded with deliverables verified in code,
one a scope deferral that can never pass on a win32 host, one parked because
BACKLOG re-serves. Only one was a genuine error (a finished shell archived on
the false belief that DONE was unreachable — see
`mem:decision-spidr-shell-closure-transit-path`). **Read the archive reason
before "fixing" it**; mass-converting archived tasks on a heuristic would be
destructive.
