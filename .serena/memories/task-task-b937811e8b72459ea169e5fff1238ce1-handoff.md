# task-b937811e — Benchmark telemetry harness — FIX ROUND DELIVERED (reopen 1)

Fixed 2026-08-16 by worker-ad55ab67. Commit `f70786f` (9 files, benchmark-only).
Gate: `pnpm --filter @moe/benchmark test` -> **`Test Files 6 passed (6)` / `Tests 55 passed (55)`** EXIT=0.
Prior round's memory (harness design, 8 original drills, the vacuous-gate closure) is in
this file's git history and remains accurate — **do not re-litigate the gate, it is closed.**

## What QA rejected, and what fixed it

`RECORD_SHAPE` guarded only the top-level KIND of containers the projector then read INTO.
See `mem:gotcha-container-guarded-by-kind-only-leaks-known-undefined` for the defect shape.

**All six findings reproduced against production before touching code** — a throwaway
`.test.ts` spreading variants of `completeRunRecordFixture()` through `projectBenchmarkRun`,
values forced out via an assertion diff with an `undefined -> "<<undefined>>"` replacer
(vitest swallows `console.log` in a passing test, and plain `JSON.stringify` erases the
finding entirely).

**Fix = one guard family in admission.** The projector, cell minters and cost module are
BYTE-IDENTICAL to what QA reviewed. Deliberately NOT patched at `producerUnknownCell`:
that would put a second authority downstream of the first, free to disagree about one field.

| module | lines | role |
|---|---|---|
| `benchmark-field-primitives.ts` | 97 | isPlainRecord, text/nullable helpers, isProducerUnknown, isProjectedText/Quantity, isObservationOrNull |
| `benchmark-container-shapes.ts` | 166 | one predicate per container the projector reads into |
| `benchmark-record-admission.ts` | 142 -> 110 | now only the guard ORDER and its table |

**No new codes.** A nested failure is the same condition as a top-level one:
`BENCHMARK_RECORD_FIELD_MALFORMED@BENCHMARK_SHAPE`; the cost-row binding is
`BENCHMARK_ROW_BASIS_ABSENT@BENCHMARK_ROW` because rows are read at the row layer.
Splitting them would leave a frozen member without a distinct producer.

## THE TRAP IN THIS FIX — read before touching the guards

The mirror-image failure of the defect: **a guard demanding a field the producer never
emits refuses every real record, and no fixture in this package would catch it.** Every
fixture here is hand-written, so over-strictness is invisible to the suite.

`ClaudeTelemetryLaunchFacts` carries an `exit` field this package does NOT project.
The guards therefore iterate a **fixed key list and ignore unlisted fields** — never an
exact key-set check. A test drives a launch carrying `exit` and asserts it still PROJECTS,
pinning the over-strict direction too.

Verified field-by-field at source, not inferred: `ProviderRunRef`,
`ClaudeTelemetryLaunchFacts`, `ClaudeLaunchSelection`, `ClaudeObservedModel`,
`ClaudeTokenObservations`, `ClaudeStepObservations`, `LayeredIssue`,
`ProviderTelemetryRefusal`, `PricebookBinding` — then confirmed at the composition site
`apps/daemon/src/activation/activation-run-commit.ts:200-218`, which writes exactly this
shape taking each field verbatim from the handoff.

## Three cases I added BEYOND QA's list, same defect class

- `upstreamRefusal:{}` and `usageRefusals:[{}]` — a refusal column whose `code`/`layer` are
  `undefined` names no authority. Manifestation 2, relocated into the refusal columns.
- `pricebookBinding:{}` — `costBasis` reports PRICEBOOK_BINDING against a binding naming no
  pricebook revision. A cost basis with nothing bound to it; a cost-class DoD item.

## Tests: two halves, and neither works alone

- `benchmark-nested-shape-admission.test.ts` (181) — 21-case sweep, each pinning exact
  code+layer. Outcome rendered as ONE STRING per case: `PROJECTED` / `THREW:TypeError` /
  `CODE@LAYER`, compared as a single map. **That rendering is the point** — a test
  asserting only "did not project" passes on a crash, and QA issue 4 is precisely that a
  throw carries no code and no layer. See `mem:a-crash-is-not-a-refusal`.
- `benchmark-cell-invariant.test.ts` (142) — walker asserting the invariant in BOTH
  directions at any depth, over a pinned cell count of **127** (32 complete + 31 unobserved
  + 32 + 32; the unobserved arm carries one usage row, not two).

A sweep enumerates only the shapes someone thought of; a walker over complete fixtures can
never see a hole. Both, or the rule detaches.

**The walker caught a bug in its own first draft**: I required a value from EVERY cell,
which inverts half the rule. It reddened immediately on `settings.achievedConcurrency` and
`costClass[1].quantity`. The rule is directional and is now ONE field,
`valueKeyMatchesKnown` — known must carry a value, unknown must carry no `value` key.

## Eight drills, all red on the intended assertion

D1 launch guard -> bare kind (sweep; diff flips EXACTLY `launch:{}` and
`launch startedAt is a number`, nothing else) · D2 declared guard -> bare kind · D3
`isProducerUnknown` drops code/layer · D4 `isProjectedText` known arm accepts missing value ·
D5 `isRunRef` -> bare kind · D6 `isPricebookBindingOrNull` -> `return true` (reddens ONLY the
ROW test, confirming layer attribution) · **D7 = QA's requested drill** · D8 regression
re-run of the prior round's `nullableCell` -> `knownCell(0)`, still reddens 4 tests.

**D7 is the one that matters.** Post-fix the walker CANNOT see `launch:{}` — admission
refuses it first, by design — so exercising the walker on that input requires reverting the
guard. Two-file drill, disclosed as such: with the launch guard reverted AND `launch:{}`
added to the walker's arms, the walker names all nine leaked cells individually —
`timing.launcherStartedAt`, `timing.launcherCompletedAt`, and the seven
`reproducibility.*` digests, each `valueKeyMatchesKnown: false`. Exactly QA's nine.

## Disclosed, NOT repaired

1. **Theoretical crash**: a revoked Proxy makes `Array.isArray` throw inside
   `isPlainRecord`, escaping `projectBenchmarkRun` without a code. Unreachable from decoded
   durable data. The available fix is a catch-all that would report an internal projector
   bug as `FIELD_MALFORMED` — blaming the input for the harness's own fault. Misattributed
   evidence is worse than a crash, so it stays.
2. **Two record types, one version string.** @moe/runner exports its OWN
   `ProviderRunRecord` (`packages/runner/src/providers/telemetry/provider-run-record.ts:210`)
   with a different shape (`identity`, `model`, `decisionDigests`, `runtimeEvidence`) sharing
   `PROVIDER_RUN_RECORD_VERSION` with the daemon's. This harness mirrors the DAEMON's, which
   is the one committed; the daemon uses the runner builder only for `.usage`. Foreign, but
   it weakens the version seam repo-wide.

## Gate legs, each run separately

| leg | output | exit |
|---|---|---|
| `--filter @moe/benchmark test` | `Test Files 6 passed (6)` / `Tests 55 passed (55)` | 0 |
| positive control `@moe/coordination` | `Tests 42 passed (42)` | 0 |
| negative control, absent package | `No projects matched the filters` | **0** |
| `--filter @moe/benchmark typecheck` | no diagnostics | 0 |
| repo-wide `pnpm typecheck` | zero `error TS` | 0 |

Repo-wide is EXIT 0, so the path-attributed baseline is trivially empty — no foreign red.

## Commit hygiene

`f70786f`, explicit pathspec, 9 files. Untracked deliverables were `git add`ed FIRST —
a commit pathspec alone stages nothing untracked
(`mem:git-commit-pathspec-cannot-name-untracked-file`). `git show --name-only` filtered for
non-benchmark paths returns EMPTY. The tree also held a parallel session's work under
apps/daemon/src/evidence, packages/runner and tests/security — untouched.
`pnpm-lock.yaml` needed no change; its `packages/benchmark: {}` importer is already in HEAD.
`git status --porcelain -- packages/benchmark` EMPTY after commit, so committed bytes ARE
the gated bytes.

## For the next agent

Public surface unchanged: `projectBenchmarkRun(input: unknown)`. The new predicates are
**deliberately NOT exported from index.ts** — a consumer building a second admission path
from them would be the competing authority the boundary exists to prevent.

**Do not add scoring to this package.** Consumers, unchanged: **task-3a34adca** (corpus
freeze) then **task-8af4562f** (campaign).

Residual still open and NOT this task's: `projectUsage`'s `usage.ok` arm is unreachable
without an OBSERVED launch, so no real `NormalizedMeasurement` has reached durable bytes.
This harness projects that shape correctly from fixtures; nothing proves production emits it.
