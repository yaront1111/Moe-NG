# PRD-to-product workspace: engineering companion

**Status:** Proposed architecture and migration, 2026-09-13. The product concept is accepted; the implementation choices and acceptance obligations here remain proposals. Companion to the [product proposal](2026-09-13-prd-to-product-workspace-proposal.md).

**Evidence:** Source inspected at `cb330a946312747499fe68812c6d9053546ea2d6`. No application changes, tests, browser journeys, or live actions were performed for this document. Source inspection establishes code paths and gaps; it does not establish runtime acceptance. Historical comments and roadmap claims are not substituted for current code.

**Final source-delta check:** Shared HEAD advanced to `1bf17ae5d971b473f75dea39821a6b03f9a3085b`; its only changes were `v2/ops/activation-port.ts` and its test, handling an already-installed policy during resumed activation. That improvement does not establish durable whole-workflow reconciliation. None of the cited identity/provenance/release/deployment source paths changed. Re-measure the baseline before creating implementation tasks.

## 1. Architecture decision

Replace the ordinary Control Room composition through working product journeys. Preserve the existing daemon, durable evidence, authenticated sessions, generated command builders, and human gates. Add explicit product identity and workflow authority only where the intended experience requires facts the engine does not currently record.

The product artifact is the persistent default canvas. The six output types in the production record are secondary inspection destinations, not six competing primary screens. The first usable workspace can use existing read services and command grants; it does not require a new database snapshot API, another permanent application shell, or a rewrite of the execution engine.

The dependency direction remains:

```text
Daemon readers and command authorities
    -> app-owned live read adapters and scope coordinator
    -> shared, pure product presentation model
    -> product workspace views

User decision -> app action adapter -> existing generated client -> daemon command
```

The shared model owns presentation decisions, never authentication, persistence, execution, or grant minting. Both the old and replacement views may consume it during migration.

## 2. Identity: what is one product?

### First slice

Use an explicit tuple of **authenticated server/project instance, project ID, and goal ID** for an existing product effort. Derive the display title from durable source/brief data. Keep the goal as the underlying subject without requiring the operator to understand that term.

The manager catalog's `instanceId` distinguishes local entries; project IDs alone are not globally unique. Its conflict checks cover instance, root, configuration and store paths, not project ID ([project-catalog.ts](../../apps/daemon/src/projects/project-catalog.ts), lines 17-20 and 145-152). Within an attached project tab, retain the authenticated origin/session binding; do not invent an instance ID if it was never supplied.

Never group work by matching title, PRD digest, repository SHA, or latest timestamp. Multiple goals may intentionally bind identical PRD bytes ([goal-document-binding.ts](../../apps/daemon/src/goals/goal-document-binding.ts), lines 49-61).

| Existing identity | Meaning to preserve |
|---|---|
| Goal ID and lifecycle | A body of work; completion is not proof of deployment |
| Goal generation and graph epoch | Successor-work and execution-authority counters; not product version numbers |
| Initial planning-run reference | Immutable initial selection; a rejection may create a successor run within the same goal |
| Contract ID, revision ID, digest, schema plane | The exact specification identity; approval attaches to that identity |
| Design version and compiled run | The design selected for that plan, which may differ from the latest authored design |
| Artifact SHA and receipt IDs | Concrete candidate, observation and decision identities; not inferred version lineage |
| Project/environment deployment decision | What an environment currently runs; not automatically the selected goal's product |

The current-run resolver already follows durable rejection events and carries an `unreadable` result ([current-planning-run.ts](../../apps/daemon/src/planning/current-planning-run.ts), lines 5-37). Preserve this distinction when showing an earlier readable run.

### Product continuity requires durable additions

Before offering later goals as versions of one product, introduce proposed records with explicit contracts:

- **Product:** stable product ID, project/repository binding, title, lifecycle and concurrency version.
- **ProductRevision:** stable revision ID, predecessor revision, change/source references and explicit build-goal membership.
- **Revision manifest:** exact approved contract, compiled plan/design selection, candidate artifact and applicable preview/release receipts.
- **Current selections:** separately fenced pointers to active work and delivered revisions; environment deployment remains its own fact.

Start with one active build goal per product revision. Multiple contributing goals require an explicit definition of combined acceptance and release scope. Source equality cannot supply that definition.

V2 currently enforces a bidirectional one-goal/one-contract-ID binding ([product-contract-v2-goal-binding-leg.ts](../../apps/daemon/src/product-contract/product-contract-v2-goal-binding-leg.ts), lines 35-72). Preserve it initially: a successor goal gets its own contract identity, while new product records express cross-goal continuity. Reusing one continuing contract ID across goals requires a separately reviewed authority migration.

Core has `goal.reopen_as_revision`, which leaves the old goal terminal and returns a successor with predecessor/generation metadata ([goal-reducer.ts](../../packages/core/src/goal/goal-reducer.ts), lines 165-185). No daemon wiring for that command was found in this inspection. The current browser replan uses ordinary goal creation and puts predecessor information in prose ([replan-successor-port.ts](../../apps/control-room/src/v2/approvals/replan-successor-port.ts), lines 76-107). Neither a generated vocabulary entry nor that prose establishes a durable successor workflow.

A new successor operation must atomically establish discoverable goal creation, source binding, predecessor/product membership, and concurrency fences. Existing catalog decoding admits exact `GoalCreated` shapes; avoid silently extending old event bytes with unrelated metadata.

Adoption of existing work needs an explicit, idempotent mapping into Product/ProductRevision records. Preserve original goal/event/receipt identities; do not backfill predecessor links from prose or shared source digests. Work with missing source or membership remains accessible with that limitation. Removing an old view must not delete its records or silently convert them into a different authority model.

### Scope changes are separate from current execution

Keep distinct references for proposed specification, current approved specification, scope sealed into the running plan, inspected candidate, and delivered artifact.

The V1 proposal service refuses parent lineage ([product-contract-propose-service.ts](../../apps/daemon/src/product-contract/product-contract-propose-service.ts), lines 139-147). V2 has revision lineage/current slots and clears the effective Gate 1 reference when a revision advances ([product-contract-v2-workflow-transition.ts](../../apps/daemon/src/product-contract/product-contract-v2-workflow-transition.ts), lines 81-107). This does not rewrite an existing compiled plan's contract/design binding.

The amendment workflow must state how approved changes transition active work. A new specification must never silently relabel old evidence, restart execution, or inherit approval from another revision.

## 3. Live reads, scope and freshness

### App-owned coordinator first

Move data acquisition out of mounted panels into a coordinator scoped by authenticated connection, authority plane, project and selected goal. Inventory existing feeds before consolidating them; retain their decoders and cancellation behavior.

For each source retain `LOADING`, `PRESENT`, `ABSENT`, `REFUSED`, `UNREADABLE` or `STALE` as applicable, its subject identity, observation time, and source-provided version/digest. Distinguish the daemon's states from locally detected transport/read failures. Never keep a previous subject's data visible as the next subject's answer.

The coordinator should:

1. Share overlapping reads and invalidate dependent selections after a known write.
2. Discard late responses from a prior connection, project, goal or authority plane.
3. Preserve selected artifact, focus and scroll when newer facts arrive; notify about a new artifact without switching the canvas automatically.
4. Join only matching contract/run/design/artifact references; expose unresolved joins explicitly.
5. Keep an older readable artifact identifiable while marking its current applicability unknown.
6. Clear or revalidate command offers independently of preserved historical display data.

Requirements and Readiness use the viewed artifact's approved scope. Proposed changes remain a separate comparison, and current work does not silently replace the version being inspected. Feedback records both its origin artifact and intended repair target; defect/scope classification uses that target's approved scope.

Multiple HTTP answers are independent observations. Do not describe their combination as an atomic snapshot. Start with explicit source states and checked joins. If a later summary needs one authoritative cross-source answer, add a bounded daemon projection using existing readers and a defined consistency contract then.

Existing read seams:

| Source | Read boundary | Join caution |
|---|---|---|
| Goal inventory | `/goals/read` | Drain pinned pagination; catalog is identity, not lifecycle or acceptance |
| Original source | `/goals/source/read` with goal reference | Re-proves source bytes against the stored binding |
| Requirements/evidence | `/documents/coverage/read` | Goal-selected criteria are scoped, but `goals[]`/`totals.goals` include other goals sharing the PRD |
| Current V2 contract | `/v2/product-contract/current` | Explicit V2 activation and contract ID; returns revision and current slot |
| Plan | `/planning/run/read` | Resolve current run; preserve exact sealed submission/approval identity |
| Design | `/design/read` with planning-run reference | Reads the plan-selected version; do not substitute latest design |
| Preview | `/preview/read` | Receipt is an observation; current code does not establish exact running-byte provenance |
| Release | `/release/read` | Evidence is measured against the goal's publication SHA; absent is not unreadable |
| Environment | `/deployments/read` | Goal-specific publishable SHA plus project-wide current environment receipts |
| Actions | `/affordances/read` | Offers belong to the authenticated session and exact target/version/schema |

The mixed coverage scope is explicit in [document-coverage-read.ts](../../apps/daemon/src/http/document-coverage-read.ts), lines 238-299. The environment distinction is explicit in [goal-deployment-read.ts](../../apps/daemon/src/http/goal-deployment-read.ts), lines 37-67. Match selected SHA and release identity before asserting that the inspected candidate is deployed.

Use complete reference keys: contract plane/ID/revision/digest; run ID and sealed graph/submission hashes; selected design version; artifact SHA; preview/release/deployment receipt IDs. Keep mutable slot/workflow/goal/environment generations apart. Local request sequencing is useful for discarding late responses; it is not a durable artifact version.

An event horizon alone cannot prove freshness: session/grant expiry and external runtime health can change without the relevant business event advancing. External observations need their own freshness and provenance. Do not hold a database transaction across Git, browser, process or network operations.

### Pure presentation model

Proposed focused modules under `packages/control-room-model/src/product-workspace/`:

- `contracts.ts`: immutable, versioned input/output shapes and explicit unavailable states.
- `identity.ts`: reference comparison and subject compatibility.
- `artifact-selection.ts`: available artifacts, user selection and historical/current applicability.
- `requirement-links.ts`: explicit recorded relationships and missing-link presentation.
- `readiness.ts`: applicable checks and blockers with named denominators.
- `workspace-model.ts`: compose stage, artifact, requirement and readiness views.

These are proposed responsibilities, not existing APIs. Keep modules focused under repository source-size rails. Shared code must not import `apps/control-room` types, React hooks, daemon services, fetch, browser globals or credentials. App adapters convert existing decoder outcomes into these contracts. New common wire contracts belong in `packages/contracts` only when there is an actual cross-package transport need.

Advisory interpretation and suggested links remain explicitly advisory and carry no command affordance. Readiness presentation never manufactures a grant. Existing truth descriptors remain available without requiring their technical vocabulary in ordinary product labels.

## 4. Actions and routes

Reuse [offer-wire.ts](../../apps/control-room/src/v2/approvals/offer-wire.ts), generated client builders, compatibility checks and existing command transport. Keep grant target, expected version, schema and request identity intact. Preserve daemon refusal code, layer and useful detail behind a plain-language explanation.

Model submitting, accepted/awaiting durable readback, refused, and outcome unknown separately. A transport timeout is not evidence of no effect. Reconcile through a durable operation/command identity before presenting a safe retry; add a daemon read/workflow if an existing action cannot be reconciled. Do not replace this with optimistic stage completion.

Keep V1 and V2 authority planes explicit in connection and model inputs. Select readers and builders from the daemon's bootstrap plane, as the current composition does. Do not union both sets of offers, reinterpret a V1 grant as V2, or infer activation from the UI build.

Use non-secret query state for direct links, stage selection and Back/Forward. [entry-route.ts](../../apps/control-room/src/entry-route.ts), lines 1-14, strips only development selectors in production and preserves other queries. [main.tsx](../../apps/control-room/src/main.tsx), lines 160-168, scrubs URL fragments, so hash routing conflicts with the current entry contract.

Define and validate the new query vocabulary; do not put credentials or authority in it. Resolve a linked subject against the authenticated project catalog. Unknown or cross-project references must explain that they cannot be opened rather than falling back to the first goal. Preserve project-manager route precedence and development-fixture fences.

## 5. Capability and source matrix

This matrix records source-inspected capability, not a runtime pass. Gaps are delivery obligations before making the corresponding product promise.

| Capability | Existing support | Missing obligation or limit |
|---|---|---|
| PRD to requirement provenance | Stored source digests and immutable contract requirements/criteria | Source-passage-to-requirement mapping is new; whole-document citation cannot highlight an exact passage |
| Requirement to implementation | Compiled contract/graph/node criterion bindings | Scope every link by complete contract/run/node identity; local node keys are not globally unique |
| Criterion verification | Integrated-artifact-specific criterion receipts | Passing a node test alone does not prove a product criterion |
| Design inspection | Versioned text describing journeys/screens/states; plan pins `designVersion` | No durable requirement-to-screen artifact IDs or captured region anchors yet |
| Requirement into preview | Preview receipt includes journeys and capture paths | Exact feature locations, artifact hashes and applicable source links need new records |
| Preview of requested SHA | Start carries a SHA and uses daemon-configured workspace | Inspected path runs mutable workspace without checkout/HEAD equality proving those running bytes |
| Reopen an accepted preview | Supervisor holds live process handles; durable receipts survive | Approval and rejection stop the process; artifact/decision identity must be separated from runtime availability and any authorized restart |
| Preview approval before release | Preview decision can appear in dossier | Dossier preview shape lacks SHA; release service does not enforce an approved matching preview |
| Release evidence | Criterion dossier, publication SHA, release receipt/PR evidence | Keep missing evidence visible; do not claim the preview gate is enforced by the dossier alone |
| Release before deployment | Deploy receipt can cite release decision | Citation is optional in current service; required linkage needs an explicit deployment policy/authority gate |
| Browser human decisions | Gate-specific paired-human support; release supports durable HUMAN with ADMIN | Preview start/decide and deploy retain configured-operator restrictions; settle explicit authority policy per command |
| Successive product versions | Goals, contract revisions and limited core successor primitive | Durable Product/ProductRevision membership and shipped successor workflow are new |
| V2 full product journey | Richer V2 contracts, current slot/workflow and compiler work exist | Inspected design/criterion/release path still includes V1 readers/bindings; do not claim V2 end-to-end composition |

Key evidence:

- [compiled-contract-binding.ts](../../apps/daemon/src/planning/compiled-contract-binding.ts), lines 8-18 and 58-84: exact plan/contract/design joins.
- [criterion-goal.ts](../../apps/daemon/src/criterion-evidence/criterion-goal.ts), lines 25-35: inspected criterion path reads compiled binding and V1 revision reader.
- [design-contracts.ts](../../apps/daemon/src/design/design-contracts.ts), lines 63-66 and 101-119: screen/journey text shapes without requirement artifact anchors.
- [preview-start-command.ts](../../apps/daemon/src/preview/preview-start-command.ts), lines 94-105 and 145; [preview-runner.ts](../../apps/daemon/src/preview/preview-runner.ts), lines 153-179: supplied SHA plus configured workspace execution.
- [preview-receipt-contracts.ts](../../apps/daemon/src/preview/preview-receipt-contracts.ts), lines 51-67: screenshot path/journey metadata without content digest.
- [preview-supervisor.ts](../../apps/daemon/src/preview/preview-supervisor.ts), the `decide` handler: either verdict forgets the live entry and stops its process. A stored STARTED receipt is not current runtime-health evidence.
- [release-dossier-contracts.ts](../../apps/daemon/src/release/release-dossier-contracts.ts), lines 91-98; [release-decide-service.ts](../../apps/daemon/src/release/release-decide-service.ts), lines 155-182: preview representation and release admission seam.
- [deploy-service.ts](../../apps/daemon/src/deployment/deploy-service.ts), lines 234-240: optional release citation; [deploy-command.ts](../../apps/daemon/src/deployment/deploy-command.ts), line 237: configured-operator fence.
- [daemon-command-registry.ts](../../apps/daemon/src/daemon-command-registry.ts), lines 391-414, and [release-decide-command.ts](../../apps/daemon/src/release/release-decide-command.ts), lines 65-86: different human-admission policies.

The old preview aggregate/receipt-ID submission defect is already corrected in [preview-port.ts](../../apps/control-room/src/v2/approvals/preview-port.ts), lines 61-89. Do not schedule it again from stale roadmap prose.

## 6. Dependency-ordered work packages

Areas below are proposed task ownership boundaries, not permission to edit every listed directory. Re-measure HEAD/WIP and assign exact paths before each implementation task. Read current repository instructions; preserve foreign work and do not create sibling worktrees.

| Package | Depends on | Proposed owned areas | Red case first; required green behavior |
|---|---|---|---|
| W0: interaction proof and source inventory | Product proposal | Product-state fixtures and focused prototype files; documentation | Users confuse source/design/preview/delivery; revised artifact views distinguish them and satisfy formative P1-P4/P11 |
| W1: read coordinator and scope contracts | W0 inventory | `apps/control-room/src/live/`, focused new workspace adapters; relevant feed callers | Delayed answer from another goal/session or mismatched contract/run; discard or expose unavailable join, never borrow another subject's facts |
| W2: pure product model | W1 contracts | `packages/control-room-model/src/product-workspace/`, app conversion adapters | Same PRD/two goals, proposed contract versus compiled contract, other goal deployed; correct separate identities and applicability, stable user selection |
| W3: first live workspace and query routes | W1-W2 | `apps/control-room/src/v2/` workspace views/shell composition, `entry-route` integration, browser specs | Pending contract/source canvas loses revision context; approve its exact revision on one verified plane, recover durable result after refresh, refuse stale grant |
| W4: preview and delivery authority prerequisites | W0 source audit; can proceed beside W1-W3 with disjoint ownership | Focused `apps/daemon/src/preview/`, `release/`, `deployment/`, corresponding contracts/readers | Workspace differs from requested SHA; approve preview A then release B; missing/wrong release for deploy; required refusals at named layers before effects |
| W5: complete first-product workflow | W3-W4 and settled per-command human policy | Product creation/setup adapters, bounded daemon workflow/action reconciliation, feedback/review seams | Lost response/reload between steps, rejected preview without repair, paired human unable to act; durable recoverable outcomes and real authorized browser journey |
| W6: product continuity and catalog | W2/W5 scope semantics | New focused product contracts/store/services; project-manager authorized summary/index; version views | Two requests create duplicate successors or a goal inherits unrelated approval; atomically linked revisions, explicit membership, preserved delivered result |
| W7: migration completion | W3-W6 accepted | Superseded ordinary views/pollers, advanced navigation and relevant tests | Old and new views disagree or require hidden technical panels to keep polling; one ordinary product flow, useful advanced inspection, removed duplicate derivation |

W4 requires decisions about intended release/deployment requirements and human authority. Do not weaken existing operator/MCP fences to make a browser test pass. Any admitted paired-human path needs positive human tests and negative agent/wrong-capability/stale-subject tests.

For the preview provenance obligation, bind execution to an immutable extraction or other measured exact source selection, then bind captures and verdict to that candidate. A receipt carrying the requested SHA is insufficient. For release/deploy chaining, enforce policy in the daemon and assert the exact refusing code/layer as well as absence of effects. New refusal vocabulary must be designed and registered through existing boundary conventions.

Include preview-runtime reconciliation in W5 and legacy-work adoption in W6. A reopened preview must identify the exact artifact and a currently measured runtime session without borrowing authority from an earlier process receipt. Restarting or reconnecting runtime does not create a fresh human verdict, nor does a historical verdict prove the new process's bytes.

## 7. Verification plan

These commands are future implementation gates, not results of this documentation task. Run the narrowest affected tests while developing; each behavior change should show its meaningful failing case, passing fix and refactor. Extend existing tests only when they exercise the changed contract; do not treat a historical lane as proof of a newly added obligation.

Package gates from current manifests:

```powershell
pnpm --filter @moe/control-room-model test
pnpm --filter @moe/control-room-model typecheck
pnpm --filter @moe/control-room test
pnpm --filter @moe/control-room typecheck
pnpm --filter @moe/control-room build
pnpm --filter @moe/daemon test
```

Focused existing browser regressions, with the browser TypeScript check included:

```powershell
pnpm exec tsc -p tests/e2e/control-room/tsconfig.json
pnpm exec playwright test -c tests/e2e/control-room/playwright.config.ts prd-persistence-boundary.spec.ts gate1-v1-approval.spec.ts preview-approve-live.spec.ts preview-reject-live.spec.ts release-approval.spec.ts new-product-from-prd.spec.ts
```

Add workspace-specific browser specs for direct links, selection persistence, scope isolation, wrong-version decisions and interrupted operations. Existing preview live specs contain configured-operator assistance/refusal assertions; they must be extended when proving a shipped paired-browser path. Fixture or injected-provider lanes do not establish real GitHub, Docker, preview-source or deployment acceptance.

Required repository delivery gates remain `pnpm typecheck`, `pnpm test`, `pnpm verify:foundation`, `pnpm verify:store`, and `pnpm --filter @moe/daemon test` under [AGENTS.md](../../AGENTS.md). Root tests exclude `apps/**`; record nonzero package test counts and exit codes. Full browser gate is `pnpm test:e2e:browser`. Add `pnpm test:security` for changed authority boundaries and relevant fault tests when durable workflow/recovery changes require them.

Use [live-proof-prd.spec.ts](../../tests/e2e/control-room/live-proof-prd.spec.ts) and existing release/deploy helpers as integration seams, after inspecting their current prerequisites and substitutions. For final product acceptance, prove the selected human session and actual delivery boundary; report skipped opt-in/network/daemon legs explicitly.

## 8. First usable slice and full completion

**First usable slice:** Open one existing source-bound goal with a pending Product Contract decision, on one explicitly verified authority plane. Its actual proposed definition occupies the canvas, with the original source available for inspection. Approve that exact revision through an existing permitted human path; observe the durable approval after refresh. An older tab must retain its review context and receive the exact stale-grant refusal rather than approving newer bytes. No hidden board component is needed to keep reads active. Direct links, Back, keyboard use and 390px layout work.

This slice demonstrates the product organizing model; it does not claim the whole refactor or an enforced preview-to-release-to-deploy chain is complete.

**Full completion requires all of the following:**

- The product proposal's P1-P12 criteria have recorded evidence, including novice observation rather than developer judgment alone.
- Creation/setup, definition/design decisions, build, applicable checks, preview/rework, release/deployment and return visits compose through shipped authorized paths.
- Preview execution/captures/verdict identify the actual candidate; release/deployment enforce the agreed exact-version requirements before effects.
- Lost responses, repeated clicks, two tabs, stale grants and restarts reconcile durably without false success, false refusal or blind retry.
- Product revision membership is durable; current work, proposed changes, historical evidence and delivered/environment versions remain distinct.
- V1 and V2 support is reported per capability; each claimed supported plane has its own composed journey evidence.
- The ordinary product flow replaces superseded composition and duplicate read/state derivation; advanced inspection remains useful and reachable.
- Required package/repository/browser gates pass on delivered task-owned bytes; any unavailable external acceptance is disclosed and remains outstanding.

The main uncertainty is workflow authority and source provenance, not component styling. Source inspection found real gaps in those seams. Implementing the workspace must make those gaps understandable immediately and close them before promising a fully governed PRD-to-deployed-product journey.
