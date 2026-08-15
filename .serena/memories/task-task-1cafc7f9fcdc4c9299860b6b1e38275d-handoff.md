# task-1cafc7f9 — Doctor exact runtime and tool version reporting — COMPLETE

All 7 steps done. Two commits, owned-package gate exit 0, handed to QA.

## Commits (both explicit-scope; nothing foreign rode along)

- **`b374edd`** — the 10 owned files under `apps/daemon/src/recovery/`, +1290.
- **`a423722`** — `apps/daemon/src/index.ts` + `index-surface.test.ts`, **5 insertions / 1 deletion, nothing else**.

`a423722` is the one a reviewer will question. `b374edd` widened
`DoctorCommandResult` 5 branches -> 7; `index-surface.test.ts:300` pins that union
BY HAND and the daemon `tsconfig.json` includes `src/**/*.ts`, so **my own commit
left HEAD type-red**. Both files also carried ~150 uncommitted lines of another
task's HTTP-listener/daemon-entry export work, so a normal pathspec commit would
have stolen it. Landed via surgical index staging instead — see
`mem:gotcha-commit-own-lines-from-a-file-carrying-foreign-wip`.

## Shipped surface

Pure `doctor-version-contract.ts` (249) — vocabulary, `ObservedValue` two-arm
union, `comparePin` / `compareRangePin` / `packageManagerVersion` /
`buildDoctorVersionReport`. Node boundary `doctor-version.node.ts` (174) — process
read, declared pins, pnpm spawn ladder. Filesystem half
`doctor-version-components.node.ts` (129) — root discovery, workspace sweep.
`doctor-commands.ts` 229 -> **250** (at the cap; the pre-approved
`doctor-request-parse.ts` split was NOT needed). All `grep -c ''`, not
`Measure-Object`.

Consumer edge = the `doctor.report_versions` command kind.

## Live probe, plain Node (DoD 5), re-run this session

`node --experimental-strip-types --input-type=module -e 'import("./src/recovery/doctor-version.node.js")'`
from `apps/daemon`, then calling the reader:
node `v24.16.0`, pnpm `11.0.8`, win32/x64, all four pins **SATISFIED**,
`componentCount 16`, `Object.isFrozen(report) === true`, `@moe/daemon` present.

## Decisions QA will ask about

- **`DOCTOR_PIN_MISMATCH` is NOT shipped**; `DOCTOR_PIN_RANGE_UNSUPPORTED` is.
  A mismatch is the `MISMATCHED` *verdict* — `VersionPinVerdict` has no code
  field — so the planned code would have been a dead vocabulary entry.
- **`componentInventory: ObservedValue` added beyond the planned shape.** Without
  it, "swept and found zero" and "could not sweep" are the same empty array.
- **`compareRangePin` SUBSTITUTES `declared`** with a coded UNKNOWN when the range
  grammar is unsupported, losing the raw range string. Deliberate (the code and
  refusing layer travel with the pin) but it IS a substitution — flagged in the
  step-7 note rather than buried.
- **Two version literals remain, both in PROSE COMMENTS** (contract:116, :199),
  zero in executable code. Disclosed, not claimed absent.
- **Two test files, not the plan's one** — see
  `mem:gotcha-daemon-js-bridges-are-runtime-tier-only`.

## Gate at handoff

Owned package **exit 0**: daemon typecheck silent, `Test Files 34 passed (34) /
Tests 678 passed (678)`.

Repo-wide third leg **exit 1, FOREIGN**: `packages/core/src/expansion/expansion-planning-hold.test.ts`
TS2352 x4. `git status` -> `?? packages/core/src/expansion/` — **untracked, never
committed**, so it cannot exist at my merge-base. Step-1 baseline at `41e4a1c`
was exit 0 on all three legs. Delta ∩ owned paths = EMPTY (project rail 3).

Two other foreign reds appeared AND CLEARED mid-session (runner
strict-classification migration reddening `continuation-contracts.ts` typecheck +
`continuation-service.test.ts`). The tree moved between two consecutive
`git status` calls — **re-measure, never recall, on this board.**

## Board change since planning

governor-f70d1157 moved **task-e87a7353 (Linux) and task-e94b2055 (macOS)
BLOCKED -> BACKLOG** as environment-deferred (`process.platform` is win32). Only
**task-9449ce65** (Release supply-chain gate, entered PLANNING 14:33) is a live
consumer. Do not cite the other two as live.
