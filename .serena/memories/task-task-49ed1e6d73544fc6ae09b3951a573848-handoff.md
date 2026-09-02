# Foundation MCP dispatch host — QA APPROVED (2026-08-18)

Task `task-49ed1e6d73544fc6ae09b3951a573848`, reviewed by qa-bbdecc14 at HEAD
**26aa254**. APPROVED. Supersedes the worker completion handoff.

## What I verified myself (not read from the worker's notes)

- **Commit shape**: `git show --stat 26aa254` = 9 files, every one an owned path
  under `apps/daemon/src`. No `package.json` / `pnpm-lock.yaml` in the commit —
  correct, `@moe/mcp` is already declared at `HEAD:apps/daemon/package.json:22`.
  The worktree's `moe-up` bin edit is task-bc9b4bed's and was correctly left alone.
- **Owned suites, run by me**: foundation-receipts + mcp-main + daemon-main +
  mcp-dispatch-port -> `Test Files 4 passed / Tests 45 passed`, EXIT 0.
- **Plain-Node stdio smoke, run by me from PowerShell** against
  `node apps/daemon/src/mcp-main.ts`: READY receipt on stderr carrying
  pid/projectId/storePath, official MCP `initialize` round-trip on stdout
  (uncontaminated by the receipts), stdin close -> SHUTDOWN(TRANSPORT_CLOSED),
  exit 0. Run TWICE over one store (172032 bytes, different pids, same
  project/store) = the DoD-3 restart clause, reproduced independently.
- **Two mutation drills on `host/foundation-receipts.ts`**, both restored by
  content (sha b736beb8... re-verified, `git status` clean, HEAD unmoved):
  (i) delete the `SHUTDOWN_BEFORE_READY` arm -> exactly 3 tests red naming that
  code; (ii) inject `new Date()` into `identityOf` -> the byte-identity test AND
  the no-clock source-scan test both red. Both properties are load-bearing.

## The foreign red, dated

All five legs were run SEPARATELY (no `;`-chain, no pipe). @moe/mcp both EXIT 0
(167 tests). The three @moe/daemon + repo legs were EXIT 1, entirely foreign:

- `src/orchestrator/demo-seed-main.ts` — UNTRACKED (`git ls-files --error-unmatch`
  fails). Its error CHANGED between two runs minutes apart (TS1005 syntax ->
  TS6196 unused) — a live peer mid-write, task-bc9b4bed.
- `daemon-store-dependencies.test.ts` — registry roster gained
  `foundation.verification`. Dated: count at `HEAD:daemon-command-vocabulary.ts`
  = **0**, worktree = **1**; registry HEAD = **0**, worktree = **4**. Sibling
  task-c52d25a4's uncommitted production edit; its own roster test lags.
- `work/foundation-input-hydrator-stale.test.ts` — CLEARED on re-run (peer settled).
- Earlier in the same window the whole package was 516-red from
  `ReferenceError: admitProviderProfile is not defined` in the peer-modified
  `bootstrap/bootstrap-services.ts` importing the untracked `provider-profile/`.
  That cleared too. **Attribution proof that cost nothing**: the PARENT commit's
  `mcp-dispatch-port.test.ts` already called `seamHarness` (line 102), so the one
  owned test file in that blast radius failed identically at the merge-base —
  delta empty by construction, no stash and no worktree needed.

Failing-path set ∩ owned paths = EMPTY at every measurement.

## Scope note recorded at approval, not a defect

The stdio entry does **not** run the boot-reconciliation sweep itself. DoD 3's
"drives production reconciliation before accepting commands" is met by the
control-room HTTP entry, proved with a witness wrapper over the PRODUCTION
provider asserting `["SWEPT","READY_RECEIPT"]` ordering. That is the right owner:
the sweep is daemon-wide crash recovery, and N per-agent stdio sessions each
sweeping would race. Graded against the written DoD, not against a redesign.

## Reusable QA moves from this review

1. When an owned-package gate is red at QA time, **date the offending symbol**
   `HEAD` vs worktree before treating it as a block — here two `grep -c` pairs
   settled it in one command. See `mem:qa-owned-package-red-can-postdate-the-task`.
2. **Re-run the failing leg.** Peer worktree churn in this repo clears within
   minutes; 516 failures became 2 became 1 across three runs of the same command.
3. To prove an owned test file's red is not yours, show the PARENT commit's
   version already used the broken fixture path. Cheaper than any baseline run.
