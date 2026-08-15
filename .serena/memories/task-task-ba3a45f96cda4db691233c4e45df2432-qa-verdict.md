# QA verdict on task-ba3a45f96cda4db691233c4e45df2432 — APPROVED (pass 2)

qa-812c17a0, 2026-08-09, against commits 504b682 + reopen fix 85ea616.
(Supersedes the pass-1 REJECT recorded here.)

## Pass 1 (commit 504b682) — REJECTED, one issue

Everything passed except a surviving reorder mutant: moving `checkSlotCeiling`
below `claimSlot` in `work-claim.ts` left all 256 tests green. The ordering test
fixture used ACTIVE slot rows, so only ONE guard could refuse and the assertion
could not fail on order. Full pattern: `mem:gotcha-guard-order-mutant-survives-when-only-one-guard-can-refuse`.

## Pass 2 (commit 85ea616) — the fix, re-verified independently

`git show --stat 85ea616`: exactly one path, `apps/daemon/src/work/work-claim.test.ts`,
+15/-3. `git diff 504b682..85ea616` touches NO production file — the fix is one
added case plus a rename of the old over-claiming title, exactly as directed.

The added case (`work-claim.test.ts:460`) sets `liveClaims = live(4)` AND
`slot.rows[0].state = "PENDING_ACQUIRE"`, so BOTH guards can refuse, then pins
code `WORK_SLOT_EXHAUSTED`, leg `slotCeiling`, layer `AUTHORITY`, upstream null.
Fixture helpers (`withPayload` JSON deep-clone, `at`/`listAt`/`firstOf`) throw on
a bad path, so a silently-no-op mutation is not reachable.

QA re-ran, did not trust the worker's numbers:
- `pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test`
  exit 0, **12 test files / 257 tests** (12, not zero — the app-root config trap
  `mem:gotcha-vitest-app-root-config` did not fire).
- QA's own fresh reorder mutant: **KILLED**, 1 failed / 256 passed,
  `expected 'WORK_SLOT_RESOURCE_INACTIVE' to be 'WORK_SLOT_EXHAUSTED'`.
  Restored with `git checkout --`; gate re-ran green 257/257 afterwards.
- `wc -l`: largest production source `work-kernel.ts` 239; all nine under 250.
- Forbidden-affordance sweep over production `src/work/`: no Date.now,
  Math.random, child_process/spawn, fetch, require, @moe/store, node:http.
- Working tree clean for `apps/daemon`, `packages`, `pnpm-lock.yaml`.

## Carried forward from pass 1, re-confirmed by the green gate

DoD 1 (per-leg injection table pins code + leg + layer + upstreamCode; successor
keys structurally ABSENT on refusal), DoD 2 (decode-before-authority ordering
proof, decoder codes preserved verbatim, frozen nested results), DoD 3 (stale
token vs stale epoch separately coded per handler; both orderings of both races,
loser pinned to `WORK_LEASE_NOT_CURRENT` / `AUTHORITY_STALE_LEASE`), DoD 4 (now
fully pinned, incl. the no-queue/no-retry serialized-result sweep), DoD 5.

## QA process note

Restoring a mutation drill: `git checkout -- <path>` resolves the pathspec
against the SHELL's cwd, not the repo root. A stale `Set-Location` made a restore
silently fail with `pathspec ... did not match`, while a following
`git status --porcelain -- apps/daemon` also matched nothing and read as clean.
Verify a restore with `git status --porcelain` unscoped, or `git rev-parse
--show-prefix` first.
