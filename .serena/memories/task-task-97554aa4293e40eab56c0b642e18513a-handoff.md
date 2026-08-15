# Foundation self-host canary — worker handoff 2026-08-15 (BLOCKED again at step 1)

## Outcome
`worker-d6220bc6` ran step-1's resume gate at committed HEAD `65a3241ec313ac06a2705ea912ae876bdc442f46`
and reported BLOCKED. Escalated to @governors (no live architect).
Full file:line evidence lives in task comment `comment-90116e38af76441397716ce20fc3a992` — read it
before re-planning; do not re-derive the greps.

## Why the earlier unblock did not clear this
`governor-f70d1157` unblocked the task after verifying FOUR claims from worker-e46fb0dc's original
block (goal.close in GOAL_HANDLERS, approval.decide activation composition, integration.accept_output
in REVIEW_HANDLERS, apps/daemon/src/review persistence). **All four re-verified TRUE at 65a3241.**
They are not in dispute.

But the plan that architect-94dd1835 submitted AFTER the unblock has a step-1 gate over **seven**
capabilities, and `planningNotes.risks` explicitly named three symbols the unblock never touched.
Those three are still test-only. An unblock clears the claims it enumerates, not the gate.

## The three gaps (measured, not read off a design)
| Capability | Symbol | Complete caller set |
|---|---|---|
| pinned Claude launcher | `createFoundationClaudeLauncher` @ `apps/daemon/src/activation/foundation-launch-authority.ts:290` | own `.test.ts:42,602` + `.js` bridge |
| restart reconciliation | `reconcileOnRestart` @ `apps/daemon/src/recovery/restart-reconciliation.ts:235` | `continuation-test-harness.ts:6,73` + 2 `.test.ts` |
| durable coordination | `createCoordinationAdapter` @ `apps/daemon/src/coordination/coordination-adapter.ts:111` | own `.test.ts:84,90` |

Supporting facts, all re-runnable:
- `git grep -n launchClaude -- '*.ts' | grep -v ^packages/runner` -> **ZERO lines.** @moe/runner's
  launcher has no consumer anywhere outside its own package.
- Production's only real Claude spawn is `claudeSpawner` (orchestrator/agent-spawner.ts) at
  `agent-wrapper-main.ts:82`. It spawns `MOE_AGENT_COMMAND` (default `claude`) with env credentials
  and does **no** pin observation, version check, executable-closure check, or registration commit.
- `startDaemon` (`daemon-entry.ts:162`) read in full: `resolveDependencies -> startControlRoomListener
  -> freeze/return`. **No reconciliation sweep at boot.** So a restart writes no
  `{ADOPTED,SUSPECT,QUARANTINED,RECONCILIATION_COMMAND}` records for step 4 / DoD 2 to assert over.
- `daemon-command-registry.ts` wires `runRecoveryCompleteCommand` and `daemon-store-dependencies.ts:16`
  wires `createRestorePort`. Both are DIFFERENT capabilities (completion digest; restore/quiesce) —
  neither classifies in-flight attempts.
- `git grep -n "coordination/" -- 'apps/daemon/src/**'` minus the coordination dir -> **ZERO lines.**
  The whole coordination directory is unreachable from every production daemon module.
- Registry admits exactly: BOOTSTRAP (10 kinds), REVIEW (4), SESSION (3 — `session.open/renew/close`,
  credential lifecycle ONLY), WORK (3), `effect.activate`, `recovery.complete`. No coordination or
  terminal envelope kind exists, so no MCP client can send/read a typed advisory envelope.

## What IS real — do not re-measure
Plain-Node probe, cwd `D:\projexts\moe-next\apps\daemon`:
`runner launchClaude: function` / `runner admitResume: function` / `coordination keys: 14` /
`daemon root: exports=78 REVIEW_HANDLERS=object`. `apps/daemon/package.json:16` declares
`@moe/coordination": "workspace:*"`. Hosts real: `mcp-http-main.ts:40 -> createMcpHttpHost`,
`agent-wrapper-main.ts:74 -> createAgentWrapper`, `:132 -> createNodeVerifier` (real bounded spawn,
sha-256 receipt, Windows `taskkill /T` tree kill at `agent-wrapper-main.ts` runTest).
**The edges are fine. The gap is COMPOSITION, not publication — project rail Clause 1.**

## What unblocks it (three production consumer edges, not exports)
- A: compose `createFoundationClaudeLauncher`/`createFoundationLauncherAuthority` into the spawn path
  so `claudeSpawner`'s launch is pin-observed and fails closed by code on a non-approved host.
- B: call `reconcileOnRestart` from the boot path (`startDaemon` or the store-dependency composition
  root) so a restart durably writes classifications; expose the continuation command via the registry.
- C: register a coordination command kind in `daemon-command-registry.ts` backed by
  `createCoordinationAdapter` so typed session/terminal envelopes cross MCP with authenticated receipts.

Steps 2-8 of the current plan are unchanged and resume as written once these exist.

## The trap to refuse
`packages/testkit/src/foundation/foundation-model-j3j4.ts` exists and makes a green J3/J4 trivial to
fake. Same for calling the pure reducers directly from the `.e2e.ts`. Both are the mock-backed
journey / test-owned authority that epic rail 4 and Clause 2 forbid, and this task is the epic's
TERMINAL acceptance gate — a fake green here retires the whole gate. Refusing that is the point.

## State on disk
No bytes written by this session. `tests/e2e/foundation` still holds exactly the 8 committed
harness/fixture/spec/manifest files and zero journey files. Nothing staged, nothing committed.
Root `test:e2e` is still `tsc -p tests/e2e/foundation/tsconfig.json && vitest run tests/e2e` —
the isolated `*.e2e.ts` lane config was never written (it is step 1's second half, unreached).

Prior spec context: `mem:spec-foundation-journeys-hand-transcribed`.
