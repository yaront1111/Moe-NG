# Product evidence and recovery implementation plan

**Goal:** Complete the remaining review work with criterion-specific evidence, recoverable repository effects, exact publication approval and measured integration gates.

**Architecture:** The daemon owns contract bindings, check results, repository reservations and physical effect evidence. The browser selects and approves explicit checks and repository actions, then displays durable results without deriving authority. Each effect retains the physical checkout reservation until its outcome and process containment are known.

**Tech Stack:** TypeScript, SQLite event stores, Git immutable trees and ref comparison, React, Vitest and Playwright.

## Baseline and ownership

- Preserve foreign preview, release, deployment, activation and provider work. Changes to shared composition and protocol rosters are narrow, coordinated hunks; generated metadata must describe the committed source union.
- Fresh `pnpm typecheck` passed on the working checkout based on `3891a2a0`. The preview test owner corrected the last optional-property error; this plan does not claim that correction.
- Run root, daemon and Control Room suites with bounded workers and record actual aggregate exit/count results. Root tests exclude the app suites. Recheck Foundation/store gates after implementation.

## Criterion evidence

1. Add an immutable Product Contract revision binding on the production decomposition submission path. Tests must reject a changed revision, duplicate criterion IDs across contracts and a graph/run mismatch; legacy missing bindings remain explicit.
2. Add a versioned operator-approved criterion check catalog, naming the exact revision, criterion, executable arguments and executor identity. A passing generic node test must leave the criterion awaiting evidence.
3. Acquire dedicated goal-verification ownership after every scoped node is durably landed. Capture the integrated SHA/tree, execute the approved checks, prove child containment and unchanged artifact, then persist criterion results. Interrupted or ambiguous effects remain held.
4. Connect durable evidence to coverage and goal closure. A stale SHA, changed check definition, missing criterion or failed check withholds verification. Every approved criterion must be covered at the same final integrated artifact.
5. Build `live-criterion-evidence.ts`, `criterion-evidence-port.ts` and `criterion-evidence-card.tsx`, then compose the card beside the Contract Dossier. Test exact command payloads, stale read invalidation, failure visibility and the complete evidence tuple.

## Repository recovery

1. Extend the reservation primitive for publication and criterion verification without weakening immutable ownership or revision checks.
2. Add a landing intent written before Git, bound to owner/session/baseline and expected parent/tree/branch. Test crashes on either side of the physical effect and require evidence for an already-created commit before recording/releasing it.
3. Add operator recovery actions for an unexecuted reservation and an exactly reconciled landing. A dead PID, expired claim, old receipt or arbitrary BLOCKED record cannot authorize release. Preserve unknown process or lock states.
4. Build a recovery read and UI card with daemon-issued action offers, expected reservation revision and a required operator reason. Never return owner tokens or machine paths to the browser. Tests assert stale actions refuse and rejected actions leave ownership intact.

## Publication approval

1. Prepare a daemon-observed candidate from the goal and selected remote, then display its exact SHA/branch/remote in the publication confirmation. Command admission remeasures the same tuple and canonical checkout before recording approval.
2. Persist effect intent before pushing the approved immutable SHA under publication ownership. A restart or unknown push result permits remote observation only; it cannot silently re-push a new HEAD.
3. Record success only after the remote branch equals the approved SHA. Tests cover HEAD advancement, stale approval, changed repository identity, missing/different remote refs and crashes before receipt/release.

## Verification and delivery

For each behavior, first run a regression that fails at the intended assertion, implement the minimum change, then rerun its containing suite. Run daemon tests from `apps/daemon` with `node ../../node_modules/vitest/vitest.mjs run --root . --config package.json --maxWorkers=1 <owned test paths>`; run UI tests from `apps/control-room` with `node ../../node_modules/vitest/vitest.mjs run --maxWorkers=1 <owned test paths>`.

Exercise multiple sequential nodes, an interrupted landing and durable recovery using real Git and stores. Drive the new operator actions through the production UI and daemon transport. The separate real-product browser-to-release demonstration awaits the user's selected PRD; automated fixture journeys are reported with that limitation.

Finish with fresh typechecks, required repository gates, an adversarial diff review and explicit-path local commits. A failed or incomplete gate remains recorded as such. No source recovery snapshot, untracked foreign module or passing fixture is credited as a complete product release.

## Implementation and measured limits

The daemon now records the approved contract binding with decomposition, approves immutable criterion checks, executes them under exclusive repository ownership, and binds their receipts to the final integrated Git artifact. Generic node tests do not verify product criteria. Replacing an approval retires its old evidence from the current read and closure projection; the historical receipt remains stored.

Recovery uses an owner-bound landing intent and physical Git evidence. A human can release a proved unexecuted reservation or reconcile the exact completed landing without repeating Git. Publication approval names the observed checkout identity, branch, remote and immutable SHA; ambiguous publication permits remote reconciliation rather than another push.

The Goals screen contains criterion approval, verification and evidence controls. Health contains the repository recovery read and daemon-issued recovery actions. Publication shows the exact candidate before approval. The browser supplies the daemon's command envelope and does not mint authority.

Goal qualification now derives execution references from the approved, immutable compiled graph and requires its exact execution-bearing node roster. Raw local node keys cannot borrow another goal's review or landing evidence. The legacy path requires a canonical unbound GoalCreated admission and real Foundation receipts; absent, malformed or hidden compiled bindings cannot downgrade into raw LIVE evidence. Historical activations that ambiguously name compiled local keys still block closure.

Measured verification on 2026-09-06:

- Full Control Room suite: 164 files, 2,032 tests passed. Foundation and browser e2e TypeScript checks passed.
- Browser integration: one Playwright test passed through normal pairing and the real daemon. The fixture's non-Git workspace produced an explicit identity refusal and no recovery action; its unbound goal produced no fabricated criterion result. Screenshots were inspected.
- Recovery and landing: 96 distinct tests passed across the broad run and native coordinator rerun. Real recovery preserved foreign staged bytes and newer working edits.
- Criterion/Windows execution: 499 runner tests, 92 native broker tests and the integrated final-artifact evidence test passed. The approval replacement regressions and their related daemon suites passed (32 tests).
- Publication: 195 daemon tests, one native Git publication test and 73 related UI tests passed; the intent replay regressions also passed.
- Real-process J1 and J4 journeys: six tests passed, including an exact landing receipt SHA equal to Git HEAD and absent landing receipts on refused attempts. Portability rerun: three files, 39 tests passed.
- The three-node initial-run journey passed all three cases. It made three real Git commits with scoped landing receipts, withheld the dependent node until both producers landed, and maintained exclusive repository execution even with two worker seats. Generic node success left coverage at 0/3. Three explicit human check approvals and guarded checks at the independently read final Git HEAD raised coverage to 3/3; the real configured operator close command durably completed the goal.
- Closure scope regressions: 10 passed, including spoofed catalog event type, binding corruption, exact roster, foreign/raw acceptance and retained historical activation authority. Migrated goal-service, qualification and J1 tests: 57 passed with one unchanged concurrent bootstrap roster failure. Scoped LIVE evidence: 14 passed, including a real contained criterion check and exact repeat-close refusal. Recovery callback ownership tests: 12 passed; wrapper staffing guard and mutation controls: 33 passed. Final readiness, recovery command and HTTP read/status group: 28 passed.
- The initial root diagnostic ran 430 files and 10,378 tests while concurrent writers changed the tree: 415 files passed, 14 failed and one skipped; 10,281 tests passed, 14 failed and 83 skipped. Its packaging hash-boundary and workspace-capture timeout cases pass in isolation; the scheduler boundary, dependency scanner, compiled-product fixture, runner ABI, multi-node journey and portability failures pass after the respective fixes/reruns. This mixed-state run is not a green final baseline.
- The full daemon diagnostic ran 500 files and 9,154 tests: 482 files passed and 18 failed; 9,118 tests passed, 34 failed and two skipped. Focused reruns cleared the review-owned failures, including stale fixtures, recovery handle assertions, HTTP status mapping, shared recovery payload metadata and the approved native broker selection. Remaining shared failures concern concurrent bootstrap/environment command registration and the deployment helper's runtime bridge classification. This diagnostic also remains red; the passing focused runs do not replace it with an all-green baseline.
- `pnpm typecheck`, `pnpm verify:foundation` and `pnpm verify:store` currently stop at the concurrent bootstrap task's invalid `AsyncCommandHandler` import in `repository-bootstrap-command.ts`. Its actual type export is in `http-async-contract.ts`. Shared registry/MCP roster checks also reflect the concurrent bootstrap/environment additions. Their active owners' work is preserved.

Windows native validation used the newly built broker at `dist/windows-job-native-approved-image/release/moe-windows-job-broker.exe` via a test-only resolver. The running default broker is locked and was not replaced. A fresh release build/restart must install the new broker before live criterion execution can use the approved-image protocol. Production has no test environment override. Non-Windows criterion execution has not been demonstrated.

Legacy plans and compiler paths without the immutable contract binding remain unattributable. Successor-run execution is another explicit limit: the current-planning-run reader follows successors, while criterion-goal and active-compiled-graph readers still use the original goal planning run. A successor approval therefore encounters a graph/run mismatch and fails closed. That separate replan task remains active; the three-node proof covers the initial approved run and does not demonstrate successor execution.

The separate real-product browser-to-release demonstration still awaits the selected PRD; none of the fixture evidence above is presented as that release. Core evidence and recovery changes are committed in `31339efb45bc49de00e53818983b9f627e7c4d91`; the final scoped closure and fixture changes are delivered in the subsequent explicit-path local commit. No remote publication was performed.
