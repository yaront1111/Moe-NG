# task-df29871bfc2441659efb3f763ddb23db — QA APPROVED (after reopen #1)

Durable activation authority ledger, `apps/daemon/src/activation/` (12 files).
Verified 2026-08-15 by qa-50f0d628. Supersedes the worker's "back in REVIEW" note.

## The reopen-#1 defect is closed, and I proved it independently

Rejection was: the adapter answered a REPLAYED disposition from the CALLER'S
record, so a drifted candidate got back authority for a grant never written
(root cause: `mem:gotcha-store-replay-identity-excludes-the-events-array`).

Fix landed as `answerReplayed(store, aggregateId, candidateDigest)` in
`activation-ledger-commit.ts`, taken only on `disposition === "REPLAYED"`:
`store.readEvents` -> `readActivationLedgerRecord` -> re-encode -> compare
CANONICAL DIGESTS -> return the DECODED record. Reader refusal propagates
verbatim as UNKNOWN; digest disagreement raises the new closed-vocabulary code
`ACTIVATION_LEDGER_REPLAY_DIVERGED` (REFUSED, `storeCode: null`, and the null IS
the layer discriminator — every store-raised refusal in the suite carries an
upstream code). COMMITTED still answers from the encode, deliberately, so the
`calls === ["commitExpectedVersionDecision"]` no-apply-callback assertion holds.

## My three drills (sha256 before, Edit, focused run, Edit back, sha256 -c)

- **A — revert the REPLAYED branch to the old echo.** Both replay tests red, each
  on the assertion that owns it: the positive one on
  `expected [ 'commitExpectedVersionDecision' ] to deeply equal [ …(2) ]`
  (readEvents absent), the drift one on `expected true to be false` — literally
  my original repro. **This is the drill the rejection demanded.**
- **B — disable only the digest cross-check** (`sealed.digest !== sealed.digest`).
  Exactly 1 red, the drift test; the positive replay stays GREEN. Clean
  separation: the READ alone does not carry the test, the COMPARISON does.
- **C — separator-only join, length prefixes dropped**, on
  `deriveActivationAggregateId`. Red: `expected 11 to be 12`. This is the mutant
  that survived green at reopen #1 and is what my non-blocking COLLIDING_PAIRS
  note asked for; the worker added ("a|b","c")/("a","b|c") plus a premise test
  pinning that the rows collide under BOTH the bare join and the separator-only
  join. Closed and load-bearing.

All 8 files `sha256sum -c` byte-exact after restore; `git status` shows only
`.moe/**`. Restores used the Edit tool, never `git checkout`.

## Gates I re-ran myself (fresh, foreground, `&&`-chained, redirected to files)

    pnpm --filter @moe/daemon typecheck -> EXIT 0
    pnpm --filter @moe/daemon test      -> EXIT 0, 75 files / 1600 tests
    pnpm --filter @moe/store test       -> EXIT 0, 41 files / 469 tests

No foreign red this time — the `recovery/restore-controller.test.ts` failure I
disclosed at reopen #1 is gone, fixed by its owner.

## DoD spot-checks worth reusing

- DoD 1 nouns counted against `ACTIVATION_LEDGER_RECORD_KEYS`: 12 keys cover all
  10 enumerated facts plus recordVersion/activationVersion. Nothing shipped short.
- Per-file lines (`grep -c ''`): contracts 244, codec 236, commit 210, reader 71,
  fixtures 149. All under the 250 target.
- Bridge hygiene is self-verifying: `runtime-entrypoint.test.ts:179` is green, so
  the four runtime modules have correct `.js` bridges and `fixtures.ts` correctly
  has NONE (test-tier, no test sibling — the `work-race-fixtures.ts` precedent,
  `mem:gotcha-bridge-guard-classifies-by-test-sibling`).
- Focused daemon runs need `--root . --config package.json` — it is already the
  package's own `test` script. I ran an unmutated positive control first (10
  tests found) before trusting any drill red.

## Commit-label hazard fired for the second time

`0a53ac0`, labelled task-e19074f841f9450296799abfba9bfcaa, carries this task's
bytes; `37bd93b` labelled with THIS task id carries only `.moe/**`. Per the
global rail that is never a rejection reason. Reviewed by base-ref diff
`git diff 139f11c..HEAD -- apps/daemon/src/activation/` (+174/-8) and confirmed
working tree == HEAD for the owned paths, so the committed bytes are the gated
bytes.

## Open for the next task

Consumer edge. Nothing outside `apps/daemon/src/activation/` imports this yet;
`task-e33747f982e0452a9f9d784fd1cb914d` is the recorded production consumer,
which satisfies global clause 1 option (a) — but only until that task lands.
