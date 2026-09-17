# @moe/core

The authority kernels. Every durable aggregate in moe-next — project, goal, planning run,
graph revision, cutover, expansion hold — has its decision table here, as a pure
`(state, command) -> accepted | refused` reducer, plus the content-addressed codecs that
turn plans, contracts, profiles and snapshots into digest-bearing bytes. Nothing in this
package does I/O, reads a clock, or touches the store: `apps/daemon` folds its ledger, calls
in, and commits what comes back. Its only dependency is `@moe/contracts`.

## Seams

- Root export map is exclusive: `"exports": { ".": "./src/index.ts" }`, one entry, no
  subpaths. `index.ts` (462 lines) is the whole published surface.
- **Reducers** `reduceProject`, `reduceGoal`, `reducePlanningRun`, `reduceGraphRevision`,
  `reduceCutover`, `reduceExpansionPlanningHold`, each beside its frozen `*_COMMAND_KINDS`
  and `*_TRANSITIONS` table. Callers: `apps/daemon/src/bootstrap/bootstrap-services.ts`,
  `goals/goal-services.ts`, `planning/graph-supersede-legs.ts`,
  `cutover/cutover-activate-service.ts`.
- **Approval authority** `decideApprovalAuthority` + `grantHumanAuthority`, read by
  `daemon-command-graph-approve.ts`, `daemon-command-graph-supersede.ts`,
  `planning/operator-review-authority.ts`, `recovery/recovery-completion-authority.ts`.
- **Policy** `evaluatePolicy`, `applyApprovalCommand`, `applyApprovalInvalidation`,
  `derivePolicySliceDigest`, re-exported through `policy/policy-public.ts`. Callers:
  `daemon/src/planning/run-policy-evaluation.ts`, `review/verifier-authority-provider.ts`,
  `release/release-auto-approval.ts`, `preview/preview-auto-decision.ts`,
  `packages/review/src/review-findings.ts`.
- **Replay** `replayGraphRevisionEvents` + `CORE_GRAPH_REVISION_REPLAY`
  (`daemon/src/planning/active-graph-projection.ts`, `graph-supersede-legs.ts`).
- **Supersession** `decideSupersession` / `SUPERSESSION_DISPOSITION_KINDS`, consumed by
  `daemon/src/planning/graph-supersede-service.ts` and mirrored in
  `packages/scheduler/src/supersession/supersession-disposition-contract.ts`.
- **Expansion** `prepareExpansion` / `approveExpansionManually` /
  `inspectPlanningExpansionContract` — `packages/scheduler/src/expansion/*` and
  `daemon/src/planning/expansion-admission-service.ts`.
- **Identity** curated in `identity/index.ts`: `authenticateSession`, `authenticateCommand`,
  `createSession`, `rotateCredential`, `matchCapability`.
- **Codecs**, all `create* / encode* / decode*Bytes / derive*Digest`: acceptance contract,
  plan revision, product contract `/1` and `/2`, source snapshot, project configuration
  manifest, delivery profile, capability catalog, execution isolation profile, verification
  recipe. `resolveQualifiedDeliveryProfile` is read by
  `daemon/src/delivery-v2/resolution-selection-reader.ts`.
- `snapshotProjectState` re-validates raw ledger `JsonValue` bytes —
  `daemon/src/work/foundation-dispatch-derivation.ts` and `daemon-context-seal-wiring.ts`
  call it rather than casting.

## The model

- **Refusals are values, never throws.** A reducer returns
  `{ ok: false, error: RuntimeError, layer }`; the codecs return
  `{ ok: false, code, layer }`. `goal/goal-results.ts` is the pattern: `illegal()` emits
  `ILLEGAL_TRANSITION`, `versionConflict()` emits `EXPECTED_VERSION_CONFLICT`, and every
  other validation failure collapses into `unknownFailure()` → `UNKNOWN_ERROR`. That
  flattening is deliberate — a caller learns *that* the command was inadmissible, not which
  field betrayed it.
- **`planning/planning-snapshot.ts` is the shared hostile-input floor** (41 importers across
  goal, project, policy, cutover and every codec). `snapshotData` / `snapshotDataBounded`
  reduce an input to inert data once — accessors, proxies, symbols, cycles and exotic
  prototypes are flattened or refused — and every later check reads only the snapshot.
  `exact`, `deepFreeze`, `validRef`, `validHex64`, `validExpectedVersion` come from here too.
  `policy/policy-validation.ts` is the second, smaller such module (10 importers).
- **Digests are domain-separated.** `createHash("sha256").update(DOMAIN, "utf8")
  .update(Uint8Array.of(0)).update(canonicalBytes)`, with the digest field zeroed to 64 `"0"`
  before hashing and the record re-admitted afterwards — see
  `source-snapshot/source-snapshot-codec.ts`. Every family names its own
  `*_DIGEST_DOMAIN` constant (e.g. `"moe-project-configuration-settings/1"`).
- **`/1` and `/2` are separate wire families.** `product-contract-v2-*` is exported beside
  `/1`, never through an alias or a decoder fallback that would grant old bytes the richer
  `/2` meaning.
- **The human-authority gate is consulted before the policy and short-circuits.**
  `decideApprovalAuthority` checks `request.gate` first; no `ApprovalPolicy` value approves
  gated work. `PROCEED_WITHOUT_HUMAN` must state `delayMs` explicitly — there is no default
  — and `approval-policy.ts` warns that a delay above 2^31-1 clamps to 1 ms in `setTimeout`,
  so the consumer bounds it, not core.
- **Curated, not complete.** `checkHumanAuthority`, `refuseApprovalAuthority`,
  `admitProductContractRevision` and expansion's `canonicalBytes` stay unexported on purpose:
  a consumer able to mint a refusal or recompute an identity could fork the authority these
  modules hold. Read the block comments in `index.ts` before promoting one.
- Per-area naming is a triple: `*-contract.ts` (types, frozen vocabularies, layer constants),
  `*-admission.ts` (unknown → admitted record), `*-codec.ts` (create/encode/decode/digest).

## Gotchas

- **Every runtime-reachable `.ts` needs a sibling one-line `.js` bridge** —
  `export * from "./thing.ts";`, LF, exactly those bytes.
  `src/runtime-entrypoint.test.ts` walks the import closure from `index.ts` in a real child
  Node (`--experimental-strip-types`, cwd = package root) and reports `missing` /
  `unexpected` / `wrongContent` **by name**; a CRLF bridge lands in `wrongContent` and
  `git diff --stat` will not show you why.
- The same test pins four modules that must never *gain* a bridge:
  `planning/graph-revision-test-fixtures.ts`, `planning-invariant-drivers.ts`,
  `planning-invariant-fixtures.ts`, `planning-run-test-fixtures.ts`. Two of them match no
  naming convention, which is why the audit keys on reachability, not on names.
- **`src/index-surface.test.ts` pins `EXPECTED_EXPORTS.length` to 255** and asserts exact
  set equality of the root namespace. Because `index.ts` uses `export *` for
  `delivery-profile-codec`, `capability-catalog-codec`, `capability-catalog-resolution`,
  `execution-isolation-profile-codec`, `verification-recipe-codec`, `policy-public` and
  `identity/index`, adding *any* export inside those modules reds this file. Its type block
  is a third guard: published `export type`s are invisible to the runtime count.
- **`tests/security/boundary-roster.security.ts` pins `"packages/core": 22`** exported
  `*_LAYER(S)` constants plus a per-constant roster with an `axis`. Exporting a new one is
  green under `pnpm --filter @moe/core test` *and* `pnpm typecheck`; only `pnpm test:security`
  sees it. Three core layer constants are deliberately module-private and enrolled in
  `tests/security/layer-visibility-cases.ts` — `CUTOVER_LAYER` (`cutover-reducer.ts`),
  `GATE_LAYER` (`approval-authority.ts`), `CODE_LAYERS` (`expansion-planning-hold.ts`);
  adding `export` to one moves both censuses.
- **`src/planning/` has a hard 250-physical-line ceiling** enforced by
  `planning-source-size.test.ts` with no allowlist and no self-exemption, across production,
  tests, fixtures and drivers alike. The sweep is non-recursive: only `src/planning/*.ts`.
  `src/index.ts` itself is an acknowledged exception to the repo's 400-line rail, which is
  why `policy/policy-public.ts` exists at all.
- `POLICY_SLICE_KEYS` (3) and `POLICY_CLASSIFIED_SLICE_KEYS` (4) are hand-mirrored by
  `apps/daemon/src/bootstrap/bootstrap-policy-authority-reader.ts:208` in two `exactObject`
  calls; the surface test asserts both directions and both cardinalities.
- `BUILT_IN_DELIVERY_PROFILE_REVISIONS` and `BUILT_IN_DELIVERY_PROFILE_QUALIFICATIONS` are
  **empty frozen arrays** on purpose — no profile ships qualified without durable operator
  and verifier authority. Do not "fill them in".
- `packages/core/package.json` must stay `"private": true` and carry the root version;
  `tests/integration/release/release-version-surfaces.test.ts` mutates this exact file to
  prove it.
- Core imports `node:crypto` and `node:util/types`, and its tsconfig sets `types: ["node"]`.
  It is not browser-loadable — that constraint belongs to `@moe/control-room-client`.

## Testing

- Whole package: `pnpm --filter @moe/core test` — its script is
  `vitest run --root ../.. packages/core/src`, i.e. the root config, same as `pnpm test`.
- One file, from the repo root: `pnpm vitest run packages/core/src/goal/goal-reducer.test.ts`.
- 66 `*.test.ts` files here. `planning-invariants.test.ts`, `goal-invariants.test.ts`,
  `policy-invariants.test.ts` and `project-invariants.test.ts` are seeded random-walk
  property suites driven by `planning-invariant-drivers.ts`; they assert determinism per seed
  and that no aggregate moves backward.
- Outside coverage: `pnpm test:security` deep-imports `packages/core/src/**` by relative path
  (`integrity-hostile-cases.ts`, `planning-graph-hostile-cases.ts`,
  `policy-slice-hostile-cases.ts`, `project-integrity-hostile-cases.ts`) — bypassing the
  exclusive export map on purpose, so a name unreachable from `index.ts` can still be
  hostile-tested. Also `tests/integration/expansion-protocol.test.ts`,
  `tests/property/schedule/schedule-coverage.test.ts`,
  `tests/fault/foundation/foundation-harness.ts`, and
  `tests/migration/cutover-live/live-quiesce-evidence.ts`, which mirrors the record shape
  defined in `cutover/cutover-quiesce-evidence.ts`.
