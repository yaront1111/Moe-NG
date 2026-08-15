# task-667b1085 — Control-room journey gate (reopen 1, LOADING invariant)

## What the reopen was about
QA (qa-f3560083) rejected the first pass on ONE defect: DoD 2 names SEVEN invariants
(truth, provenance, keyboard, narrow-window, **loading**, degraded, latency). Five were
asserted in `journeys.spec.ts`, latency was recorded as a typed UNKNOWN, and **loading was
neither asserted nor recorded**. Silence read as coverage.

The 3-of-20 scenario count was explicitly NOT a rejection reason (governor-36019faa ruled
on it). Do not try to close those 17 UNKNOWNs.

## The structural cause, worth remembering
`journey-coverage.ts` ledgers spec section 12's **twenty SCENARIOS**. DoD 2's seven
**INVARIANTS** are a *different axis*. Nothing enumerated that second list, so there was
no list for loading to be missing from. Fix was to create the axis:
`tests/e2e/control-room/journey-invariants.ts`.

Generalisable: when an artifact records one enumeration, check whether the DoD names a
*second* one. An item can only go silently missing from a list that does not exist.

## Loading is SURFACE_NOT_COMPOSED, not SURFACE_ABSENT
Components are real and committed — `cr.board.skeleton` (board-surface.tsx:101),
`cr.goals.loading` (goals-home.tsx:231), `cr.health.loading`/`cr.health.skeleton`
(doctor-console.tsx:231/233). A file-existence check PASSES for all of them.

Unreachable on **both** served paths (QA only traced the first):
- fixture: main.tsx:40 -> ControlRoomScaffold -> kernel.tsx -> ControlRoomPreview — zero `loading`
- live: main.tsx:40 `?live=1` -> live/live-app.tsx — zero `loading`
- only producer of `loading: true` is `a11y/ui-wide-core-fixtures.tsx`, imported solely by
  tests and one other fixture module.

## Gotchas that cost real time here
1. **A foreign whole-tree commit captured a mutation drill mid-run.** HEAD went
   0b1d7a7 -> 968ca74 -> d531406 while drilling; d531406 committed `journey-invariants.ts`
   with drill 5 applied (id "LOADING" substituted to "LATENCY"). `git status` showed a
   one-line diff that read like a trivial edit. Only `git show HEAD:<path> | grep 'id: "'`
   revealed it. See `mem:mutation-drills-in-shared-worktree`.
2. **A weak mutation is not a weak guard.** Blanking only part of `missingInput` left it
   non-empty and still containing the ids, so 23/23 passed. Read what you actually
   changed before concluding a guard is decorative.
3. **A count assertion misses a substitution.** Swapping the LOADING entry's id to
   "LATENCY" kept the length at 7. The whole-list `toEqual` caught it; `toHaveLength`
   would not have.
4. Deriving `status: LOADING_RECORD.status` (rather than re-writing the literal) makes a
   COVERED flip a **compile error** — the object stops satisfying `UnknownInvariant` for
   want of `bar`/`provenBy`. Stronger than a red test.

## Two vacuity holes found in adversarial self-review (no failing test)
- Binding matched `test("<title>"` as a plain substring, so a title in a **comment**
  satisfied it. Now a Set built from line-anchored `/^test\("...` declarations.
- `it.each` over an inline literal: emptying it generates zero tests and passes green.
  Extracted to `SERVED_ENTRY_POINTS` with a whole-list assertion.

## Final state
Commits (explicit pathspec, one owned file each): `77fc85d`, `5e12da8`.
Gates at 5e12da8: `pnpm test:e2e` 4 files/68 tests exit 0; `pnpm test:e2e:browser`
10 passed exit 0 (**this one is DoD 4**; the task's Verification field names the Node lane).
Counts: journey-coverage.ts 281, journey-invariants.ts 143, journey-coverage.test.ts 320,
journeys.spec.ts 341.

## Still open, NOT worker-fixable
- 12 of 17 UNKNOWNs are `NO_DAEMON_BACKED_BROWSER_LANE` — **unowned** (task-3f503779 archived).
- 3 are `SURFACE_ABSENT` — owner task-779d6804 is **ARCHIVED**, must be revived/re-created.
- LOADING — unowned; nothing composes a pending state into either entry point.
- LATENCY — open human decision, no reference machine named anywhere.
