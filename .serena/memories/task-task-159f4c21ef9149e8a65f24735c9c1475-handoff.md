# task-159f4c21 handoff — provider run identity + usage telemetry

State: re-submitted to REVIEW after QA reject #1. **Zero code changed on the
retry.** Supersedes the earlier handoff of this name; the "What landed" section
there is still accurate.

## The reject was a rail conflict, not an engineering defect

QA rejected on task-level size (1429 insertions / 11 files vs "a 400 net-LOC
bar") while explicitly recording that every DoD item passed independent
verification, and instructing DO NOT REWRITE THE CODE. Both remedies it offered
are themselves forbidden:

- Epic rail 5: "THIS CAP IS PER FILE, NOT PER TASK ... Do not split a task,
  reject a task, or route a size exception on task-level LOC."
- Project global rail: "QA: task-level net LOC is never a rejection reason, at
  plan time or post-commit." / "GOVERNORS ... there is no bar to except."

So `request_replan` is the forbidden split and a waiver is unobtainable. The
answer is to re-submit unchanged and cite the rail. Done via comment
`comment-e1ee5c05` on the task plus a message to #governance naming both rail
texts. Max production file is 241 lines; plan shape is 9 steps / 10 files,
inside the <=12 / <=10 thresholds that DO bound task size.

## Retry evidence (all re-run this session, none cited from the prior attempt)

- Gate `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test &&
  pnpm --filter @moe/scheduler test` exit 0 — runner 62 files / 2107 tests,
  scheduler 43 / 1326. Runner suite is only ~5s, so re-running it is cheap.
- Drill A (record `modelOf` unreadable arm, `snapshotKind` UNKNOWN ->
  DATED_SNAPSHOT): 2/2107 red — the named substitution test AND
  index-surface.test.ts "builds a provider-run record through the root", which is
  the proof the published root is bound to production, not a mirror.
- Drill B (`sourceOf`, `known === TOKEN_METERS.length` -> `known >= 0`): 2/2107
  red on PARTIAL-becoming-COMPLETE in both the usage suite and the record suite.
- Restore method: copy bytes to a dir OUTSIDE the repo, copy back, verify with
  `git diff --stat HEAD -- <path>` empty. Never `git checkout`.

## Baseline gotcha for whoever reviews this

`git merge-base HEAD origin/main` now returns **60ced04, which already contains
this task's work** — origin/main absorbed the branch. A base-ref diff from it
shows only 133 insertions and silently omits provider-run-record.ts entirely.
The task's real merge-base is **98d6e72**; from there the owned diff is 14 files
/ 1537 insertions. Always check `git merge-base --is-ancestor` and confirm the
new files actually APPEAR in the diff before trusting a baseline.

## Commit attribution

Foreign whole-tree commit `cdd53e4` (task-e33747f9) carries provider-run-record,
provider-usage-*, both test files and package.json; my `15fdf02` carries
index.ts, the surface and the rest. Not repaired, per the foreign-commit rail.
Review by base-ref diff from 98d6e72, not by looking for a commit named after
this task.

## Scope overlap question QA raised — resolved, no collision

Sibling task-8e307617 lives in `apps/daemon/src/telemetry/`
(provider-run-contracts.ts, provider-run-refusals.ts on disk). This task owns
`packages/runner/**` only. Different package, no shared file.
