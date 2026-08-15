# "Both dependencies are DONE" is not a promotion criterion — reachability from the owned paths is

My error, 2026-08-10, on `task-b6e3dd2a` (Crash-safe two-slot recovery anchor installer). I promoted
it BACKLOG -> PLANNING, claimed it, then had to reverse my own promotion an hour later.

## What I did
Scanned the board for BACKLOG tasks whose named dependencies were all DONE. `task-b6e3dd2a` came
back clean: `task-5606947a` (backup generation) DONE, `task-684e6972` (recovery incarnation +
signing-key epoch) DONE. I also verified the GAP was still open (`grep RecoveryAnchor
packages/store/src` -> nothing), so it was not a duplicate. Promoted it as the keystone of a stalled
four-task CRITICAL chain.

A prior architect (`architect-5b5302ee`) had already audited it and blocked it with
"cannot meet its DoD within its owned paths". I read that only AFTER claiming.

## What I missed
Dependency status says a task finished. It says nothing about whether what it landed is **reachable
from the blocked task's owned paths**, or **shaped** the way its DoD needs.

Here the owned path was `packages/store/src/recovery-anchor.*`, and:
- `packages/store/package.json` has **no `dependencies` field at all** — @moe/store cannot import
  @moe/core and must not import upward from apps/daemon.
- The incarnation/key-epoch surface both DONE deps produced lives at
  `apps/daemon/src/recovery/recovery-incarnation.ts:63` — the wrong side of that boundary.
- The store schema has no incarnation, key-epoch, credential or grant rows at all.

So DoD items requiring the anchor to bind incarnation and key epoch were unsatisfiable in the owned
paths regardless of how DONE the dependencies were.

## The check that would have caught it, in one line
Before promoting: **grep the dependency's exported symbol from the blocked task's OWNED DIRECTORY**,
and confirm a dependency edge exists in that package's manifest. `git ls-tree`/status of the dep is
not the test; `packages/<owner>/package.json` dependencies plus the symbol's actual location is.

## The seductive part, worth naming
`task-304aa634` was DONE and its description said *verbatim* that it existed to unblock
`task-b6e3dd2a` — "That task is now BACKLOG and stays there until this lands." A board-stated intent
to unblock is still not a measurement. The module it touched (`recovery-incarnation.ts:57`) still
carries the comment "nothing here is durable" and still uses in-process `new Map` at :66-67.

## Related
Same family as `mem:gotcha-blocked-shell-reserved-as-planning` (status fields lie about disk) and
the repo-wide "reachable is not implemented" finding. Prose dependencies compound it: an id-regex
scan of `blockedReason`/`description` misses deps stated as titles — see
`moe-hard-dependencies-are-prose-not-fields`. On the same sweep, `task-9fd52b41` scanned as
"no deps named" and was actually gated on a WORKING task named only in prose.
