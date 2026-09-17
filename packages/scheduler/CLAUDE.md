# @moe/scheduler

Five pure kernels that report facts and mint nothing: structural graph validation and
preview, caller-supplied lease fencing and resource reservation, conserved-budget
admission, the fairness contract families, and the graph-supersession dispositions. The
job only it does is to answer *whether a caller-supplied record and proof are internally
consistent* — no lease, token, epoch, slot, budget unit, child run or graph mutation is
created here. AGENTS.md still describes this package as "graph validation and
zero-authority structural preview"; that was true of the first third of it.

## Seams

- `exports` is exclusive: `{ ".": "./src/index.ts" }`. There are no subpaths, and
  `package-boundary.test.ts` scans every `.ts/.js/.tsx/.mjs/.astro/.vue/...` under
  `adapters/`, `apps/` and `packages/` for a specifier matching
  `@moe/scheduler/` or `scheduler/src/` and fails on any hit.
- The root is split for the 250-line source rule: `index.ts` holds graph/content/expansion,
  `execution-surface.ts` the authority + resource + budget + fairness families,
  `budget-ledger-surface.ts` the account ledger and settlement closure, and
  `node-authority/node-authority-public.ts` the v3 node codec. Curation lives in the export
  *specifiers*, not the file split — each block carries the rationale for what it withholds.
- ~125 files under `apps/daemon/src` import it. Representative callers:
  `graph-preview-request.ts` (`previewGraphSnapshot`), `work/work-claim.ts`
  (`reserveForAdmission` + `reserveProviderSlot`), `activation/activation-ingress.ts`
  (`activateProviderSlot`), `budget/budget-ledger.ts` (`openBudgetRoot`, `allocateToChild`,
  `returnToParent`, `closeSettledView`), `planning/active-graph-projection.ts`
  (`GraphRevisionContent`), `orchestrator/compiled-node-source.ts` (node-authority codec).
- Dependencies are exactly `@moe/context`, `@moe/contracts`, `@moe/core` and no
  devDependencies — `package-boundary.test.ts` asserts that list verbatim. The graph kernel
  (`validate-graph*`, `frontier*`, `analyze-graph`, `graph-*`) imports none of them.
  `@moe/context` is used by `convergence/` alone (`evaluateRetryUnlock`).
- `ExpansionPlanningHoldState` and `PlanningExpansionHoldBinding` are re-exported from
  `@moe/core` so a consumer completes the type closure from the bare specifier.

## The model

- **`readiness/`, `admission/`, `convergence/` and `dependencies/` are NOT on the root.**
  `projectReadiness`, `admitGraph`, `decideBreaker`, `validateDependencyContract` have no
  public export; they are reachable only through composers such as `admitExpansion`, which
  runs every pure check (evidence, lineage, graph admission, fairness, bypass count) before
  reserving anything. Their tests and the security lane import them by relative path.
- **Fencing is one function, one order.** `fenceAuthority(record, authority, commandKind,
  legalStates)` runs design line 749 in order — token, epoch, authority hash, session,
  version, state — and the first failing check decides the single code from
  `AUTHORITY_STALE_LEASE | AUTHORITY_STALE_EPOCH | AUTHORITY_SUPERSEDED_AUTHORITY |
  AUTHORITY_MALFORMED_INPUT`. A malformed *shape* is deliberately not a security event and
  carries no `RejectionSecurityRecord`; an authenticated, well-formed failure does.
- **Counter ceilings are refusals, not clamps.** `MAX_AUTHORITY_COUNT =
  Number.MAX_SAFE_INTEGER - 1_000_000` leaves headroom for version+1, epoch+1 and
  `+RENEWAL_WINDOW_SECONDS` (90, renewed at `RENEW_AFTER_SECONDS` 30). A lease already at
  the ceiling is refused as malformed, because a successor above it would never parse again
  and the lease could not even be revoked.
- **Provenance is a WeakSet, not a field.** `graph-provenance.ts` (unexported)
  registers every `ValidatedGraph` `validateGraphSnapshot` returns and binds each
  `FrontierPartition` to its graph; `registerFrontierPartition` throws
  `GRAPH_VALIDATION_PROVENANCE_INVALID` on an unregistered object. A hand-built object of
  the right shape is not a validated graph.
- **`snapshotIdentity` and `graphContentHash` are two values that must never be equated**
  (dec-64b2391c). `encodeGraphContent` is the only route to a `graphContentHash`, which
  covers all eight `GRAPH_REVISION_CONTENT_KEYS` at `GRAPH_CONTENT_SCHEMA_VERSION = 3`,
  including each node's admitted definition; `snapshotIdentityHash` is published separately
  and is structure-only. Foreign verdicts pass through `GraphContentIssue.code` unrestamped.
- **Limits live in exactly one place each.** `graph-policy.ts` owns
  `DEFAULT_MAX_NODES` 24 / `DEFAULT_MAX_HARD_EDGES` 64 / `DEFAULT_MAX_TOTAL_EDGES` 64 (a
  separate limit, never derived from the hard-edge cap), against the non-overridable
  ceilings 64 / 128 / 128 and `MAX_GRAPH_KEY_CODE_UNITS` 128; policy is resolved *before*
  the snapshot is read, and a malformed override returns `GRAPH_MALFORMED_POLICY`.
  Expansion's 3/6/9 (`maxExpansionDepth`/`maxChildWidth`/`maxNodesPerExpansion`) is a
  module-private `EXPANSION_LIMITS` in `admission/admission-records.ts`, composed by
  `admitExpansion` rather than redeclared.
- **`rotateOnce` is WDRR with banked state.** Order derives from `resourceId`, never array
  position; a non-servable head banks at most one round (deficit clamped to its weight).
  The caller must persist `outcome.ring` — `admitExpansion` consumes one outcome and does
  not return the ring, and a zero-counter ring rebuilt per call degrades to alphabetical
  priority, with `roundsAdvanced === 1` on every call as the tell.
- **Fairness validates, it does not schedule.** No exported function decides rotation order,
  deficit accounting or aging beyond `rotateOnce`/`ageWorkItem`; a bypass claim the caller
  cannot prove is refused, not admitted.

## Gotchas

- **Every non-test `.ts` here has a sibling one-line `.js` bridge** (`export * from
  "./x.ts";`). The three `test-fixtures.ts` deliberately have none — but
  `admission/admission-fixtures.ts` *does* have a bridge while importing `../test-fixtures.js`,
  so that chain is only loadable under vitest, never real Node.
- `scheduler-runtime-entrypoint.test.ts` spawns `scheduler-entrypoint-smoke-worker.mjs` in a
  worker with `--experimental-strip-types` and pins an exact result object (hash lengths 64,
  `contentIssueCodeCount: 10`, `contentKeyCount: 8`, refusal strings like
  `GRAPH_CONTENT_COMPLETION_DRIFT:GRAPH_CONTENT_IDENTITY`). It is the only witness to a
  missing or CRLF bridge, because vitest resolves `./x.js` back to `x.ts`.
- `index-surface.test.ts` hand-transcribes the whole root namespace and imports through the
  bare `@moe/scheduler` specifier. A removed export and an *unreviewed addition* both go red.
- `tests/security/boundary-roster.security.ts` pins `"packages/scheduler": 10` and names
  each layer roster with its file. Minting a new column-0 `export const *_LAYER(S)` here
  reds the security lane until that roster, `EXPECTED_ROSTER_SIZE` and the axis pin move in
  the same commit. `tests/security/layer-visibility-cases.ts` additionally pins *internal*
  constants by file (`GRAPH_LAYER`, `RECURSION_LAYER` in `node-authority-recursion.ts`,
  `SET_LAYER` in `supersession-dispositions.ts`).
- `package-boundary.test.ts` also forbids any `@moe/testkit` import in production sources
  and enumerates the roster before walking, with a hand-written floor of
  `MINIMUM_PRODUCTION_SOURCES_SCANNED = 60`; it tokenizes rather than greps, because three
  fairness files cite the testkit *path* in prose on purpose.
- `packages/runner/src/supervisor/effect-shape.ts` (`MIRRORED_LEASE_STATES`) and
  `materialization/dependency-witness-mirror.ts` are hand-written clones of this package's
  fence and dependency validator — runner cannot depend on it. They may only differ in the
  closed direction; the verdict-equality drift test lives in
  `apps/daemon/src/work/work-races.test.ts`.
- The authority vocabularies (`LEASE_STATES`, `LEASE_KINDS`, `DRAIN_REASONS`,
  `TRUTH_CLASSES`) are string-identical clones of the `@moe/contracts` runtime registry and
  are *not* exported from the root — only their types are. `SLOT_STATES` is the exception,
  and provider slots are deliberately absent from `LEASE_KINDS`.
- `tests/integration/release/release-version-surfaces.test.ts` pins this `package.json`;
  `tests/fault/foundation/foundation-harness.ts` funnels every fault-lane scheduler import
  through one `import * as scheduler` of `src/index.js`.

## Testing

- Whole package: `pnpm --filter @moe/scheduler test` — it is just
  `vitest run --root ../.. packages/scheduler/src`, i.e. the root config
  (`environment: "node"`, forks pool capped at 2–8 workers via `VITEST_MAX_WORKERS`).
- One file, from the repo root: `pnpm vitest run packages/scheduler/src/frontier.test.ts`.
  50 test files; there is no package-local vitest config and no README.
- Typecheck alone: `pnpm --filter @moe/scheduler typecheck`.
- `package-boundary.test.ts` walks three repository roots and carries a 30 s timeout — it is
  the slowest file here and it fails on a foreign package's import, not on yours.
- Outside coverage: `pnpm test:security` (`scheduler-activation-hostile-cases.ts` alone runs
  hostile arms against readiness, supersession, breaker, fairness and measurement),
  `tests/integration/expansion-protocol.test.ts` (the three-stage receipt → evidence →
  admission protocol), `tests/runtime/package-loadability.test.ts` (uses `@moe/scheduler` as
  the positive control for the real-Node probe), `tests/fault/**`, and the daemon suite
  `pnpm --filter @moe/daemon test`, which the root gate does not discover.
