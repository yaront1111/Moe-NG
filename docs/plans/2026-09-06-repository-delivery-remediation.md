# Repository delivery remediation

This continues the [5 September review response](2026-09-05-deep-review-remediation.md). It addresses execution attribution, repository ownership, verified-tree landing and unsupported criterion claims in the live wrapper. Work stays in the shared checkout with explicit owned paths; concurrent preview, release, deployment and bootstrap work remains separate.

## Implemented behavior

- Compiled execution references hash the project, goal, planning run, sealed graph content and local node key. Claims, reviews, dependencies, Runs, activity, landing attribution, escalation and replan joins use that reference. Operator node specs cannot override its reserved namespace. Local node names remain display labels.
- Legacy bare-key execution history is quarantined with its dependents. Existing acceptance and landing cannot silently authorize a new scoped execution. Historical attribution still needs explicit reconciliation.
- A SQLite reservation lives in the canonical checkout Git directory. Aliases and different project stores share that reservation. Acquisition and changes use transactions, immutable owner tokens and monotonic revision checks. A controller token distinguishes wrapper lifetimes; only proved controller death permits takeover.
- The reservation starts before the baseline and child. Initial coding admission requires a clean repository observation. It retains the first baseline through contained retries, including tracked edits and deletions, and stays held through verification and landing. A second node cannot use the same checkout during that interval; different checkouts remain independent.
- Child close and durable staffing/claim retirement precede verification. Ordinary contained failures can retry; unknown containment blocks. A restarted wrapper holds a live orphan and cannot infer descendant shutdown from a dead direct PID. Ambiguous verifier or Git crash phases remain held. A durable committed landing allows reservation-release reconciliation without repeating Git.
- Every effect receives the reserved canonical repository identity. A changed operator spec cannot redirect verification or landing to an unreserved checkout. Tests keep their configured subdirectory when it belongs to the reserved repository.
- Disabling landing refuses new coding admission and holds already accepted work without invoking Git or writing a refused landing. Re-enabling landing permits the held owner to resume.
- Verification captures the parent commit, branch, complete canonical Git candidate tree and raw dirty-file digest before and after the configured test. The durable verifier receipt binds those facts. Receipt replay and landing require the same binding. Legacy unbound receipts cannot authorize landing.
- Landing reconstructs the candidate from explicit delivered paths and requires equality with the verified tree. It creates that immutable tree's commit with an expected-parent branch update and preserves unrelated staged changes. Same-path staging, filters, submodules, unsupported ref backends, ambiguous effects and changed evidence refuse. Only the exact pre-effect index-lock refusal permits a retry.
- Health displays held, idle or unknown repository ownership, its project/node and phase. It exposes no ownership token or filesystem identity. Runs displays the tested Git tree separately from the landing commit.
- Generic test success is `NODE_TEST_PASSED`; its criteria remain `EVIDENCE_REQUIRED`. PRD coverage and Contract Dossier show both facts. The goal-close command refuses `GOAL_CLOSE_CRITERIA_UNVERIFIED` without writing, even when all nodes have accepted, landed work.
- Coverage scopes test observations to their goal and sealed planning authority. A complete criterion set must match exactly one compatible approved contract revision; duplicated local criterion IDs or ambiguous revisions cannot borrow evidence from another contract or goal.

## Validation

Focused evidence includes real SQLite process contention and interrupted transactions, controller/owner/revision checks, alias exclusion, child lifetime and orphan cases, no-attempt-cost refusals, immutable original baselines, Git tree/parent/index behavior, scoped cross-goal identities, strict browser decoding and command-side closure refusal. Native imports use the documented Node `--experimental-transform-types` flag and cannot launch providers during the smoke probe.

The real-repository composition tests use scripted child lifetimes and an injected test runner over actual Git and daemon stores. They test same-checkout exclusion, durable verifier/landing receipts, exact committed trees and tracked-file retry provenance. They are not paid-agent or hermetic-verifier demonstrations.

| Focused check | Result |
| --- | --- |
| Repository reservation and exact Git artifact groups | 6 files, 55 tests passed; exit 0 |
| Coordinator, recovery and wrapper refusal cleanup | 3 files, 21 tests passed; exit 0 |
| Real repository runtime composition | 2 tests passed; exit 0; sequential nodes and tracked edit/deletion retry |
| Disabled landing with an existing accepted owner | 1 test passed after an observed red; exit 0 |
| Owned daemon identity, reads, verification, landing, closure and native imports | 19 files, 193 tests passed; exit 0 |
| Owned Control Room contracts, attribution, evidence and repository Health | 20 files, 195 tests passed; exit 0 |
| Final criterion attribution regressions | Daemon: 5 files, 70 tests; UI: 4 files, 28 tests; both exit 0 |
| Health fixture regression in the application shell | 1 file, 47 tests passed; exit 0 |
| Control Room TypeScript | Passed; exit 0 |
| Repository primitive/Git strict TypeScript | Passed; exit 0 |

These groups overlap and are not a summed unique-test count. The two long runtime cases preceded the final Git HEAD-lock handoff guard; the final 55-test Git group includes its race and unknown-effect checks. An isolated mutation removing that guard failed at the intended assertion, with production bytes unchanged.

Whole-branch gates remain incomplete. The latest daemon TypeScript run reports two errors outside these owned paths: `preview/preview-runner.test.ts:282` supplies an explicit undefined optional capture port, and `release/release-decide-contracts.test.ts:16` imports a `.ts` path. Required Foundation/store gates stopped in typechecking during concurrent source edits; their test stages did not establish a pass. The full UI run reported 150 files passing and 5 failing, with 1,950 passing and 33 failing tests. Three Health fixture failures from that run were fixed and the shell's 47 tests passed afterward. Other failures included entrypoint/scaffold imports, Gate 1 shapes and concurrent goal-creation behavior; no complete UI rerun is credited.

The required root and daemon broad suites were attempted but stopped after sustained Foundation/process timeouts under heavy concurrent host load. Their aggregate runs are incomplete, not green. No passing clean-checkout baseline, paid-provider run, browser journey or release demonstration is claimed.

## Remaining production gates

- Criterion-specific evidence has no composed producer yet. It needs contract revision and criterion identity, an appropriate versioned check, executor/result and final integrated artifact binding. V1 also lacks a durable explicit run-to-contract-revision producer; ambiguous compatible revisions remain unattributable. Generic passing tests deliberately cannot close these gaps.
- Tests still run in the working copy under the shared OS account. Canonical Git trees and dirty-byte observations do not prove hermetic execution, ignored dependency contents, or protection against arbitrary external writers changing and restoring files during a test.
- Interrupted process containment and ambiguous Git outcomes need a bounded operator reconciliation workflow. There is no automatic unlock or TTL-based ownership stealing. Health exposes the hold; it grants no release authority.
- Publication still needs an approval-time commit identity and durable reconciliation of ambiguous remote effects. The earlier captured-SHA push fix remains, but publication is not part of the new delivery reservation transaction.
- Per-attempt isolated workspaces, final integrated criterion verification, the normal design/preview/release journey, Foundation intermediate-state recovery, projection performance and measured benchmark/release readiness remain follow-up work. Concurrent implementations in this checkout are not credited as delivered by this change.
- A green whole-branch baseline is still required. Concurrent test/source changes and host load must be distinguished from failures in these owned paths; incomplete broad runs are not passes.
- The preview landing adapter's scoped-identity adjustment remains in its owner's untracked preview work. It is excluded from this delivery and cannot be credited until that module lands.
