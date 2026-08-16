# task-97554aa4 Foundation self-host canary — architect output 2026-08-17

Re-blocked at step 1, then swept the whole PLANNING queue on the human's
"plan all". Governor's 15:04Z cascade claimed "THE CANARY'S PREREQUISITE LIST IS
COMPLETE"; re-measurement at committed HEAD **a42ae2f** says otherwise.

Measured with `git grep <sym> HEAD`, never the working tree (shared checkout is
foreign-dirty).

## Seven capabilities, re-measured

| # | capability | verdict |
|---|---|---|
| 1 | MCP host | CLOSED — mcp-http-main.ts:6, mcp-main.ts:11 |
| 2 | agent wrapper | CLOSED — agent-wrapper-main.ts |
| 3 | pinned Claude launcher | **OPEN — GAP A** |
| 4 | verifier receipt path | exists (node-verifier.ts:176) but see GAP E |
| 5 | restart reconciliation | **CLOSED** — gap B really did land |
| 6 | coordination adapter | DESCOPED (comment-6785a05f) |
| 7 | review-qualified acceptance | CLOSED — review-services.ts:161 |

Gap B verified closed: `startDaemon` → `runBootReconciliation` → `port.sweep()`
→ `createBootReconciliationPort` (daemon-store-dependencies.ts:165) →
`readInFlightFoundationAttempts` + `reconcileOnRestart`.

## GAP A — producer landed, consumer never did

`task-6cbff010` shipped the attempt-dispatch service; **nothing calls it.**
Global rail Clause 1 verbatim. DONE ≠ reachable —
see `mem:deps-done-is-not-deps-reachable`.

- `createFoundationAttemptService` (work/foundation-attempt-service.ts:97) — 0
  production callers; only its own two test files.
- Its `captureResult` port (:41) — 0 production implementations.
- `createFoundationClaudeLauncher` (activation/foundation-launch-authority.ts:290)
  and `createClaudeRuntimePinRequest` — sole caller is that unreached service.
- `activation-telemetry-launch.ts` `launchClaudeWithTelemetry` (:95) — 0 callers.
  **`activation-ingress.ts` (the reachable `effect.activate` handler) imports no
  launch module at all** — it records activation, never spawns.
- The REAL spawn path is `agent-wrapper-main.ts:256 claudeSpawnStarter` →
  `agent-spawner.ts:352 spawnRuntime` — raw `node:child_process`, zero
  `@moe/runner`, zero pin. **Two launch paths exist; only the unreachable one is
  pinned.**

Owner already on the board: `task-a9fd91c3` (BLOCKED). Do NOT file a duplicate.

## GAP E — filed as task-4dd4424c, now BLOCKED at its own gate

`agent-wrapper-main.ts:240  verificationAuthority: () => null` with the shipped
comment "No production authority provider is shipped yet."
node-verifier.ts:165-172 turns null into `VERIFICATION_AUTHORITY_UNAVAILABLE` for
every node, so `recordVerifierReceipt` (:176) and the `integration.accept_output`
dispatch (:152, :198) never fire from the real wrapper.

**I GOT ONE FIELD WRONG.** My planning notes claimed package items were derivable
from `readReviewLedger`. They are not — the worker measured it and blocked
correctly. `submitRound` (review-services.ts:112-141) parses `packageItems`,
binds them via `buildReviewPackage`, stores only `built.value.reviewInputDigest`,
and DISCARDS the items. `ReviewRoundRecord` (review-read-model.ts:21-30) has no
items field; the request bytes are unrecoverable because
`CommandDecisionRecordBase` (store-contracts.ts:86-106) keeps `requestSha256`
only. So 2 of 3 `VerifierAuthorityFacts` fields lack a durable source:

- `policy` — OK. `installPolicy` (bootstrap-policy-services.ts:42-61) folds
  `{slices:{[sliceRef]:slice}}` behind `PolicyInstalled`.
- `calibration` — no durable writer. Only `review-test-fixtures.ts:249`.
- `packageItems` — no durable source. Every production instance of those kinds is
  a synthetic literal (`PACKAGE_ITEM_FILL`, `hex64()`).

Filed two prerequisites (both BACKLOG, CRITICAL, independent):
`task-92031b0a` persist package items alongside their digest (durable-payload
change → full regression + back-compat); `task-5edf037f` durable reviewer
calibration (prefer policy.install's slice mechanism; the command vocabulary is
frozen with a full-coverage ratchet).

## Chain

```
GAP A: dd4ffa0c-split + efc2ef63 + a3e8a02d -> a9fd91c3 -> canary
GAP E: {92031b0a, 5edf037f} -> 4dd4424c -> canary
```

## Plan-all sweep, same session

Planned 5: `4dd4424c`, `05b0a693`, `495ad5e8`, `14ea45a5`, `a3e8a02d`.
Not mine: `dd4ffa0c` + `efc2ef63` (architect-f956ffe1; dd4ffa0c since SPIDR-split
into `ee27ed7c` + `77e8cb44`), `8f9305b9` (already CODING). `submit_plan` refuses
a task another architect holds — claim through `claim_next_task`, don't submit by id.

**`495ad5e8` and `14ea45a5` are CROSS-REPOSITORY.** `git rev-parse
--show-toplevel` = D:/projexts/moe-next (a42ae2f) vs D:/projexts/moes (33f8c76) —
two separate repos. moe-next has zero staging/commit code and no hooks block in
`.claude/settings.local.json`. Both plans gate on an explicit human rail-2
exception; `495ad5e8` is blocked awaiting it (msg-d9710c17). Their steps carry
EMPTY `affectedFiles` deliberately: the daemon validates those paths against the
moe-next root and rejects the plan otherwise.

Also corrected there: the completion hook ALREADY stages by pathspec
(ps1:2320-2325, sh:2976-2978). The real leak is the **bare `git commit`**
(sh:2997, ps1:2338) over the shared index, plus the `git add -A` fallback when
`filesModified` is empty, plus two silent-drop paths in the mention extractor
(`2>/dev/null || true`, `|| echo 0`).

## Unblock test — greps, never statuses

```
git grep -n "createFoundationAttemptService" HEAD -- apps/ | grep -v '\.test\.'
git grep -n "verificationAuthority"          HEAD -- apps/ | grep -v '\.test\.'
```
Gap A clears when the first returns a non-test daemon caller. Gap E clears when
the second no longer shows `() => null`. Canary steps 2-8 need no edit.

## Traps carried forward

- `packages/testkit/src/foundation/foundation-model-j3j4.ts` would make a green
  J3/J4 trivial to fake — the mock-backed journey this gate must refuse.
- `SESSION_FAMILY` is a decoy for coordination (session *credential* lifecycle).
- `createFoundationVerificationService` (evidence/…:51) also has 0 production
  callers — a second unused evidence surface, distinct from node-verifier.
- Graph revision events carry `graphContentHash`/`planHash` STRINGS only, never
  the `GraphSnapshot` — a fold cannot materialise one.

Related: `mem:deps-done-is-not-deps-reachable`,
`mem:decision-measure-consumer-edges-not-task-status`,
`mem:gotcha-board-promotes-tasks-ahead-of-their-dependencies`.
