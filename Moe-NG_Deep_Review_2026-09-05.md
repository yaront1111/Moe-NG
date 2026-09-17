# Moe-NG: architecture, execution and product readiness review

Review date: 5 September 2026.

**Verdict:** Moe-NG has a substantial supervised software-building engine. The advanced branch materially improves the real workflow. It is not yet a reliable autonomous PRD-to-product system: attribution, exact-artifact verification, recovery, and the final product journey remain incomplete. I would use it for carefully supervised development experiments after repairing the current integration failures. I would not yet delegate unattended delivery or sell a general autonomous software-company promise.

This review covers the newer branch the owner highlighted, not just the default branch.

| Reviewed state | Exact commit | Observed status |
|---|---|---|
| Advanced branch, moe/work-2026-09-04 | 829c3bc0af969826d9a5c05ad5f4da6409475f52 | Cross-host CI fails; fresh local typecheck and native wrapper import also fail |
| Default branch, main | 0a52f5731e47f05427bcde12d6f2f9126ff92dbe | All eight cross-host jobs succeeded |

GitHub comparison reports the advanced branch 261 commits ahead and 13 behind main. These are ancestry counts, including work checkpoints, not a feature count. Its snapshot changes 540 files versus main, including 397 app/package files. The review is pinned to these commits; later changes are outside its conclusions.

**Evidence and limits**

I inspected production wiring and source across the daemon, compiler, scheduler, store, agent wrapper, verification, landing/publishing, control room, tests and release workflows. Static findings below describe traced code paths; they are not claims that I observed every failure in a live run.

Fresh local checks used Node 24.19.0 and the repository-pinned pnpm 11.0.8. Frozen dependency installation succeeded with lifecycle scripts disabled. Typecheck failed with TS18046. Focused wrapper/mission/node-spec tests produced 46 passes and one failure. A native import of the wrapper using the documented experimental type-transform flag failed with ERR_MODULE_NOT_FOUND for node-spec-listing.js. No provider was launched by this import.

I did not run the complete suite locally, launch paid agents, operate a live user project, render the UI, validate a Windows artifact, change repository source, push commits, or reproduce security exploits. Existing CI results and repository-recorded live experiments are explicitly distinguished from fresh local observations.

[Main CI](https://github.com/yaront1111/Moe-NG/actions/runs/33960950306) · [Advanced-branch CI](https://github.com/yaront1111/Moe-NG/actions/runs/33984635359)

**1. What the advanced branch actually adds**

The newest implementation deserves credit for changes an older review would miss.

| Capability | Current assessment |
|---|---|
| PRD ingestion and approved contract | A real supervised flow exists |
| Whole multi-node decomposition | Implemented; the earlier one-node initial-plan restriction is removed |
| Dependency-aware staffing | Implemented in the live wrapper |
| Concurrent independent nodes | Exercised in a recorded live experiment |
| Browser activation | Newly wired; empty-folder onboarding still has missing setup |
| Goal closure from coverage | Newly enforced on the command side as well as offered actions |
| Plan rejection and successor runs | Meaningful new plumbing; rejection feedback still does not reach the planner prompt |
| Provider rate-limit handling | Durable pauses and operator visibility are present |
| Design records, richer contracts, scaffolding and release dossiers | Substantial components exist; several are outside the default end-to-end path |
| Working preview and release approval | Still incomplete; the preview command is an explicit stub |

The active README records a real Claude planning seat producing a five-node DAG, human plan approval and parallel staffing. It also records only two successful landings and three NOTHING_TO_COMMIT refusals. That is useful operational evidence of both progress and the remaining failure. I did not rerun that experiment. [Live experiment disclosure](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/README.md#L116)

**2. Critical correctness issue: the node identity is not scoped to its goal**

Severity: P1. Confidence: high from static tracing. Present on main and the advanced branch.

The compiler preserves the planner's nodeKey. Uniqueness is enforced within a graph, but the runtime collects nodes from multiple active goals and deduplicates them using the bare key. The resulting key is also the nodeRef used by execution and review.

Two unrelated plans using a common name such as “api” are therefore not reliably distinct execution subjects. One goal can lose its independently intended work to deduplication, and acceptance or landing facts can be shared across goals.

This is not merely a theoretical interpretation: the Runs projection explicitly recognizes shared keys and labels them UNATTRIBUTABLE, while the execution source still deduplicates them. The landing-to-goal reader explicitly credits a shared key's committed landing to every goal owning that key. Coverage does detect ambiguity, which can prevent closure; it does not repair execution identity.

**Fix:** use an execution identity containing project, goal, graph revision and node key everywhere: claims, sessions, review, verifier receipts, landings, publication and recovery. Keep nodeKey only as the local graph identifier/display name. Refuse ambiguous historical records conservatively until attribution is repaired.

[Compiler node construction](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/planning/compile-dispatcher.ts#L236) · [Cross-goal deduplication](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/compiled-node-source.ts#L119) · [UI ambiguity handling](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/http/runs-read.ts#L115) · [Shared landing attribution](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/repository/goal-landing-facts.ts#L31)

**3. Critical correctness issue: parallel agents do not preserve ownership of their changes**

Severity: P1. Confidence: high; static code plus a repository-recorded live failure. Present on both branches, now more consequential with whole-graph execution.

Compiled missions all receive the same workspace. The default wrapper concurrency is two. The lander compares the current workspace's dirty files against the baseline recorded when a node was staffed; every differing file is treated as that node's delivered work. That comparison does not identify which agent wrote the file.

Consequently, one node can commit another node's in-progress changes. The recorded five-node experiment demonstrates the related attribution failure: one commit consumes changes that another node subsequently needs to claim, leaving its landing with NOTHING_TO_COMMIT.

There is a second independent problem: the workspace can change after verification and before commit. The lander stages current path contents, not an immutable tree passed in from the verifier.

The graph end-to-end test does not close this gap. It uses scripted agents and separate repositories for its nodes, whereas production compiled nodes share a repository. The test validates useful graph/claim/dependency machinery, but its workspace arrangement excludes the production integration problem.

**Fix:** immediately serialize work per repository as a temporary operating restriction. Then implement isolated attempt workspaces or equivalent immutable candidate trees, explicit ownership, and an integration queue. Verify the candidate and integrated tree, and land exactly the verified tree with an expected-parent check. Per-attempt isolation is a recommended future product change; no worktrees were created during this review.

[Shared mission workspace](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/compiled-node-source.ts#L188) · [Dirty-file attribution](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/node-lander.ts#L83) · [Current contents committed](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/node-lander.ts#L173) · [Separate-repository test harness](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/tests/e2e/foundation/multi-node-graph-harness.ts#L88)

**4. Product truth issue: criterion coverage overstates what the live verifier demonstrates**

Severity: P1 for the product promise. Confidence: high.

The actual default path works as follows:

1. A compiled node receives its criterion statements as prose.
2. Every node receives the same host-configured test command, normally pnpm test.
3. The daemon reruns that command.
4. Exit code zero produces the node's verifier receipt and acceptance.
5. Every criterion bound to that accepted node becomes VERIFIED.
6. All verified criteria can make the goal ready for closure.

Independently rerunning a command is meaningfully stronger than accepting the coding agent's claim of success. But a successful generic suite does not establish that every requested criterion has a suitable check, or even that the tests cover the requested functionality.

The receipt records test output hash, byte count, command and workspace. It does not independently identify the exact repository tree tested. Other submitted package labels can be internally consistent without proving those physical contents.

The repository also contains a richer Foundation verification service. It should not be credited as the default wrapper's guarantee: the live wrapper composes createNodeVerifier and createVerifierProcessRunner.

**Fix:** preserve “node test passed” as its own fact. Add criterion-level evidence identifying contract revision, criterion ID, candidate/integrated commit, check identity/version, executor and result. A criterion needs the right kind of check: API behavior, browser journey, accessibility measurement, performance result or explicit human judgment. Rerun acceptance at the final integrated revision. Bind review, verification, landing, preview and release to that same artifact.

[Production verifier composition](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/agent-wrapper-main.ts#L299) · [Node verification receipt](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/node-verifier.ts#L180) · [Criterion status derivation](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/http/document-coverage-read.ts#L233) · [Closure readiness](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/goals/goal-close-readiness.ts#L58)

The v0.1 verifier's agent-modifiable workspace and shared OS account are explicitly documented limitations. This review does not present that accepted scope as a newly discovered exploit. Exact-tree attribution remains a correctness problem even with cooperative agents. [Documented verifier scope](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/README.md#L153)

**5. Immediate integration blockers on the advanced commit**

These should be repaired before treating this branch as an operational baseline.

| Finding | Observation | Remediation |
|---|---|---|
| Scheduler does not typecheck | Fresh local run and CI report TS18046 at budget-reservation.ts:132 | Preserve validated narrowing when extracting meter identifiers |
| Wrapper cannot load natively | Fresh native import, with the documented transform flag, fails on missing node-spec-listing.js | Restore the runtime bridge or adopt one consistent compiled execution strategy; smoke-import real entrypoints |
| Coding instructions deny coding tools | codeMission appends a shared statement that the session has no write tools and should not write files, although the coding spawner grants them | Make tool restrictions role-specific and derive mission/tool agreement from the same role contract |
| Planner lacks rejection feedback | Production compilerInstructions reads only the original brief; the focused test for rejection composition fails | Feed the current planning run's rejection reason into the next planner attempt and test the resulting mission |

The coding prompt contradiction is new on the active branch. The rejection feedback wiring gap also exists on main; the newer branch exposes a failing test for it. Do not group every red test as a newly introduced runtime regression.

The no-transform native import also fails on a TypeScript parameter property, but the runbook and launcher already document/use the required transform flag. I do not count that known invocation requirement as an additional new defect.

[Typecheck error site](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/packages/scheduler/src/budget/budget-reservation.ts#L128) · [Missing runtime import](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/agent-wrapper-main.ts#L32) · [Contradictory coding prompt](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/agent-mission-text.ts#L41) · [Planner input wiring](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/agent-wrapper-main.ts#L247)

**6. The remaining product journey is not yet connected**

A registered command, a record schema and a tested helper do not establish that a user can complete a feature through the normal product flow.

**Preview:** the preview.decide branch validates input and then unconditionally refuses with PREVIEW_GOAL_NOT_LANDED, explicitly saying the runner is not landed. There is no working Gate 2 at this commit. [Preview stub](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/daemon-command-registry.ts#L399)

**Fresh project:** browser activation now genuinely drives register → bind → probe → activate. However, project creation writes the Moe configuration; activation requires an existing Git repository and HEAD. A genuinely empty folder still needs outside setup. The deterministic controlled-profile generator exists but has no non-test production caller found at this snapshot. [Initialization output](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/cli/moe-init.ts#L169) · [Activation Git requirement](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/bootstrap/activation-receipts-measure.ts#L68) · [Scaffold generator](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/repository/controlled-profile/controlled-profile-generator.ts#L114)

**Design and release:** the design read port is composed into the daemon. The design write helper, release dossier renderer and release dossier recorder have no non-test production callers found. Their groundwork is valuable, but a normal seat cannot yet traverse a complete UX/design → preview → release journey. [Design composition](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/daemon-store-foundation-composition.ts#L344) · [Design writer](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/design/design-store.ts#L130) · [Release dossier](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/release/release-dossier.ts#L129)

**Contract versions:** rich Product Contract V2 includes objectives, journeys, assumptions, budget and success metrics, and its writer is publicly wired behind cutover authority. The demonstrated ordinary planning mission and compiler reads still follow V1, including lineage:null. Converge these paths before claiming a full product planning or amendment journey. [V2 shape](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/packages/core/src/product-contract/product-contract-v2-contract.ts#L148) · [V2 command wiring](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/daemon-v2-command-registry.ts#L112) · [Default planner grammar](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/agent-mission-text.ts#L104)

**7. How the agents actually communicate**

The working system coordinates through a central daemon, scoped MCP calls, durable claims/review records and the coding filesystem. It is not currently a deployed peer-to-peer agent conversation system.

| Participant | Actual responsibility |
|---|---|
| Human/control room | Approves contract and plan; handles escalation and publication decisions |
| Wrapper | Finds ready work, opens scoped sessions, claims work, launches and supervises processes |
| Planning/coding agent | Reads context and source, proposes or submits work over MCP; coding agent edits the workspace |
| Daemon/store | Authorizes and records commands, versions, decisions, claims and review state |
| Verifier | Reruns the configured command and records evidence |
| Lander/publisher | Commits accepted work and acts on human publication requests |

The coordination package contains a real durable mailbox design: send/read/acknowledgment, deduplication, reply correlation, TTL and capacity. However, its adapter is not instantiated in the default live wrapper path, and the scoped MCP roster does not expose those mailbox operations. Describe this as implemented infrastructure awaiting integration.

I would not add general agent chat as the next feature. First make handoffs typed and durable: producing node/attempt, artifact identity, assumptions, unresolved questions, interface changes, tests and consumer acknowledgments. Conversation can explain a handoff; it should not become its source of authority.

[Wrapper MCP composition](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/agent-wrapper-main.ts#L339) · [Scoped MCP roster](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/mcp-tool-allowlist.ts#L27)

**8. Recovery and sustained-operation findings**

These are separate from the immediate compilation and module-load blockers.

| Priority | Finding | Consequence and fix |
|---|---|---|
| P2 | Ordinary failed child processes enter a permanent wrapper-wide failure collection | One transient non-rate-limit agent failure stops future staffing until restart, even after successful cleanup. Separate per-attempt failure/retry from unresolved containment or authority failure. |
| P2 | Retry landing rescue recognizes earlier untracked files only | Correct changes to tracked files from a previous attempt can be omitted or leave NOTHING_TO_COMMIT. Preserve provenance against the original base for tracked modifications, additions and deletions. |
| P2 | Interrupted Foundation verification lacks an intermediate-state resume path | A failure after ACTIVATED but before RECEIPTED can make retrying the same verification identity conflict with its original command identity. Reconcile durable intermediate state instead of reissuing a new activation at a new expected version. This concerns the separate served Foundation service. |
| P2 | Read caching retains history and repeated full folds | Memory grows with retained decision/result bytes and important request paths still rebuild state over project history. Add incremental indexed projections and checkpointing before scaling long-lived projects. |

[Wrapper failure accumulation](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/agent-wrapper-staffing.ts#L112) · [Permanent staffing stop](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/agent-wrapper.ts#L317) · [Retry file filter](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/node-lander.ts#L70) · [Foundation replay path](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/evidence/foundation-verification-service.ts#L162) · [Ledger memo](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/decision-ledger-memo.ts#L21)

These are static control/data-flow findings. No new crash experiment or throughput benchmark was run for this review.

**9. Publishing and UI truth need commit-level identity too**

The publisher receives workspace and remote, reads HEAD, then later pushes literal HEAD. If another local commit occurs between those operations, the receipt can report a different SHA from what was pushed. Pass and push the approved exact commit, then confirm remote state. [Publisher call](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/orchestrator/node-publisher.ts#L47) · [Moving-HEAD push](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/repository/git-landing-port.ts#L223)

The board also takes one goal-wide PUSHED boolean and applies it to every committed node. Publication is allowed after any node lands. A later node can consequently appear Published using an earlier push receipt, even though that later commit was never included in that push. The daemon should derive per-node published membership using landing ancestry beneath the confirmed remote SHA. [Board flag](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/control-room/src/v2/board/board-screen.tsx#L80) · [Published classification](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/control-room/src/v2/board/board-columns.ts#L63) · [Publication offer condition](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/http/affordance-planning-offers.ts#L173)

Additional UX issues from source inspection:

- Activation guidance still says the browser cannot drive activation, while a new activation card does exactly that. The card does not become a clear durable “ready” state; its deferred backup receipt remains unmeasured. [Stale guidance](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/control-room/src/v2/goals/live-goal-create.ts#L89) · [Deferred receipt](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/daemon/src/http/activation-read.ts#L139)
- After a PRD file read/size failure, the form can still create a goal with no submitted PRD. Require successful replacement or explicit removal before proceeding. [PRD state handling](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/control-room/src/v2/goals/use-goal-prd.ts#L114) · [Create disable condition](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/control-room/src/v2/goals/new-goal-form.tsx#L230)
- The Budget input becomes advisory instructions. Distinguish requested budget from an admitted spending cap and measured consumption; this is not a claim that the scheduler has no budget enforcement. [Budget conversion](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/apps/control-room/src/v2/goals/live-goal-create.ts#L38)

The board's separate verified, landed and published stages, retained drafts, contract dossier, explicit remote confirmation, provider pause visibility and actionable manager refusals are good improvements. Fix the state derivation underneath those useful affordances.

**10. The test investment is substantial, but the proof gap matters**

Main's successful Linux CI log reports:

| Suite | Reported result |
|---|---|
| Root | 10,232 passed; 80 skipped |
| Daemon | 7,876 passed; 15 skipped |
| Control room | 1,665 passed |
| Security lane | 959 passed |

These are CI-reported counts, not fresh local totals, and suites can overlap. Cross-host explicitly runs daemon and UI suites, so it does address the root Vitest gate's omission of apps.

The advanced branch's failures are actual source/integration failures, not dependency-install failures. Other red checks include activation fixtures needing the new measured-provider evidence, stale closure expectations and strict source/version naming checks. Each needs triage; not every failing assertion implies broken runtime behavior.

Important gaps:

- The live Claude self-host canary is opt-in and skipped in main's green CI run.
- Routine cross-host PR/push gates do not invoke Playwright. Browser journeys are in the manual Windows candidate workflow. Some browser tests use live daemons; calling the suite “fixtures only” would be wrong.
- The multi-node harness uses separate workspaces and scripted agents, so it does not prove integrated same-repository delivery.
- The committed benchmark campaign records no arms, repetitions, oracle runs, receipts, raters or user-study cases. Higher-level verdicts are UNKNOWN, with highest all-pass rung L0, bound to an older unattested revision. There is no demonstrated comparative advantage over a single coding agent in completion, quality, cost or intervention burden.
- GitHub has no published releases at review time. The three observed manual Windows candidate runs all failed. The latest stopped before build because an abbreviated SHA was supplied to a full-SHA authorization contract; this is an input/authorization failure, not proof that packaging itself cannot build.

[Canary opt-in](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/tests/e2e/foundation/canary-self-host.e2e.test.ts#L52) · [Unexecuted benchmark campaign](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/packages/benchmark/campaigns/task-8af4562ff1ae41b28876aaee63f05ea3/campaign-record.json#L11) · [Latest candidate run](https://github.com/yaront1111/Moe-NG/actions/runs/33672099731)

The right improvement is fewer claims unsupported by the actual test arrangement. Add native entrypoint checks, same-repository multi-node tests, browser smoke tests, and deliberate failure/restart checks around physical effects. Avoid adding more source-string assertions as a substitute for behavioral evidence.

**11. Architecture worth preserving—and where it is getting expensive**

The strongest engineering is in durable authority and storage:

- Transactions use BEGIN IMMEDIATE, recheck project binding and expected versions, and commit decisions with effects.
- Multi-aggregate legs are validated before writing; production activation and planning use those atomic mechanisms.
- Ambiguous commits poison the handle and return OUTCOME_UNKNOWN rather than asserting that nothing happened.
- Scoped sessions and a restricted agent command roster preserve meaningful human decision boundaries.
- Verifier receipts are fenced to review decision/version, preventing a stale acceptance from silently following a competing review update.
- Wrapper startup admission is distinct from process lifetime; dependency-aware scheduling and recovery fencing are genuine mechanisms.

[Transaction implementation](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/packages/store/src/decision-ledger-transaction.ts#L121) · [Multi-leg preflight](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/packages/store/src/decision-ledger-legs.ts#L72) · [Commit ambiguity](https://github.com/yaront1111/Moe-NG/blob/829c3bc0af969826d9a5c05ad5f4da6409475f52/packages/store/src/decision-ledger-transaction.ts#L226)

The architecture is much stronger at recording authorized decisions than at proving that physical software artifacts match those decisions. That is the central engineering imbalance.

The repository has 20 workspace projects, more than 2,700 tracked TypeScript/TSX files including tests, and 1,252 JavaScript files, many used as runtime bridges. A rough path-filtered count gives approximately 251,000 lines of production TypeScript/TSX; this excludes paths containing test/fixture/generated/spec markers and is an estimate, not a formal software metric.

Many small modules keep individual files manageable, but a single product behavior spans prompts, command vocabulary, codecs, registry, dispatcher, service, ledger, projection, UI and tests. The observed missing bridge, rejected-plan feedback gap and unwired product helpers show the integration cost. More abstractions are unlikely to solve that on their own.

Recommended maintenance changes: a definitive production composition map, one typed contract for role prompts and tool capabilities, consistent runtime packaging, explicit ownership of complete vertical journeys, and tests at the public entrypoint. Retain the durable core instead of rewriting it.

**12. Recommended sequence and acceptance gates**

Do not estimate readiness by closed tasks or number of modules. Use working outcomes.

| Order | Deliverable | Acceptance gate |
|---|---|---|
| 1 | Restore a usable advanced-branch baseline | Typecheck, native entrypoints, daemon and UI gates green; coding prompt and planner rejection feedback corrected |
| 2 | Repair execution and artifact identity | Independent goals may reuse local node names without collisions; every attempt has scoped provenance; exact verified trees are landed |
| 3 | Prove integrated multi-node work | Three to five nodes contribute to one product repository; all landings attributable; no swept or omitted changes |
| 4 | Add criterion-specific acceptance | Every criterion names evidence at the final integrated SHA; unmet criteria stay unmet despite a green generic suite |
| 5 | Complete fresh project and preview | Empty folder becomes ready project; real app launches at the tested SHA; human approves Gate 2 |
| 6 | Finish publication/release evidence | Approval, remote push, per-node publication state and dossier agree on the exact revision; recovery does not duplicate effects |
| 7 | Measure value on held-out PRDs | Record completion, intervention minutes, acceptance, defects, elapsed time and provider cost versus a competent single-agent baseline |

The smallest meaningful demo is a modest TypeScript CRUD application with login, server-side authorization, database persistence, a responsive interface, and an error/recovery journey. Use a five-to-eight-requirement PRD and a three-to-five-node graph. Require exact-SHA browser/API evidence, a mid-run restart, a real preview and an attributable PR.

Start with a few held-out PRDs to improve iteration speed. Expand toward the vision's 20–30 representative cases only after the complete path is dependable. A benchmark is valuable when it measures actual user outcomes; scaffolding for a benchmark is not a result.

**Commercial judgment**

The code supports a credible direction: a supervised delivery control plane where an operator can understand what agents did, why it was accepted, and what requires intervention. A narrow pilot around bounded repository changes, migrations or remediation is more defensible than promising arbitrary PRD-to-production today.

Before charging for that pilot, fix the execution-identity and tested-tree attribution issues: they affect even a narrow promise. Then measure whether Moe actually reduces operator effort and defects relative to a strong single-agent workflow. The repository currently does not establish that advantage.

I would continue the project and substantially narrow the next milestone. The next investment should make one complete product journey reliable and measured. Additional agent roles, mailbox breadth, product profiles and governance record families can wait until that journey works repeatedly.

