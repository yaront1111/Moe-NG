# task-d7da9be4 — Git + artifact recovery-inventory adapters, REVIEW 2026-08-10

Slice 3 of 3 of task-0325dcf7. Landed GIT_INTEGRATION_ON_DISK and
ARTIFACT_OBJECT_STAGING enumerators. Gate: `pnpm --filter @moe/runner typecheck
&& test` = 0/0, **49 files / 1459 tests** (baseline I measured myself before
writing: 46 / 1421).

## What shipped
- `recovery-inventory/git-integration-inventory.ts` (250 lines) + `.js` bridge.
  Composes `GitObserver.listRefs()` + `headCommit()` + `submodulePaths()`.
  Exports `enumerateGitIntegrationInventory(input, context)` returning
  `{reading, refusal}` and `gitIntegrationInventoryRegistration(input)`.
  Input: `{observer: GitObserver, clock: ObservationClock}`.
- `recovery-inventory/artifact-object-inventory.ts` (194 lines) + `.js` bridge.
  Composes `ArtifactStore.enumerateArtifacts()`. Same `{reading, refusal}` shape.
  Input: `{store: ArtifactStore, clock: ObservationClock}`.
- Tests: `git-integration-inventory.test.ts` (17), `artifact-object-inventory.test.ts`
  (14), `inventory-registration.test.ts` (7 — the seam, incl. ALL FOUR classes).

FILE NAMES follow the approved plan, NOT the description's older
`git-inventory`/`artifact-inventory` spelling.

## Answer mapping (memorise before touching these)
GIT: empty-but-observed → COMPLETE against `GitRefListing.observationDigest`;
`RUNNER_SCOPE_OBSERVATION_FAILED` or absent `listRefs` → UNAVAILABLE;
`RUNNER_SCOPE_STATUS_MALFORMED` / `_OBSERVATION_OVERFLOW` → `complete:false` →
RESULT_TRUNCATED. An **unborn HEAD is not unreadable** — `listRefs` succeeding
already proved the repo observable, so head becomes null and stays COMPLETE.

ARTIFACT: `RUNNER_ARTIFACT_ENUMERATION_UNAVAILABLE` → UNSUPPORTED →
CAPABILITY_UNSUPPORTED; `RUNNER_ARTIFACT_MISSING` → UNAVAILABLE; everything else
(VERIFY_FAILED, ADDRESS_CORRUPT, ENUMERATION_LIMIT) → `complete:false` →
RESULT_TRUNCATED, with the exact code+layer on `refusal`.

## The forced design decision QA should not re-litigate
`RecoveryInventoryRegistration` is exact-keyed `["class","enumerate"]` and
`readRegistry` returns **null for any extra field**, so a registration cannot
physically carry a refusal code. DoD 2's "reported with a stable code" therefore
rides on the enumerator's own `{reading, refusal}` return; the registration
passes only `.reading`. See `mem:gotcha-exact-keyed-seam-forces-dual-return`.

## Stale claims corrected by measurement
- Description: "the enumerators DO NOT EXIST TODAY" — false at HEAD.
- Governor promotion note: "GitObserver has no ref method / any plan naming one
  will not compile" — false. `listRefs?()` is `scope-contract.ts:73`, implemented
  `scope-git.ts:197`. The architect's correction was right.
- Promotion note: "consume through the @moe/runner package root" — that is for
  EXTERNAL consumers; these modules live inside the package, so production uses
  relative imports. Slice-2 style: tests may import `@moe/runner` for the
  aggregate surface, production may not.

## Foreign whole-tree commit
`7879698` (task-069853689e, "Scheduler supersession dispositions") swept all six
files mid-mutation-drill and committed the git module carrying drill 5's
mutation. Not amended/reset. Correction is `968ca74`, one file, explicit
pathspec. Review by base-ref diff over the owned paths, not by one commit.

## Live foreign red (not mine, disclosed)
Repo-wide `pnpm test` exits 1 on `tests/fault/foundation/j1-linear.test.ts`
> `incident:hot-claim-loop-on-gated-work` — expected `{kind:'PASS_EXPECTED'}`.
Stale expectation row in `packages/testkit/src/foundation/foundation-incident-schedules.ts`
from `2c93542`. Zero @moe/runner in its closure.

## Consumer (global rail clause 1)
task-0325dcf7ee744123b40cf583230c7b6a — BLOCKED parent; this was its last
non-REVIEW gate.
