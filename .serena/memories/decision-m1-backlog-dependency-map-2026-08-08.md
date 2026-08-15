# M1 Foundation Preview — resolved BACKLOG dependency map (2026-08-08 20:10)

Dependencies in Moe are **prose inside `description`**, not fields
(`mem:moe-hard-dependencies-are-prose-not-fields`). Extracting them costs a pass over
`.moe/tasks/*.json`; this is that pass, so nobody repeats it. Extract with:

```sh
node -e "const d=require('./task-<id>.json');
  console.log(/Hard dependencies:([^]*?)(?:Owned paths:|Verification:|NOT in scope:|$)/.exec(d.description)?.[1])"
```

## The shape of this epic's tail: ONE bottleneck, not ten independent tasks

**8 of the 11 BACKLOG tasks depended on `task-55d5a898` Projection outbox core**, and a
second cluster funnels through `task-312c1de3` External effect supervisor and
`task-1e512b95` Evidence receipt pipeline. That is why governor-eae4fc53's mechanical
18:14 audit found ZERO promotable: the tail is a chain, and chains do not parallelize.

## The two shells that must NEVER be promoted to PLANNING

- `task-55d5a898` **Projection outbox core** — SPIDR parent shell, no work of its own.
  Its five children (a602b3d4, 82989467, 071173ab, 7617c00d, 791d7340) carry everything.
  **Its BACKLOG status is bookkeeping, not absence — the code is committed and real.**
  Closes via the labeled REVIEW-transit two-step (`mem:moe-backlog-to-done-transition-blocked`).
- `task-312c1de3` **External effect supervisor** — same pattern, deliberately BLOCKED,
  4 children (2580a578, 4a3b5ec0, ba3a45f9, 49acb856).

Planning a shell produces a plan for nothing. `task-97554aa4` Foundation self-host canary
is a third exclusion for a different reason: it gates on "every preceding SH task", so it
is the epic's cutover acceptance gate and cannot be planned meaningfully in advance.

## Resolved dependency edges (statuses as of 20:10)

| Task | Deps | Unmet |
|---|---|---|
| f837ce45 Session coordination fabric | contract registry, identity session, outbox core | none |
| 2f6ac0d1 Bootstrap application services | goal, planning graph, policy approval, outbox, claude adapter | none |
| 1e512b95 Evidence receipt pipeline | clean workspace, **supervisor**, outbox | supervisor |
| ba3a45f9 Daemon work services | supervisor children 1-2, lease presence, budget cores | children 1-2 |
| 79eddf12 Deterministic context journal | planning graph, lease, outbox, **1e512b95** | 1e512b95 |
| 58029c26 Independent review flow | + **1e512b95, 79eddf12** | 2 |
| 52ec1406 Crash reconciliation services | lease, outbox, **supervisor, 79eddf12, 58029c26** | 3 |
| 2d1f94f9 Live control-room seam | seven deps | **5** |
| 49acb856 Supervisor hardening gate | children 1-3 all DONE | all 3 |

## The disk fact that will mislead every architect on this epic

`packages/runner/src/supervisor/` holds child 1's **11 files, ALL UNTRACKED** —
`git ls-files` on that directory returns NOTHING. Read the working tree there, never the
index. Conversely child 2 (`task-4a3b5ec0`) had produced **zero** files at 20:10 despite
an approved plan naming `launch-lock.ts`, `drain-table.ts`, `drain-reconciliation.ts`,
`restart-reconstruction.ts`. **A plan is not a surface.**

The general rule this board keeps re-learning: judge a dependency by what is ON DISK, not
by its status column and not by a sibling's plan text. The governor's own standard for a
defensible pipelined promotion was "child 1's step-1 is COMPLETED and the kernel is on
disk" — apply that test, not the task board.

## Outcome

9 promoted to PLANNING on explicit human instruction after the objection was raised and
reaffirmed (2 clean, 7 pipelined against unbuilt deps; every `set_task_status` reason
names which). Architect brief: msg-d8b62bfd. Governance note: msg-58b865c5.
`report_blocked` was flagged to the incoming architects as the CORRECT outcome for a
genuinely unbuilt seam, not a failure.
