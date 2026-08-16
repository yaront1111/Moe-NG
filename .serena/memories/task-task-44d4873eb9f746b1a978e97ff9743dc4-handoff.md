# task-44d4873e — Durable verification receipt dispatch

## Session of 2026-08-16 13:31-13:41Z (worker-5678886b, RESUME): STOOD DOWN, zero bytes written

A SECOND CLI session runs under the SAME workerId and was writing the owned paths throughout.
I am the later session. Detection, using hashes rather than mtime (mtime alone is too weak):

| time (UTC) | contracts.ts sha | test.ts sha | test lines |
|---|---|---|---|
| 13:34:42 | 8b662bf4 | e9f4dfcb | 587 |
| 13:39:43 | 01b782d1 | 822fe429 | — |
| 13:40:20 | 01b782d1 | e37e01e9 | 765 -> 814 in 37s |

Task JSON held step-3 IN_PROGRESS the whole time. Per `mem:gotcha-a-parallel-session-can-write-your-owned-files`
I wrote nothing and made no terminal moe call. Disclosure posted as msg-c55ccdfed6fd4c429de89a41f8dedaf7
in #general. The peer's design converged independently on the same one I derived from the producers,
so this was duplicated effort, not divergent effort — do not "reconcile" two designs that agree.

## State on disk when I stopped
- `foundation-verification-contracts.ts` 245 lines + its 1-line `.js` bridge — COMMITTED, swept into
  foreign whole-tree commit `0237cfc` (a task-aa32fdf7 completion-hook commit). Not mine to amend.
- `foundation-verification-service.test.ts` 814 lines, UNTRACKED, peer actively growing it.
- `foundation-verification-service.ts` DOES NOT EXIST yet. This is the remaining work.

## Findings I measured that the next session should not re-derive
1. **The daemon bridge-guard red is TRANSIENT and correct-by-ordering.** Full detail in
   `mem:gotcha-daemon-bridge-guard-is-tier-derived-not-per-module`. Do NOT delete the contracts
   `.js`; it becomes required the moment the service module lands.
2. **Orphan codes** — the peer's 13:39 edit dropped CAPTURE_TRUNCATED, EXECUTION_UNVERIFIED and
   CANDIDATE_CHANGED, and that call is correct by measurement, not by taste. See
   `mem:gotcha-wrapper-refuses-before-a-daemon-truncation-code-can-fire`.
3. **Gap still open at the time I stopped:** the closed list has RECEIPT_AMBIGUOUS (>1 row) and
   RECEIPT_UNREADABLE (row will not decode) but NO code for "this verification has no receipt at
   all". Plan step-6 demands that distinction explicitly. Answering an unverified id with either
   existing code claims a row exists.

## The composition, as derived from the landed producers (for whoever writes the service)
- Flow: exact-key fence on the request -> `readFoundationAttemptRecord` -> digest vs
  `expectedRecordDigest` (CANDIDATE_STALE) -> `record["truthClass"] !== "PROVEN"` (ATTEMPT_UNPROVEN)
  -> load sealed recipe by identity + `recipeSealMatches` -> commit ACTIVATED at expectedVersion 0
  -> `runVerifierProcess` -> `buildEvidenceReceipt` -> commit RECEIPTED at expectedVersion 1 ->
  answer from RE-DECODED durable bytes.
- **The VerifierActivation is the ATTEMPT's own activation-ledger record**: `{intent: record.effectIntent,
  attempt: record.attempt, grant: record.grant}` from `readFoundationActivationHistory`. Its grant is
  still UNUSED on the base record (the launcher's consume is a TRANSITION, not a rewrite), and its
  grantId already derives from the successor intent, which is the only way past `parseActivationGrant`.
  `wrapperIdentity` = `record.grant.wrapperIdentity`.
- `hermeticVerifierEnvironment` is applied INSIDE `executeVerifierRun` (verifier-process-run.ts:229),
  so the caller passes a `baseEnvironment`; applying it caller-side too is idempotent and is what the
  evidence-surface doc-comment asks for.
- Receipt identities must satisfy `isEvidenceIdentity`, which is just `isBoundedEvidenceText`
  (<=400 chars, NFC, well-formed). The durable record's `nodeKey` / `sessionId` / `effectId` qualify.
- `outputs: []` and a recipe with `declaredOutputPaths: []` — any declared output the request cannot
  name produces `RUNNER_EVIDENCE_OUTPUT_MISSING` from the runner, which is the honest layer.
- Receipt payload must never carry `VerifierCapture.bytes` (a Uint8Array serialises as an index map);
  `verificationReceiptBody` already picks only sha256/truncated/exit/timing.

## Gates measured fresh this session (both legs read for OUTPUT, not exit code)
- `pnpm --filter @moe/daemon typecheck` EXIT 1, exactly one error:
  `src/evidence/foundation-verification-service.test.ts(41,8): error TS2307: Cannot find module
  './foundation-verification-service.js'`. Everything else in the 814-line test typechecks.
- `pnpm --filter @moe/daemon test` EXIT 1, `Test Files 2 failed | 101 passed (103)`,
  `Tests 1 failed | 2100 passed (2101)`. Both failures are this task's own TDD-RED state (see
  finding 1). No foreign red observed in the daemon package at 13:35Z.

## Consumers to name at completion (plan step-6)
task-8f9305b9bb5e4b8db327a55981b2ea0e (Review-qualified goal closure), then the Foundation canary
task-97554aa4293e40eab56c0b642e18513a.

---

## Session of 2026-08-16 13:43-13:47Z (worker-5678886b, RESUME again): STOOD DOWN A SECOND TIME

The wrapper re-dispatched me ~2 minutes after the previous stand-down, into the SAME live-peer race.
Standing down does not stop the wrapper. Zero bytes written again. Disclosure:
msg-6c39032767d443a6a343700d605083ed in #general (chan-ced99359298945b39ae4709bf92992a6).

Liveness, three sha samples around real work — session start 13:43:30Z PRE-DATES every write, so
this is a live peer, not my own dead prior session:

| time (UTC) | service.ts | test.ts |
|---|---|---|
| 13:43:36 | 317 lines aaf01220 | 877 lines c915e7d2 |
| 13:44:00 | 328 lines 08ab515f | 881 lines a8aec656 |
| 13:45:19 | **177 lines** 73c5b614 | 881 lines a8aec656 |

**A production file that SHRINKS is plan step-5's sibling-module split in progress, not damage.**
No sibling file existed on disk yet at 13:45. Do not "restore" it. Task JSON still WORKING,
steps `C C C C P P P`, updatedAt 13:41:14Z — the peer had not closed step-5.

I deliberately did NOT call `report_blocked`: it flips the task to BLOCKED and would make the live
peer's `complete_step` fail mid-flight. Standing down with no terminal moe call is correct here.

### What changed on disk since the previous session
- `foundation-verification-service.ts` + its 1-line `.js` bridge NOW EXIST (untracked).
- `pnpm --filter @moe/daemon typecheck` **EXIT 0** at 13:43:5xZ, no diagnostics. The TS2307 that both
  the step-3 and step-4 notes recorded is CLEARED — the peer's service and the 881-line test
  typecheck clean together. This supersedes the EXIT 1 line in the section above.

### Two adversarial findings, measured at service.ts sha 08ab515f (328 lines)
That file was rewritten to 177 lines 79 seconds later, so LINE NUMBERS ARE STALE. Both findings are
structural and should survive the split; re-locate before acting.

1. **RECEIPT_AMBIGUOUS has two producers with OPPOSITE meanings.** At `readStoredReceipt` (:129) it
   means ">1 RECEIPTED row exists". At the tail of `verify()` (:315) it is returned when
   `commitPhase(RECEIPTED)` returns FALSE — i.e. ZERO rows written. One code for two opposite durable
   states; the contracts doc-comment's claim that "every member has exactly one producer" is false for
   this member. The closed list carries ACTIVATION_UNCOMMITTED with no RECEIPT_UNCOMMITTED analogue —
   that is the missing member. Note this is the mirror of finding 3 above (which the peer DID fix by
   adding RECEIPT_ABSENT).
2. **The replay guard is structurally unable to see `candidateRoot`.** `verify()` compares
   `prior.row` recipeSha256 / recordDigest / attemptAggregateId against the request, but
   `verificationReceiptBody()` writes NO candidateRoot field. A replay naming a different
   candidateRoot returns the prior PASSED receipt as though that root were verified — no run, no
   conflict. That is precisely DoD 4's "changed candidate produces a distinct refusal". Fix by
   binding candidateRoot into the row and comparing it, or state in the contract why the record
   digest alone is the material candidate identity.

NOT a finding, recorded so a later reader does not misread it: REPLAY_CONFLICT / RECEIPT_ABSENT /
RECEIPT_AMBIGUOUS / RECEIPT_UNREADABLE had 0 occurrences in the test file at 13:45. Those are plan
step-6's cases and step-6 was PENDING. Only rejectable if it survives to completion.

---

## Session of 2026-08-16 13:49-13:52Z (worker-5678886b, RESUME #3): STOOD DOWN A THIRD TIME

Wrapper re-dispatched me a third time into the SAME live-peer race. Zero bytes written, no terminal
moe call. Disclosure + both findings below posted as msg-59ae5fa2d11d4b51b42d34774108edac in
#general (chan-ced99359298945b39ae4709bf92992a6).

THREE RE-DISPATCHES INTO ONE LIVE PEER IS A PATTERN, NOT AN INCIDENT. The Moe claim is not
exclusive across CLI sessions sharing a workerId. The stand-down decision does not need re-deriving
a fourth time: `report_blocked` flips the task BLOCKED and breaks the peer's in-flight
`complete_task`; `complete_task` would be a false claim; `complete_step` is already done by the
peer. No terminal call is the correct terminal state here.

Liveness — four samples, my session wrote nothing across all of them:

| time (UTC) | test.ts | store.ts | task JSON steps |
|---|---|---|---|
| 13:49:02 | f3a1c580, 1016 lines | 0921e19e | C C C C C I P (step-6 open) |
| 13:49:45 | 51f75d78 (moved while I only READ) | 0921e19e | — |
| 13:50:36 | 1088 lines | — | C C C C C C I (step-6 CLOSED 13:50:01Z, step-7 open) |
| 13:51:37 | 51f75d78 | **30007712** (moved) | C C C C C C I |

`service.ts` also moved and moved BACK inside one minute: my Read saw `verificationReceiptBody(`
at :165, a grep ~90s later put the same call at :172, and the sha was bf3dae75 at both ends. That
is a step-7 MUTATION DRILL applied and restored, which is what step-7 is. Note the peer cannot use
`git checkout --` to restore service.ts/store.ts: both are UNTRACKED
(`mem:untracked-deliverable-cannot-be-drill-restored-by-git`); only contracts.ts and test.ts are
tracked, swept into foreign whole-tree commits 0237cfc and f7755b1 respectively.

### TWO ADVERSARIAL FINDINGS, measured on disk at 13:50Z — hand these to QA if they survive

**A. DoD 4 IS NOT MET: the replay guard is structurally blind to `candidateRoot`, and the test that
claims to cover it is answered by a co-varied discriminator.** This is finding 2 of the previous
session, now CONFIRMED against step-6's landed test rather than predicted.
- `foundation-verification-service.ts:116-118` compares exactly `prior.row["recipeSha256"]`,
  `["recordDigest"]`, `["attemptAggregateId"]`. Not candidateRoot.
- It CANNOT compare it: `verificationReceiptBody` (contracts.ts:200-215) writes no candidateRoot
  field. `grep -rn candidateRoot` over the three production files returns ONLY the request type
  (:151), the key list (:158) and the pass-through into `runVerifierProcess` (:137). It never
  reaches durable state.
- The test at `foundation-verification-service.test.ts:965` varies candidateRoot AND
  recipeAggregateId TOGETHER (recipe-first EXIT_ZERO vs recipe-other EXIT_THREE, different argv,
  therefore different sealed sha256). The recipeSha256 clause answers; the assertion passes with
  candidateRoot entirely unbound.
- POSITIVE CONTROL that settles it: hold recipeAggregateId and expectedRecordDigest fixed, vary
  ONLY candidateRoot. Current code returns the prior PASSED receipt for a candidate root it never
  verified — no refusal, no run. See `mem:gotcha-conflict-test-co-varies-two-fields`.
- Fix: bind candidateRoot into `verificationReceiptBody` and add the clause at :116; or state in
  the contract why the record digest alone is the material candidate identity — but then the test
  must stop calling candidateRoot the varied thing.

**B. `FOUNDATION_VERIFICATION_RECEIPT_AMBIGUOUS` has two producers meaning OPPOSITE durable states.**
Unchanged from the previous session and still present.
- `foundation-verification-store.ts:113` — raised when MORE THAN ONE RECEIPTED row exists.
- `foundation-verification-service.ts:~173` — raised when `commitPhase(RECEIPTED)` returns false,
  i.e. ZERO rows written.
- `contracts.ts:47` asserts "every member has exactly one producer": false for this member. The
  closed list carries `ACTIVATION_UNCOMMITTED` (:68) with no `RECEIPT_UNCOMMITTED` analogue — that
  is the missing member, and adding it restores single-producer for every code.
