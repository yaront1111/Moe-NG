# Task task-05ce9b8f982f448a9cdaa4142a653f32 — planning blocked, no plan submitted

Blocked on 2026-08-09 by architect-5b5302ee after a design, board, memory, and disk audit. No repository files were edited and no implementation plan was submitted.

## Verified immutable inputs
- Rebuild design SHA-256: `1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191`.
- Benchmark SHA-256: `A62B90436CC0B911FB28526AF7B7E0F2D1370F6F93DB91C26077F6E2956A589C`.
- Audit HEAD: `7afa17d336f5598836de1dbc160879c9cbf3e52e`.
- The shared tree had foreign daemon/review/recovery WIP plus live .moe/.codex changes; none was touched.

## Why a plan would be false evidence
This is an acceptance/proof task whose DoD says every declared authority and external-effect boundary is covered. Design 19.1 and 20.3 require the production surfaces across HTTP/event stream, MCP stdio/Streamable HTTP, IDE, importer, human force paths, provider/effect protocols, and supported-host boundaries. Clause 2 forbids replacing absent production capability with a mock-backed test journey.

Fresh facts:
- `adapters/` is absent. Thin JetBrains adapter `task-9fd52b41f3ea4aad8c0c07bbe6fd3025` is BACKLOG.
- Distribution-manifest packaging `task-739879d0d1ce4a7ea4d1430688cdc4dc` is PLANNING.
- Codex runtime adapter `task-a0fa6da4024647d69c25d273b217eaeb` is REVIEW, not DONE.
- J3 restart composition `task-39fe2da5307d42beaa49365d89508503` and J4 durable review composition `task-9011e3b32c4149ca0d49f49fdfaaf08` are WORKING, so full-system crash/review boundaries are not frozen.
- Linux/macOS platform effect ports do not exist. The identical conformance gaps are recorded in `mem:task-task-e87a735386f643fe92c0eeff09bc4275-handoff` and `mem:task-task-e94b2055e281489ea9e97820919f6856-handoff`.
- Root `package.json` has neither `test:fault` nor `test:security`. That file is outside this task's owned `tests/security/**` and `tests/fault/**` paths, so the mandated verification command cannot exist honestly.
- Root `tests/**` is not covered by recursive typecheck. A lane must run its own `tsc -p`, per `mem:gotcha-tests-dir-typechecked-by-no-gate`.
- `tests/fault/foundation/**` already exists and belongs to the Foundation canary work, creating an unresolved ownership collision with this task's whole-tree claim.

The schedule-coverage prerequisite alone is satisfied: `task-1de468316a7f4b499aa39408ec240b88` is DONE at `444e034`. Its 36 obligations remain honestly UNKNOWN for `SCHEDULE_EVIDENCE_ABSENT` until real execution evidence exists.

## Required unblock
1. Land and QA-approve every production adapter/boundary this matrix claims to certify, including Codex, JetBrains/distribution, supported platform ports, and the J3/J4 composed daemon boundaries.
2. Create or amend a prerequisite that owns root `package.json` plus lane tsconfigs/config so `pnpm test:fault && pnpm test:security` both typecheck and execute their intended files.
3. Resolve `tests/fault/**` ownership overlaps with Foundation, portability, and disaster-restore tasks.
4. Arrange real supported-host execution where the claim is host-specific; off-host observations remain UNKNOWN.
5. Then re-plan from a production-derived boundary registry with non-vacuity floors, exact stable reason-code/layer assertions, explicit UNKNOWN/outside-scope rows, and mutation drills against production entry points. Do not generate or inspect confirmatory corpus bytes.

Moe `report_blocked` succeeded and paged governors.

## Expanded future SPIDR plan (added after human asked to plan more)

The governor subsequently confirmed the block and reassigned production-prerequisite authoring to architect-1721c07f; do not create duplicate tasks or re-open this proof task. A detailed conditional re-slice is recorded as Moe comment `comment-23b012bdcb76459a9ec51a53b8095fd5`.

Use four file-disjoint test slices after production prerequisites land:
1. `tests/security/transports/**`: daemon HTTP/event, MCP stdio/HTTP, control-room/IDE, importer and force authentication/replay parity.
2. `tests/security/integrity/**`: path/scope, junction/symlink/submodule/UNC/device/case, Git/argv/env, N/N+1 bounds, evidence/provider-closure/distribution tamper.
3. `tests/fault/store/**`: real SQLite transaction/WAL/checkpoint/corruption/lock and outbox/inbox/projection poison/replay.
4. `tests/fault/runtime/**`: dispatcher/supervisor/platform/provider/resource/budget/artifact before/after/race schedules.

A fifth prerequisite owns `package.json`, `tests/fault/tsconfig.json`, and `tests/security/tsconfig.json`, wiring shell-neutral strict typecheck plus Vitest for the exact gates. This parent task becomes the final integration/adversarial proof: production registry-to-case set equality, reason code AND layer, read-back zero mutation/effect/budget deltas, precise UNKNOWN/outside-scope rows, non-vacuity mutation, and exact `pnpm test:fault && pnpm test:security`.

Important measured detail: the schedule checker exports **10** abstract fault refs, not an exhaustive production boundary registry. A prerequisite must land a versioned production-derived boundary universe or explicitly compose all existing closed production registries; tests must not hand-author their own authority universe.

### Exact missing composition measured at HEAD 7afa17d
- Daemon `handleCommandRequest` uses injected `Authenticator`/`CommandDecisionPort` and is not root-exported or instantiated; core `authenticateCommand` has test-only consumers.
- Event stream has no auth/byte listener/real `SubscriptionPort`.
- MCP stdio has no daemon dispatch implementation; Streamable HTTP internals are not root-exported and have no daemon session/dispatch port.
- Importer has no authenticated daemon/store command composition.
- Control-room `main.tsx` mounts fixture state rather than `createDataAdapter`; no live credential/force dispatch.
- R3 force command vocabulary exists, but durable authenticated handlers and recent-step-up enforcement do not.
- Store `relayMessage` is internal and has no production consumer.
- Runner `activateEffect`/grant consumption lacks a dispatcher; launch lock touches no OS; `packages/runner/src/platform/` is absent.
- Claude/Codex adapters do not spawn/signal/pin processes; Codex was still REVIEW.
- Budget settlement/resource adapter confirmation and concrete artifact store edges have no production consumer.
- J3/J4 composition was in flight; JetBrains/distribution/platform prerequisites were not DONE.

Related durable decisions: `mem:decision-security-fault-matrix-requires-landed-boundaries`, `mem:decision-release-canary-requires-composed-production-authority`.

## Concrete child task blueprints (third planning pass)

Moe comment `comment-af7dd963f8a04d5ca7cddbb97d27e463` records mechanically checkable specs for:
- authority transport hostile schedules in `tests/security/transports/**`;
- integrity/scope hostile schedules in `tests/security/integrity/**`;
- durable SQLite/outbox fault schedules in `tests/fault/store/**`;
- runtime/provider/resource/budget/artifact schedules in `tests/fault/runtime/**`;
- an explicitly amended gate-lane task owning `package.json` plus lane tsconfigs.

Each evidence child is exactly three files (case manifest, test, tsconfig), has one focused typecheck+Vitest command, asserts registry non-vacuity/exact set equality, and pins reason code plus refusing layer. The eventual parent is two aggregate coverage tests and seven steps: prerequisite/hash freeze, security RED ratchet, fault RED ratchet, minimal wiring, production/case mutation drills, path-attributed baseline plus exact lane gate, exact frozen-commit evidence. Do not submit until every production shipping task ID exists and is DONE.

## Exact admission/case/oracle checklist (fourth handoff update)

Moe comment `comment-1191b80730f247e89f409fd8d94a36fa` makes the future plan mechanically executable:
- 14 admission probes require real consumer edges for daemon auth/event, MCP, import, control room/IDE, R3 force, store relay, effect/platform, providers, resources/budgets/artifacts, distribution/hosts, typed gate lanes, and a production-derived boundary universe.
- It names cheap non-test-reference greps for `authenticateCommand`, `handleCommandRequest`, `createHttpMcpAdapter`, `applyImport`, `createDataAdapter`, `relayMessage`, `activateEffect`, `consumeActivationGrant`, `createArtifactStore`, `adapterConfirm`, and `adapterFail`, plus platform-directory and plain-Node root probes.
- It defines the shared frozen case record: production boundary id, abstract schedule ref, entry point, fault class, BEFORE/AFTER/RACE, host applicability, REFUSED/UNKNOWN/OUTSIDE_SCOPE, exact code/layer, before/after/audit oracles, and shipping task id.
- It pins non-vacuity (registry/cases two-way equality, non-zero generated and executed counts, unique canonical identities), authoritative state/effect/resource/slot/budget/audit read-back, and per-child production mutation classes.
- Helpers may snapshot/invoke/compare only; they may not recompute authority.

The governor explicitly warned that an external unknown actor's PLANNING flip did not resolve the block (msg-a973ed5907cc4925943b8d7a6a67e885). Keep the task blocked until the admission checklist is true.

## Gate topology and production catalog correction

Moe comment `comment-62fa0d0f87034fce87884e7f6f3decbb` fixes two latent blueprint defects:
- new process/security/fault files use `*.security.ts` / `*.fault.ts` with dedicated Vitest configs, so they do not silently enter the ordinary root suite;
- fault-lane infrastructure (G0) lands first using existing Foundation tests, authority security creates a non-empty security config directly, and a one-file package-script task (G1) wires `test:security` afterward, avoiding a green empty gate and a platform/disaster dependency cycle.

It also records the dependency-preserving catalog design: contracts owns only the frozen descriptor codec; each production subsystem exports a local catalog beside its entry points; the signed distribution manifest binds installed component ids to catalog digests; final tests prove component↔catalog↔case equality. Governance task ids stay in evidence, not production bytes.

Parent coverage tests parse lane sources with the TypeScript AST to reject real skip/todo/skipIf/runIf calls (not comments), assert scanned/executed counts, and classify unreadable/aborted rows explicitly. Canonical identities exclude ids/timestamps/seeds and verbose evidence prints only digests/counts/classes, never credentials, provider output or physical paths.

## Fifth planning pass — prerequisite DAG reconciled at HEAD 1d95a02b

Moe comment `comment-116e874feb564773a29d3d5ad8879dbe` records the current dependency/status delta, corrected production-catalog topology, remaining production task blueprints, and the exact final admission artifact.

Newly verified:
- J3 `task-39fe2da...`, J4 `task-9011e3b...`, REVIEW_HANDLERS publication `task-f5d1dae...`, and Codex `task-a0fa6da...` are DONE.
- Distribution `task-739879...` is WORKING. JetBrains `task-9fd52...`, Linux platform observation `task-f01ef...`, and doctor runtime inventory `task-ba9e...` are BACKLOG. Linux/macOS conformance, fair scheduler, disaster restore and supply chain remain incomplete.
- Root scripts `test:fault` and `test:security` are still absent.
- Do not create duplicate lane tickets: `task-b5e9bd6444514d02a1e554420c0245b8` now owns isolated hostile-test lane infrastructure after package.json serialization.
- Do not duplicate the created restore chain: `task-5606947a` -> `task-684e6972` -> `task-b6e3dd2a` -> `task-8a01c025`, plus `task-0325dcf7`, `task-cf7fb147`, and `task-6f786c58`.

Catalog correction:
- `@moe/contracts` may define only the bounded descriptor/catalog codec and canonical bytes.
- Each real subsystem publishes a local frozen catalog derived from its actual public handler/factory/operation registry and locally proves exact set equality.
- Packaging computes/signs the aggregate SHA-256 digest and startup recomputes it before requests/effects.
- Final tests prove distribution component set = loaded catalog set = generated cases = executed results through public roots.
- Never place the whole-system authority universe in tests, testkit, or `tools/**`. Never put governance task IDs or a self-referential digest in descriptor rows.
- Hostile suites remain isolated as `*.security.ts` and `*.fault.ts` under dedicated Vitest configs.

Remaining blueprint families are: hardening descriptor contract; public/consumed store relay; outbox CAS + store facade + daemon dispatcher; runner platform/effect port + Windows adapter + daemon effect dispatcher; provider execution; durable resource/budget and concrete artifact service; authenticated daemon command and event/query composition; MCP daemon composition; import/cutover and R3 force; live loopback UI/IDE consumer; distribution digest binding; then existing lane task b5e9bd64.

Final replan must freeze a row-per-boundary table containing component/catalog digest, public root entry point, non-test consumer, DONE shipping task id, phases/fault classes, production code/layer source, host truth scope, evidence owner, and generated cases. Any empty cell, deep-import-only symbol, injected test port, or duplicate owner keeps the task blocked.


## Sixth planning pass — deterministic harness, public-root oracle, and mutation safety

Moe comments `comment-e8ff5b06a0414d9085289109854df425` and `comment-a0502fe7f8454e30bdbd38540e2e6240` make the eventual matrix executable.

New blocker verified at HEAD `174c07ba13e7940b0cdfc24c368084ebbb228c57`: the DONE schedule checker is not exported from `@moe/testkit`; `packages/testkit/src/index.ts` omits `schedule/**`. A <=5-file publication task must curate checker/model/obligation exports, add three runtime bridges, prove a plain-Node root import, and name task-05ce as consumer. The checker is completeness tooling only.

Oracle correction: production catalogs define the boundary universe, public subject/observation entry points, ordered stages, required phases/fault classes, and closed vocabularies. Exact expected code/layer/outcome/deltas are independently hand-authored from the pinned design/benchmark. Never derive expected behavior from the production subject/catalog being tested.

Planned test slices:
- security snapshot/delta/redaction harness under `tests/security/harness/**`;
- 5-file bounded subprocess H0 under `tests/fault/harness/**`;
- 4-file real SQLite/outbox F1 under `tests/fault/store/**`;
- 5-file composed runtime/provider/resource/budget/artifact F2 under `tests/fault/runtime/**`;
- two-file final parent under `tests/{security,fault}/system/**`, intentionally re-running all LOCAL drivers for a global executed-id ledger.

Schedules are canonical role DAGs. BEFORE, AFTER and RACE have explicit happens-before semantics; RACE exhaustively enumerates topological extensions and never samples/truncates. Fixed seeds can vary only irrelevant data. Each child and parent assert nonzero generated/started/completed exact-set equality, static child imports, digests, schedule hit evidence, and no skip/todo/conditional runner calls.

Snapshots use public reads for identity, durable state, authority, resources, budgets, effects, artifacts, import/cutover, events/UI and sanitized audit. UNOBSERVABLE forces UNKNOWN. Refusal defaults to zero authority delta except explicitly pinned audit/no-effect/replay-claim changes. Dual-fault cases pin the exact refusing source/stage/code/layer. Redaction plants nonzero canaries and checks raw/URL/base64 forms.

Fault workers use process.execPath/argv/shell:false, bounded NDJSON, an exact BOUNDARY_REACHED marker, real DBs/processes/platform adapters, public reopen/replay, and strict cleanup. Harness failures are FAIL, never product UNKNOWN. Off-host is NOT_OBSERVED/UNKNOWN; only host-malicious claims are OUTSIDE_SCOPE.

Evidence keeps assertion verdict, production truth and scope orthogonal, binds one source basis, lives only in auto-cleaned temp storage, and prints safe digests/counts with UNKNOWN/outside-scope separate. No confirmatory corpus access.

Mutation proof is a new admission condition: task-05 cannot edit unowned production files in the shared tree. Require either an isolated `@moe/testkit` mutation-runner consumer task or an explicit mutation-only scope amendment plus exclusive Moe leases. Compile/syntax/unrelated failures do not kill a mutant. Without one safe route the task remains blocked.


## Seventh planning pass — evidence federation, static shards, DoD/QA bar

Moe comments `comment-6a39659acac9436d8bc59365d77273c6` and `comment-79c56ae9de914df298f93338465ab5a8` add:

- One immutable basis vector for every local/delegated receipt: source commit/tree, pinned document hashes, distribution/catalog/case/config/package/lock digests, toolchain and exact command. Never stitch bases.
- Linux/macOS/disaster/supply-chain receipts are produced by their owner tasks on clean checkouts of the exact source commit, authenticated through an existing public evidence verifier, stored only in deterministic OS temp, and rejected whole on any mismatch. Missing required disaster/supply-chain evidence is red; explicitly permitted off-host evidence stays IN_SCOPE+UNKNOWN.
- Baseline capture occurs before edits; the final step reruns repo-wide gates, performs normalized path-attributed delta, checks commit/owned paths/no generated artifacts, then runs exactly `pnpm test:fault && pnpm test:security` last with no edits afterward.
- This task emits engineering `confirmatory:false` evidence only and never creates/views/seals confirmatory BENCH corpus bytes.

The fault matrix is re-SPIDR-sliced by responsibility: H0, S0-S2, R0-R6, then P. Provisional production-case floor is 154 (24 transaction/WAL, 24 outbox, 24 activation/process, 20 provider, 16 resource, 18 budget, 16 artifact stage, 12 artifact verify), recomputed/pinned from final catalogs and allowed to rise only. Split before approval above 5 files/8 steps/32 process cases/~300 test lines; never split/sample by seed/index/phase/platform condition.

Fault lane is serial and non-vacuous, with bounded process protocol/timeouts/output/cleanup. Focused children use recursive fault tsc plus configured exact-file Vitest; only the full exact command is completion evidence.

The comment includes mechanical assertions for all four DoD items, explicit `FAIL > UNKNOWN > PASS` claim aggregation, and pre-/post-implementation QA rejection checklists. OUTSIDE_SCOPE remains a separate design-anchored disposition; this engineering task licenses no public benchmark claim.


## Eighth planning pass — corrected board critical path, SECURITY SPIDR, and schema ratchets

Moe comments `comment-fdca93741fa2435ea0c08fed5ba78213` and `comment-77976bb4176842a39cc6d839d08e1eec` capture the latest read-only audit at HEAD `c5c46bb7f10ecf3e72f5bcd4b9869858a0fdaeda`.

Current status:
- Distribution packaging `task-739879d0d1ce4a7ea4d1430688cdc4dc` is DONE at `174c07b`, and complete backup generation `task-5606947a9d7d4f228dc63e6ce4dea69a` is DONE at `c5c46bb`.
- Root `package.json` still lacks `test:fault` and `test:security`.
- The hostile-lane task `task-b5e9bd6444514d02a1e554420c0245b8` is BACKLOG and is caught in a dependency cycle: it waits for supply-chain task `task-9449...`, while Linux/macOS conformance needs its `pnpm test:fault` script and supply-chain in turn needs those platform receipts. Correct ordering is distribution DONE -> b5e lane -> Linux/macOS proof -> supply-chain; supply-chain must preserve b5e's scripts.
- Doctor tasks `task-ba9e...` and `task-1caf...` duplicate recovery inventory/reporting scope. Keep one canonical implementation (prefer 1caf's stronger declared-vs-observed/component verdict design), carry ba9e's public `@moe/daemon` export and exact `DOCTOR_RUNTIME` code/layer requirements, and retire/hold the duplicate.
- Existing distribution is not yet the acceptance subject: it signs only daemon, control-room, MCP bridge, Claude and Codex; IDE is deliberately absent, distribution APIs are not package-root exports, and no hardening-catalog digest is bound/recomputed at startup.
- Still missing or incomplete: macOS production observation/classification, JetBrains's real consumer edge, publishable package/source-distribution subject, scheduler primitive/closure and durable resource-budget-artifact consumption, local production hardening catalogs plus signed aggregate binding, curated `@moe/testkit` schedule-checker publication, authenticated same-source delegated-receipt federation, and an isolated compile-valid mutation runner.
- Preserve the already-ticketed Foundation ingress/execution and disaster-restore chains; re-probe their public roots and non-test consumers after DONE rather than duplicating them. Production platform adapters and their `tests/fault/{linux,macos}/**` evidence owners must be split to remove prefix collisions.
- Task-05 remains BLOCKED and retains only the two final aggregate files after all prerequisite and shard tasks land.

SECURITY is statically SPIDR-sliced after lane infrastructure and a production freeze:
- S0 oracle/evidence support (5 files, no domain cases).
- S1 daemon HTTP/event floor 23; S2 MCP floor 31; S3 identity floor 26; S4 stale authority/replay floor 32; S5 import/cutover floor 34; S6 R3 force floor 35; S7 integrity/path/artifact/runtime closure floor 32; S8 evidence/distribution floor 30; S9 live control-room floor 26; S10 IDE floor 18.
- S11 owns only coverage/evidence/mutation closure and enforces a provisional lane floor of 287 semantic case identities. Floors may rise from final catalogs but never silently fall; each shard pins a literal case count and exact case-ID set/digest.
- Every shard verifies a frozen public-root subject plus a real non-test consumer, writes independent design/benchmark-derived expectations, executes BEFORE/AFTER/RACE against the production surface, captures public before/after state, asserts exact source/stage/layer/code and bounded deltas/redaction, then performs focused verification and a compile-valid named mutation kill in an isolated frozen-source copy.
- Final security and fault closure tasks prove pairwise-disjoint shard unions equal the signed production catalog partition, generated=started=terminal=expected>0, no hidden skip APIs, and no mutation survivor. The parent task's only completion evidence remains a fresh exact `pnpm test:fault && pnpm test:security`.

Evidence schemas are independently versioned: `moe-boundary-catalog/1`, `moe-hostile-case-manifest/1`, `moe-hostile-observation/1`, `moe-hostile-shard-receipt/1`, `moe-delegated-owner-receipt/1`, `moe-hostile-aggregate/1`, plus separate case-identity and canonical-JSON versions. Decoders require bounded exact-key null-prototype records, NFC strings, sorted unique IDs, lowercase full SHA-256, and frozen output. Unknown keys/versions fail closed; closed upcasters are diagnostic-only and cannot invent semantics or upgrade UNKNOWN. Shape, identity and canonicalizer changes have distinct bump/invalidation rules.

Drift is set-based and fail-closed: new production boundary -> coverage missing; removed expected boundary -> catalog missing; same ID with changed descriptor -> descriptor drift. Structural drift is FAIL, not UNKNOWN. Receipt freshness binds source/object format, pinned design and benchmark hashes, distribution/component catalogs/protocols, manifest/identity/canonicalizer/harness/code-registry versions, package/config/lock/toolchain/host facts, and exact command. Deterministic summaries contain only complete digests, counts, verdicts and sorted stable findings—never paths, PIDs, timestamps, secrets or raw provider bytes.


## Execution request after eighth pass

The human said “do it.” Live `moe.get_context` still showed the task `BLOCKED`, an empty implementation plan, and the governor’s Clause 2 block unchanged. Moe comment `comment-9d40148bcb6944cdb6c70e58e2d2a5ee` records that confirmation does not authorize a mock-backed or narrowed acceptance matrix. No plan was submitted and no implementation was dispatched; the prerequisite DAG must land and be verified on disk first.


## Board advancement after human request

On 2026-08-09 the human asked to move more tasks to PLANNING. A live dependency/ownership audit found exactly two unconditional safe promotions, and both were moved:
- `task-b6e3dd2af916490fb2bc4d375a530683` — Crash-safe two-slot recovery anchor installer.
- `task-0325dcf7ee744123b40cf583230c7b6a` — Node-side recovery-window inventory adapters.

Both depend only on DONE tasks `task-5606947a9d7d4f228dc63e6ce4dea69a` and `task-684e6972c8c1418f8996ea3edd61f00c`, own disjoint absent production modules, and have no live ownership overlap. Keep 8a01 BACKLOG until b6e and overlapping identity work are DONE; then cf7, then 6f78. Do not promote b5e by status alone: its stale rail still waits for 9449, forming the documented lane/supply-chain/platform cycle, and must be formally amended before promotion. No third unconditional move was safe.
