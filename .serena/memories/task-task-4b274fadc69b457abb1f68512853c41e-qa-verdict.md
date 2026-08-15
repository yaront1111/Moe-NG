# task-4b274fadc69b457abb1f68512853c41e — QA verdict: APPROVED (DONE)

Approved 2026-08-09 by `qa-5be1a8d6`. Commit `070a9b1`. Full evidence in task
comment `comment-71d43d90`; the approval summary is the 2000-char digest of it.

## What I re-ran, not trusted

- `pnpm --filter @moe/control-room test` -> **44 files / 622 tests, exit 0**, twice
  (before and after my own drills). Exactly the worker's claim.
- `pnpm --filter @moe/control-room typecheck` -> clean.
- Diff: 4 files, +691/-2, **all test files, zero production changes**. Lines by
  `grep -c ''`: 306 / 225 / 144 / 341, all under 400.
- Re-measured every premise the guard asserts. All held. The worker's counts were
  right and the task description's were stale (again).

## Four mutation drills I ran myself

QA did not accept the worker's mutation evidence on paper. Each drill: mutate, run,
see red, revert, `sha256sum -c` against a pre-drill baseline.

| Mutation | Result |
|---|---|
| delete `@import "./responsive.css"` | 3x `MOTION_WITHOUT_REDUCED_MOTION_GATE` + dead-code arm |
| blank `CARD_FACTS` `"SUSPECT"` label | `INDICATOR_COLOUR_ONLY` / `cr.fact.node.colour-node.suspect` |
| `role="alert"` on `cr.banner.disconnected` | `expected 'ASSERTIVE' to be 'POLITE'` |
| `requestAnimationFrame` in a production tsx | `JS_DRIVEN_MOTION` + source + token |

Drill 2 independently confirmed the worker's key structural claim: the **15 shared
`ui-wide-*-fixtures` surfaces stayed GREEN** because they build the board with
`cards={[]}`. Only the dedicated `BoardSurface` render reddened. That arm is the real
DoD 3 deliverable; without it the file would have been decorative.

## The one thing I disclosed rather than waved through

DoD 2's literal *"every .css file contains a reduced-motion block"* is **unmet — 4 of
16**. Literal compliance requires 12 production CSS edits that taskRail 2 forbids and
that the `!important` global reset already makes redundant. Same conflict as the
governor's item-1 correction; resolved at plan time by the human operator and recorded
in `planningNotes.approachesConsidered`. DoD 2's operative half — the existing blocks
cannot be hollowed out — is met and drill-proven, so I approved on that basis and put
the departure in writing rather than in a silent pass.

**Known ceiling, stated but not a defect:** the same-file branch tests that a sheet
*contains* a reduced-motion block, not that a specific new declaration is overridden
inside it. A future motion on a selector the existing block does not name would pass.
Inherent to a source-text pin; nothing on disk is falsely green today. `shell-layout.css`
was checked by hand — its block targets `cr.shell.navrail` and `cr.shell.inspector`,
exactly the two selectors carrying its transitions.

See `mem:decision-motion-gating-global-reset-not-per-file`,
`mem:task-task-4b274fadc69b457abb1f68512853c41e-handoff`,
`mem:gotcha-narrowed-vitest-run-reddens-for-the-wrong-reason`.
