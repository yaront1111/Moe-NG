# Technique: how to plan a task whose dependencies are unbuilt, without inventing them

Established 2026-08-08 planning seven pipelined M1 tasks that the promotion notes said
should probably `report_blocked`. **Six of seven needed no blocking at all.** The governor's
warnings were right about the dependency STATUS and wrong about the consequence, and the
difference is a question worth asking every time.

## The question

**Does the dependency enter as a CALL, or as a SHAPE?** Only a call blocks you.

| How the dep enters | Blocked? | What to do |
|---|---|---|
| You must invoke its function | YES | `report_blocked`, name the module |
| You must know its internal record layout | YES | block |
| You cite its output by **identity/digest** | NO | opaque content-addressed ref, validate shape only (64-hex) |
| You must **exclude** it | NO | you cannot import a thing in order to leave it out |
| You **classify** its status | NO | caller-supplied classification, the port pattern |
| It contributes **entries to a registry** | NO | make your surface generic over the registry |

Worked cases from this batch:
- **Evidence receipt pipeline** → External effect supervisor appeared ONLY in a DoD list of
  things a receipt binds ("...lease, and effect identities"). A field, not a call. Opaque ref.
- **Independent review flow** → the context journal appeared only as something the clean
  package must EXCLUDE. An exclusion is not a dependency.
- **Crash reconciliation** → the supervisor's SUSPECT/absent status is a caller-supplied
  observation, which is what the whole runner subtree already does for OS facts.
- **Live control-room seam** → 5 of 7 deps unbuilt, but every DoD item is a property of the
  ADAPTER BOUNDARY (auth, bounds, idempotency, stable errors, cursor resume), not of any
  command. Made the adapter generic over a command registry; unbuilt deps add entries later.

## The two things that actually de-blocked more than any cleverness

1. **A "BACKLOG" shell can hide fully committed code.** `task-55d5a898` Projection outbox
   core was BACKLOG while all five of its children were committed and on disk. Eight tasks
   "depended" on something that already existed. **Read the children, not the parent's
   status column.**
2. **Greenfield is free.** Four of the seven created new packages or new directories
   (`packages/context`, `packages/review`, `packages/runner/src/recovery`,
   `apps/daemon/src/http`). New code collides with nobody, so the "shared working directory"
   hazard that dominates this repo simply does not apply. Check `ls` before assuming conflict.

## The one that genuinely could not be de-blocked

`task-49acb856` supervisor hardening gate. Its PRODUCT is tests over children 1-3's code;
there is no seam trick, and trimming the expected outcome-kind list to match a partial slice
would invert the entire point (the parent rail: a drill weakened to pass defeats the
breakdown). Resolution: **split the plan along the dependency line** — the seeded harness
ENGINE (pure, dependency-free, historically the slowest part to get right) is built now; the
slice invariants wait. Real progress, no faked coverage.

## Recurring plan shape that fits the daemon's thresholds

New package: scaffold from `packages/scheduler` (zero-dep template) → contract module of
frozen vocabulary data → TDD pairs per concern → mutation drill → gate → pathspec commit.
Lands at ~11 steps / 7-10 files, inside the <=12 / <=10 hard thresholds.
`pnpm-workspace.yaml` globs `packages/*`, so a new package needs NO workspace edit — only a
single `pnpm-lock.yaml` importer entry, which IS shared state.

## Ownership amendments are the real blocker in apps/daemon

`apps/daemon` depends on `@moe/contracts` + `@moe/scheduler` ONLY. Anything needing
`@moe/core`, `@moe/store` or `@moe/runner` requires an amendment to `apps/daemon/package.json`
(precedent: child 3's human-approved "+@moe/runner, single lock hunk"). Plan it as an explicit
governance STEP 1 that waits for confirmation — and check the file first, because a sibling
task in the same batch may already have landed it.
