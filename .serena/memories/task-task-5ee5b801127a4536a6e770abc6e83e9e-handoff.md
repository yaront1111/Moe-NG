# Usage measurement truth — QA APPROVED (commit 1125ed6)

`packages/scheduler/src/budget/budget-measurement.{ts,test.ts,js}` on `moe/work-2026-08-08`.
Third child of the budget SPIDR split, after `mem:task-task-7dc2e4870d7d4096a1be7b5991e50e94-handoff`
(contract vocabulary) and `mem:task-task-a5def097bcb7495e935204bd845160b4-handoff` (ledger).

## Surface that landed

- `normalizeUsageMeasurement(input, prior?) -> MeasurementResult<NormalizedMeasurement>`
- `projectBudgetFact(normalized) -> PolicyFactInputCompatible` — `{factId, tier: null, truthClass}`,
  a STRUCTURAL mirror of `packages/core/src/policy/policy-contract.ts:68-72`, never an import.
- `NormalizedMeasurement = {measurement, pricebookBinding|null, truncated, identity}`
- `MEASUREMENT_ISSUE_CODES` (10), `MEASUREMENT_ISSUE_LAYERS`, `SUPPORTED_SOURCE_PARSER_VERSIONS`
  (`[1, 2]`), `MEASUREMENT_FACT_TIER` (null).
- Input envelope is `{measurement, pricebookBinding, truncated}` with ALL THREE KEYS REQUIRED —
  `pricebookBinding: null` must be spelled explicitly. A missing key is `_MALFORMED`, not a default.
- NOT exported from the package root (verified zero references outside `src/budget/`).

## Design decisions worth preserving

- **Two layers, and the layer is part of the assertion.** Contract layer = the landed
  `validateUsageMeasurement`, runs FIRST and short-circuits (a malformed record is never judged for
  truth). Measurement layer adds cross-field/cross-observation rules. Codes are prefixed
  `BUDGET_OBSERVATION_` specifically because the contract layer already owns `BUDGET_MEASUREMENT_`;
  a test asserts the two sets are disjoint. Reusing a prefix would make "which layer refused"
  unassertable — that is the point of the epic's reason-code rail.
- **Purity via caller-supplied prior.** Monotonicity is judged against a `prior` snapshot the caller
  passes, NOT an internal registry. Keeps the function deterministic and the repeat-call deep-equal
  DoD honest.
- **Same-identity same-bytes duplicate returns the PRIOR object by reference** (`toBe`, not
  `toStrictEqual`) — same guarantee shape as the ledger's same-reference-on-rejection.
- **Identity is length-prefixed**: `${run.length}:${run}|${meter.length}:${meter}|${sequence}`.
  Refs are arbitrary bounded strings, so a plain join lets `("run|x","y")` and `("run","x|y")`
  collide into one identity and therefore one fact ID. A test pins non-collision.
- **Sequence is per providerRunRef stream, not per meter.** A different meter at the same sequence
  reads as REGRESSION, by design.
- **truthClass is derived from source honesty, never caller-asserted**: `ACTUAL_BILLED -> OBSERVED`,
  `PROVIDER_REPORTED_* | SUBSCRIPTION_QUOTA -> AGENT_REPORTED`, `DERIVED_LIST_PRICE -> UNKNOWN`,
  `UNKNOWN -> UNKNOWN`. A derived list price is an estimate and can never become an observation
  (design 638-653); the source is also spelled into the factId so it cannot be laundered downstream.
- **A non-derived source carrying a pricebook binding is refused** as
  `_UNCORRELATED_BILLING_CLAIM` — the binding is not merely dropped.
- **Unreadable parser version + known coverage refuses; with UNKNOWN coverage it is accepted** and
  stays UNKNOWN. Truncated + COMPLETE refuses; truncated + PARTIAL/UNKNOWN is fine.

## QA evidence

Task gate exit 0 (18/18). Full package `pnpm --filter @moe/scheduler test` -> 29 files / 433 tests,
exit 0. Sizes from `git show HEAD:<path> | wc -l` (not the working tree, per the sweep lesson in the
contract handoff): 250 / 250 / 1.

**16-mutation red-check run by QA, not just claimed by the worker** — every refusal class plus
deepFreeze, binding detachment, identity length-prefixing, no-op-returns-prior-reference, and the
CONTRACT layer tag itself. All 16 RED, all restores hash-verified. See
`mem:gotcha-mutation-testing-restore-safety` for the harness rules that made the restores safe.

## Known gap (accepted, not a defect)

DoD 4 says refusals carry "frozen deterministic issues". The behavior is real — QA probed it
out-of-tree: a three-issue refusal returns result, issues array, and each issue frozen, canonically
sorted, byte-identical across calls. But NO TEST ASSERTS IT, and no test exercises a multi-issue
refusal at all, so `sortIssues` is unexercised here. If a later task touches this module, add a
multi-issue refusal case asserting the frozen array and the canonical order. Mutating `deepFreeze`
today reddens only acceptance-path tests.

## Probing a scheduler module without leaving scratch files in the repo

`node --experimental-strip-types --input-type=module -e "import {...} from 'file:///D:/.../x.ts'"`
works from the repo root and resolves the in-package `./y.js` shims. Use this instead of a
throwaway test file — no commit sweep risk (`mem:gotcha-shared-index-commit-capture`).
