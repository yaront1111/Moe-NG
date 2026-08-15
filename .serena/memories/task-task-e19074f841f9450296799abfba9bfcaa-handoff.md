# task-e19074f841f9450296799abfba9bfcaa — QA VERDICT: APPROVED (DONE)

Genesis recovery binding for first-boot authentication. Approved by qa-50f0d628, 2026-08-15.
Replaces the worker handoff; keep the worker's technical notes below by reference.

## What I re-ran (nothing taken on trust)
- Gates fresh in foreground, exit codes captured to a FILE (never piped — `| tail` reports tail's
  exit code): daemon typecheck 0; daemon 75 files / **1600** tests; store 41 / 469.
  1600 vs the worker's 1599 is foreign uncommitted activation work in the tree, not a regression.
- **DoD 3 drill run by ME**, not read from the step note. Mutated `session-authenticator.ts:102`
  `=== null` -> `=== undefined`. Named production-boundary test reddened on its OWN assertion:
  `genesis-first-boot.test.ts > "refuses the operator on an unbound store, silently and without a
  refusal"` — *expected UNAUTHENTICATED, got a principal*. Restored from a byte copy in /tmp
  (NOT `git checkout` — that reverts to HEAD and would eat foreign uncommitted work), sha256 back
  to `b8203c9a5a09e510b7fe4d92a25fb3b1c8187633f3c69fcd2dafe42e54a9035e`, git diff clean.
- **DoD 5 smoke run by ME** as a real plain-Node child on an empty new dir: exit 0,
  `{"ok":true,"restoreOutcome":"GENESIS_FENCED","verdict":"AUTHENTICATED"}` echoing MY
  principalId/projectId — a relational echo, so it cannot be a canned fixture.

## The two things a reviewer here will trip on
1. **The production file is not in the task's own commit.** `275986a` carries only tests + the
   `.mjs`. `genesis-recovery-binding.ts` was swept into foreign whole-tree commit `139f11c`
   (task-df29871). Per epic rail this is NOT a rejection reason. Review by
   `git diff ab45234..HEAD -- apps/daemon/src/identity/ apps/daemon/src/recovery/`.
2. **`refuseOrAdopt` is out-of-plan.** Plan step 3 said a refusal settles GENESIS_INSTALL_REFUSED,
   full stop. The worker added a re-read that adopts a valid slot. FORCED, not creep: the winner
   anchors immediately after installing, that anchor IS authoritative history, and the pristine
   guard checks history BEFORE the slot — so the loser died `GENESIS_RECOVERY_BINDING_FAILED` over
   a perfectly well-fenced store. It mints nothing and the history refusal still holds
   (`genesis-recovery-binding.test.ts:698` pins `RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT`).

## Verified composition (DoD 2)
`ensureGenesisRecoveryBinding` has exactly ONE production caller: `daemon-store-dependencies.ts:98`.
The other grep hits are `genesis-first-boot-worker.mjs` and `restore-test-harness.ts`, both
test-only — I checked the harness has zero production importers before crediting that.

## Anti-vacuity checks that passed
Race asserts `["ABSENT","ABSENT"]` (proves the collision really happened, not a sweep that generated
zero cases); clobber asserted on COMMITTED digests, not on genesis's summary; refusals pin code AND
layer AND refusing component. See `mem:gotcha-plain-node-smoke-fails-from-git-bash`.
