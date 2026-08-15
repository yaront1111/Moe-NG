# Handoff: J4 review-flow persistence (task-9011e3b32c414e9ca0d49f49fdfaaf08)

Commit **4ac6de3**, 20 files, all under `apps/daemon/src/review/` plus the
`apps/daemon/package.json` `@moe/review` edge and its 3 lockfile lines.

## What landed

`apps/daemon/src/review/` — six production modules, each with its `.js` bridge:

| module | lines | role |
|---|---|---|
| `review-contracts.ts` | 253 | byte ingress, frozen vocabularies |
| `review-ledger.ts` | 233 | commit seam, replay lookup, `refuse` overloads |
| `review-read-model.ts` | 206 | folds committed decisions into `ReviewLedger` |
| `review-services.ts` | 202 | `runReviewCommand` pipeline + `submitRound` |
| `review-acceptance.ts` | 123 | `decideEscalation`, `acceptOutput` |
| `review-delta.ts` | 113 | `classifyReplanDelta` |

Five test files, 58 tests. `review-test-fixtures.ts` (384) is test-tier and
deliberately has **no** `.js` bridge — it is reached only from `*.test.ts`.

## Non-obvious decisions a reviewer will ask about

- **The kind list is domain-scoped, not appended to `BOOTSTRAP_COMMAND_KINDS`.**
  `bootstrap-sequence.ts`'s `COMMAND_PREREQUISITES` is a TOTAL
  `Record<BootstrapCommandKind, ...>` and two bootstrap suites assert its exact
  length, so appending there is a typecheck failure plus two red assertions in
  unowned files. `recovery/doctor-commands.ts` and `work/work-ingress.ts` already
  carry their own vocabularies — see
  `mem:gotcha-exhaustive-prerequisite-record-blocks-a-kind-append`.
- **One condition is daemon-owned, by design**: `submitRound` refusing a further
  round once the limit is reached with no recorded escalation. The kernel is
  stateless about what follows the limit and would route a fourth round to
  ESCALATE again. Design 15.2 assigns the durable consequence to the composition.
  The THRESHOLD is imported (`REVIEW_ESCALATION_ROUND_LIMIT`), never copied.
- **Delta approval composes `@moe/core`, not a hash comparison.**
  `evaluateCarryForward` owns design 265's six conditions;
  `verdict.value.valid` maps to CARRY_FORWARD, `!valid` to INVALIDATED.
- **`refuse` is overloaded on the refusing layer** so an undeclared daemon code
  does not compile — see `mem:gotcha-daemon-refusal-code-vocabulary-drift`.

## Verification, and the honest state of the gates

Owned legs, run fresh after the commit, exit 0:
`pnpm --filter @moe/daemon typecheck` (covers every daemon TS file) and
`pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/review`
(5 files / 58 tests).

The plan's unscoped chain does NOT exit 0, for reasons outside this diff. Both
failing paths are untracked and ABSENT at merge-base `7afa17d`
(`git cat-file -e 7afa17d:<path>`), so neither could have failed before:
- `apps/daemon/src/recovery/continuation-binding.test.ts` — sibling task's file,
  edited mid-run (it was `TS2307` twenty minutes earlier, then
  `ReferenceError: reconciliationRows is not defined`).
- `apps/control-room/src/a11y/keyboard-map.test.ts` — another agent's TDD red.

Delta intersected with this task's owned paths is EMPTY. Re-run the unscoped
chain later; both should clear on their own.

## What this does NOT close

J4 **persistence** only. The Foundation canary still needs J1's command path
(`task-671578e5`) and J3's launcher/restart composition.

**Known gap, deliberately not fixed** (outside owned paths):
`apps/daemon/src/index.ts` does not re-export the review surface, so
`tests/runtime/package-loadability.test.ts` — which probes each package's
`exports["."]` — never reaches these modules. They are proven loadable only by a
direct probe: `node -e "import('./apps/daemon/src/review/review-services.js')"`
returns IMPORTED under Node v24.16.0. Whoever wires the review command path into
the daemon's public surface must add that export.

## Mutation drill result (all restored, sha256-verified)

Seven mutations. Load-bearing, with the red test named: lineage carry (4 suites /
12 tests), typed-subject fingerprint operand (1), delta classification (3),
escalation limit at each boundary separately (1 + 1), acceptance gate (9),
vocabulary entry (1 test + `TS2769`). One control — neutralising a finding's
prose — stayed green, which is what proves identity is typed rather than textual.
