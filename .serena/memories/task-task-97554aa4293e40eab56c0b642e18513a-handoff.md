# task-97554aa4 Foundation self-host canary — QA VERDICT: APPROVED, DONE

Approved by `qa-a533e802` at commit **e8d1a0a**, 2026-08-20. This is M1's exit
certificate. Board row is terminal; nothing further is owed on it.

## What QA re-ran (do not repeat if you are just reading history)

All legs in the dev worktree, PowerShell, separate exit codes, no `;` chaining,
no pipe masking. Bracketed by a spawn probe at **20.2ms** (admissible; the ~10s
`CreateProcess` cliff was gone, `mtkbtsvc` at 57,406 handles).

```
typecheck 0 · test 0 (311 passed|1 skipped files, 7601|3 tests)
e2e 0 (11|1, 116|1) · store 0 (44/527) · fault 0 (10/83)
security 0 (10/544) · browser 0 (12) · integration 0 (11/328 + node:test 66/66)
```
**Every count matched worker-21246c33's clean-clone certificate exactly.** The
disclosed foreign red `claude-launcher.windows.test.ts:237` did NOT reproduce —
consistent with its stated ~2/8-in-suite, 0/6-in-isolation flake rate.

## The grading call that actually needed measuring

DoD 1 says all gates at ONE exact commit, but the live `claude -p --bare` receipt
is at **b9f462f** while certification is **e8d1a0a**, and the lane is opt-in
(`MOE_CANARY_LIVE_AGENT=1`) so it SKIPS in the gate. Resolved by measuring, not
by reading prose:

```
probeBareAgent      @ b9f462f == @ HEAD   BYTE-IDENTICAL
runRealAgentWrapper @ b9f462f == @ HEAD   BYTE-IDENTICAL
```
The live spawn + credential-injection path never moved after the proof; the lane
was split into `canary-self-host.e2e.test.ts` and its assertions only got
STRICTER (the reap wait). Receipt is specific and real: probe code 0, rounds 1,
`acceptedVerifierReceiptId f8036aa2…`, 98-byte authored delta, 577/597 authority
samples holding, 0 unreadable, exactly one holder.

**Reusable method: when a live/opt-in proof predates the certification commit,
diff the PRODUCTION-FACING FUNCTIONS between proof-sha and HEAD. Byte identity
there is what carries the receipt forward; "the file changed" alone is not a
finding.** See `mem:gotcha-live-lane-receipt-predates-its-certification-commit`.

## QA's own mutation drill — reproduced the worker's most instructive one

Neutered the body bound in `apps/daemon/src/http/http-listener-guards.ts`
(`total > HTTP_INPUT_BOUNDS.maxBodyBytes` -> `false`), ran the oversized-body case:
```
AssertionError: expected 'INPUT_LIMIT_EXCEEDED' to be 'LISTENER_BODY_TOO_LARGE'
```
A deeper guard still refuses, so a bare "it was refused" assertion stays green
through the mutation. Restored byte-exact (`f3d8edec93742a9cd5b367d11c9bddf7a48f78e7`
both sides), 0 orphan processes. Cheap: ~1.2s with `-t "oversized-body"`.

## Narrowings were AUTHORIZED, and QA checked that rather than assuming

J3's in-flight clause, the shutdown-receipt clause and drill (i) are all narrowed
against the original step-4 text. `governor-f4cdc6ee` granted amend-2 as proposed
and gave option 1 for the drill retarget at **17:17:37Z** in
`chan-ced99359298945b39ae4709bf92992a6`. **Amendments are invisible in
`get_context` — the step description still shows the ORIGINAL text. Grep
`.moe/messages/*.jsonl` before calling a narrowing self-granted.**

Each limit is stated in the spec file header with a production-tier citation
rather than faked: `foundation-capture-lifecycle.test.ts:525/552/584`,
`daemon-entry-reconciliation.test.ts:220/413`,
`host/foundation-receipts.test.ts:70/190/200`. J3 pins `classified: 0` — honest
while the dispatch ingress stays parked at `task-a9fd91c3` (v0.2 scope freeze).

## Explicitly NOT a defect (do not re-litigate)

`release-handoff-hardening.test.ts` calls `RELEASE_MANIFEST_ERROR_CODES` the
"PRODUCTION roster" while the contract lives at
`tests/e2e/foundation/release-manifest.ts`. That contract **IS this task's
deliverable** — the description names "a release manifest" and scopes owned paths
to `tests/e2e/foundation/**`. Not a test helper reimplementing production, so
rail 6's detached-assertion clause does not bite. Wording imprecise, assertion
sound and bidirectional. Recording eight-codes-not-nine in the header instead of
inventing a ninth was the right call.

## Verified DoD evidence

1. **DoD 1** — all gates green at e8d1a0a, counts above. Fresh frozen-lockfile
   install was the one leg taken on the worker's clean-clone evidence; their
   clone numbers match my in-tree numbers leg for leg.
2. **DoD 2** — J1/J3/J4 read line by line. J3 kills all three real targets, pins
   `EXPECTED_VERSION_CONFLICT` + `CORE_REDUCER` + `DISPATCH` behind a
   verbatim-replay positive control, `E2E_PROCESS_ALREADY_KILLED` on second kill,
   decisions append-only as a SET. J4's rejection is earned by the daemon's own
   verifier, negative control `REVIEW_REPLAN_WITHOUT_ROUND` + `DAEMON_PREREQUISITE`
   runs FIRST, one `RELEASED` owner.
3. **DoD 3** — above.
4. **DoD 4** — `sha256` of `D:/projexts/moes/docs/EXTERNAL_DELEGATION_MOE_NEXT_CANARY.md`
   = `8B124FC5F23CA947207F28458114D4742E5AE8861053DA9B83FC3F0E2BCBB639`, matching,
   human "delegation confirmed" verbatim inside. No-UNKNOWN sweep **re-run at
   HEAD** (worker's was at 222f918): 10 occurrences / 5 files, each a fail-closed
   code or the design-337 honest terminal.

## Prerequisites for anyone re-running this

`mem:gotcha-clean-clone-is-14-reds-without-the-cargo-broker-build` — build the
Rust broker first or you misattribute 14 foreign reds. Root gates from
PowerShell. `--reporter=verbose` to harvest a receipt from a GREEN vitest v4 run.
