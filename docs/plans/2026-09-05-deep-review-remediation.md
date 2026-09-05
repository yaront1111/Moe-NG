# Deep review remediation

**Goal:** Address the 5 September review with tested repairs and an explicit accounting of remaining delivery risks.
**Architecture:** Preserve the durable core. First quarantine ambiguous execution facts, correct live role instructions and retry handling, and remove unsupported UI success claims. Exact artifact delivery requires a separate end-to-end implementation rather than a label change.
**Tech stack:** TypeScript, pnpm, SQLite, Git, React, Vitest.

The review is pinned to `829c3bc0af969826d9a5c05ad5f4da6409475f52`. Initial checkout for this response was `df4a56a0` on `moe/work-2026-09-04`. This is a shared checkout with active foreign changes. Follow AGENTS.md: preserve them, stage explicit owned paths, and do not push or create sibling worktrees.

## Implemented

| Commit | Change | Behavioral evidence |
| --- | --- | --- |
| `a1ba4bd9` | Coding missions and spawner tool selection share `agent-role-contract.ts`. Coding seats are told to edit and test their assigned workspace; planning restrictions remain role-specific. | Regression first failed on the contradictory coding instruction. Existing tool selection and mission tests pass. |
| `0652669e` | Quarantine bare keys reused across current or historical goal/run pairs. Withhold colliding nodes, their dependent chain and ambiguous landing credit. Runs and coverage show `UNATTRIBUTABLE`. | Current collisions, terminal goals, successor runs, inherited acceptance, goal/run mismatch and unreadable history are covered. |
| `3a463a61` | A typed contained agent process failure permits another attempt after cleanup. Attempt limits remain; unknown, containment, observer and authority-cleanup failures remain fatal. Native wrapper and launcher imports have real Node probes. | Retry/bound/cleanup regressions plus native imports, missing-module and missing-export controls. Imports cannot launch a provider during the probes. |
| `f379edf4` | Failed PRD reads block creation until replacement or explicit removal. Removal/reset invalidates pending reads. Budget is labeled a request. Board and Runs require an exact landing SHA match to display Published. | File errors, replacement, removal, late reads, reset and later-unpublished-commit cases pass. |
| `00343005` | Push the captured SHA and confirm that exact remote branch before issuing a successful receipt. | A real local Git remote receives the captured commit even when HEAD advances immediately before push; missing, different and failed remote confirmations withhold success. |
| `7a10b955` | Reconcile exact packaging and version occurrence rosters with existing production code. | The node-spec reader and native bridge are recognized as production; bounded activation/fixture/scaffold version entries retain strict negative controls. |

The scheduler narrowing repair (`c8abeaa3`), rejected-planner input composition (`32e53bcf`) and tracked node-spec bridge were delivered by existing work during/before this session. Their source was preserved. The Git publication commit stages only its own hunk; the foreign exports of `LANDER_IDENTITY` and `landingEnvironment` remain outside that commit.

Identity quarantine is deliberately conservative. Legacy stores with execution-enabled goals whose sealed graphs cannot be recovered withhold compiled work pending attribution repair. Existing running attempts and operator-authored node-spec collisions remain outside the mitigation. Valid activated runs cannot mutate their sealed graph; revisions create successor runs. The temporary historical scan also adds read work and belongs in the later projection performance measurements.

Publication remains partly incomplete: the human decision does not yet bind its approval-time SHA. The fix binds push to the SHA captured at execution. An unconfirmed remote effect may already exist and needs reconciliation. The UI has no daemon ancestry proof, so unmatched ancestor landings remain Landed.

## Next critical change: repository ownership through landing

Repository serialization remains open. The production loop can verify and land while a child is still alive; `maxAgents = 1` alone cannot fix that. Another wrapper or a live orphan can also operate a different node in the same repository.

1. Resolve the canonical physical repository/checkout and acquire an atomic repository reservation before `agent-wrapper-main.ts` calls `lander.baseline`. Bind it to project, goal, graph revision, node, attempt and original baseline. Different project stores pointing at one repository need a shared filesystem/OS fence or a proven single coordinator.
2. Retain ownership through `RESERVED -> RUNNING -> PENDING_VERIFICATION -> PENDING_LANDING -> COMMITTED`. Child exit, claim expiry, a verifier receipt, Git index contention or a refused/unrecorded landing must not free the repository for a different node.
3. Route the normal and `--once` loops through one coordinator that proves child retirement before verification/landing. Reconcile live orphans and pending accepted landings on restart. Reuse original tracked/add/delete provenance for same-owner retries.
4. Prove this with real same-repository tests: three to five nodes, submission followed by more edits, simultaneous wrappers, workspace aliases, restart with a live orphan, and restart after acceptance before a committed landing. Immutable candidate trees and expected-parent landing are additional required evidence.

## Remaining acceptance gates

| Review finding | Required outcome |
| --- | --- |
| Scoped execution identity | Project, goal, graph revision and local node key identify claims, sessions, reviews, verification, landing, publication and recovery. Ambiguous historical records stay quarantined. |
| Owned, immutable artifacts | Isolated attempts or immutable candidate trees; explicit ownership; an integration queue; expected-parent commit; tests run against the exact landed tree. Retry provenance includes tracked edits, additions and deletions against the original base. |
| Integrated multi-node proof | Three to five nodes contribute to one repository without sweeping or omitting changes; restart mid-run and check every landing. |
| Criterion-specific evidence | Contract revision, criterion, check identity/version, executor, result and final integrated SHA accompany evidence. A generic green test command alone cannot establish product acceptance. |
| Fresh project and preview | Empty-folder setup reaches a ready repository and a real preview of the tested SHA; browser Gate 2 approves or rejects it. Existing bootstrap/preview tasks own their active implementation. |
| Publication and release | The approved exact commit is pushed and remote state confirmed; per-node ancestry is measured; release evidence matches approval and remote SHA; restart does not duplicate physical effects. Exact-SHA-only UI membership is a conservative interim display. |
| Foundation verification recovery | Resume durable ACTIVATED/intermediate state under the original command identity; reconcile interruptions before recording RECEIPTED. |
| Sustained reads | Measure long-running workloads, then introduce indexed incremental projections and checkpoints without changing replay truth. |
| Product composition | Connect the ordinary planning contract path, typed artifact handoffs, design, preview and release. Keep uncomposed helpers described as infrastructure. |
| Benchmark and release readiness | Real held-out PRDs, competent single-agent baseline, measured completion/intervention/defect/time/cost results; native entrypoints, browser journeys and Windows artifact checks. No benchmark or release success is inferred from scaffolding. |

## Verification and delivery record

Final focused checks ran after the implementation commits using the installed Vitest executable:

| Scope | Fresh result |
| --- | --- |
| Daemon role/spawner, retry, native entrypoints, identity, coverage/readiness, landing and publication | 18 files, 227 tests passed; exit 0 |
| Owned Control Room forms, PRD recovery, Board and Runs | 5 files, 56 tests passed; exit 0 |
| Packaging and release occurrence rosters | 2 files, 39 tests passed; exit 0 |

Commands, from their respective working directories:

```powershell
# apps/daemon
node ../../node_modules/vitest/vitest.mjs run --root . --config package.json --maxWorkers=2 --testTimeout=60000 src/orchestrator/agent-role-contract.test.ts src/orchestrator/agent-mission-text.test.ts src/orchestrator/agent-spawner.test.ts src/orchestrator/agent-spawn-environment.test.ts src/orchestrator/agent-wrapper-retry.test.ts src/orchestrator/agent-provider-pause.test.ts src/orchestrator/agent-wrapper.test.ts src/orchestrator/wrapper-entrypoint.test.ts src/orchestrator/compiled-node-identity.test.ts src/orchestrator/compiled-node-source.test.ts src/repository/goal-landing-facts.test.ts src/http/runs-read.test.ts src/http/document-coverage-read.test.ts src/goals/goal-close-readiness.test.ts src/repository/git-publication.test.ts src/repository/git-landing-port.test.ts src/orchestrator/node-publisher.test.ts src/repository/publish-ledger.test.ts
# apps/control-room
node ../../node_modules/vitest/vitest.mjs run --maxWorkers=2 src/v2/goals/new-goal-form.test.tsx src/v2/goals/new-goal-prd-recovery.test.tsx src/v2/board/board-columns.test.ts src/v2/board/board-screen.test.tsx src/v2/runs/runs-screen.test.tsx
# repository root
node node_modules/vitest/vitest.mjs run --maxWorkers=2 tests/integration/distribution/pack-artifact-sweep.test.ts tests/integration/release/release-version-surfaces.test.ts
```

The full advanced-branch baseline remains unverified:

- `pnpm typecheck` passed once after the initial UI fixture fixes landed. Later `pnpm verify:foundation` and `pnpm verify:store` stopped at a new foreign generated-client error: `deployment.deploy` was in the vocabulary but absent from `GeneratedCommandBuilders`. Their test stages did not run.
- The root and daemon broad runs ended with tool exit `-1` before aggregate summaries. The host had over 100 concurrent Vitest processes. A separate scratch-only multi-node case timed out before any daemon/identity code ran. Neither broad run is a pass.
- Daemon native bridge inventory independently reports unexpected foreign `repository/deployment/deployment-docker-probe.js` with no missing or incorrect bridge contents. Native wrapper/launcher smoke imports pass.
- The latest full UI run returned exit 1: 1,831 passed, 65 failed, 26 uncaught errors, amid ongoing foreign design, proxy and goal-creation edits. The owned 56-test group subsequently passed.
- Independent root failures remain in the legacy-import duplicate-code expectation and the compiled-product journey's premature `goal.close` expectation. The two packaging/version failures investigated here are repaired and their 39-test group passed again after commit.
- A later pnpm dependency preflight attempted installation and refused with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` while the shared lockfile was modified. Final focused checks used the existing runner without removing or reinstalling dependencies.

External session logs are under `C:/Users/Yaron/AppData/Local/Temp/`: `moe-review-20260905-focused-daemon-224549.log`, `moe-next-review-ui-owned-committed-20260905.log`, `moe-next-review-rosters-committed-20260905.log`, `moe-next-review-root-20260905.log`, `moe-review-20260905-daemon-222834.log`, `moe-next-review-control-room-20260905-ui-audit-final.log`, and `moe-next-review-foundation-20260905.log` / `moe-next-review-store-20260905.log`.

These are local commits on the shared advanced branch. No push, merge, release, paid-agent run or complete product demonstration was performed. All critical acceptance gates listed above remain explicit follow-up work.
