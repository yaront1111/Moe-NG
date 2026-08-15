# Windows Job / Claude-launch dependency chain — measured map

Measured 2026-08-10 by architect-5aba94da by scanning every task JSON. Recorded
because the chain is five levels deep, dependencies are prose rather than
fields, and two people have already re-derived parts of it.

## The chain, leaf to root (acyclic)

```
task-05bf0e0f (3a)  package + workspace + CRT descriptors     WORKING
task-14ab762d (3b)  frozen protocol + bounded framing         BLOCKED
task-55e2c4c8 (3c)  session + core delegation                 BLOCKED
task-e18b1284 (3d)  hardening + detached-grandchild proof     BLOCKED
        |
        v
task-af3d7bc8       Windows Job broker protocol               SHELL, BLOCKED
        |
        v
task-4d1f8ba5       Windows Job Object provider boundary      BLOCKED
        |
        v
task-acf73253       Windows Claude launch wrapper             BLOCKED
        |
        v
task-97554aa4       Foundation self-host canary               BLOCKED
```

Already satisfied and no longer a gate:
- `task-ea76e0cf` Win32 Job lifecycle core — **DONE** (delivered
  `moe-windows-job-core`; 7+28+2 tests, 0 ignored, release exit 0).
- `task-078af6f1` Claude runtime closure pin — **DONE**. It is
  `acf73253`'s *other* prerequisite, so acf73253 is gated solely on 4d1f8ba5.

## THERE IS NO CYCLE — I nearly reported one

A regex scan of blocked reasons + descriptions for `task-[0-9a-f]{32}` appeared
to show `4d1f8ba5` depending on its own parent `acf73253`. **False.** That id
appears in the DESCRIPTION because acf73253 is the parent; it is not a
dependency claim. `4d1f8ba5`'s real prerequisites, named in its blockedReason,
are `ea76e0cf` (DONE) and `af3d7bc8`.

**Lesson: an id appearing in a task's text is not a dependency edge.** Read the
blockedReason prose and distinguish "depends on" from "parent is" / "consumer
is" / "see also" before claiming a graph property. See
`mem:moe-hard-dependencies-are-prose-not-fields`.

## Stale rationale to not act on

`acf73253`'s block says *"Node core has no per-run Job Object API, and taskkill
cannot prove descendants dead after the root exits."* The first clause is still
true of Node core, but the repo now HAS that capability natively and proven on a
real kernel. Nobody should plan a taskkill fallback or rebuild Job control in
TypeScript — the path is the broker chain. Recorded as
`comment-f6c7e177` on 4d1f8ba5.

## Prerequisites named only as "two bounded production prerequisites"

`acf73253`'s block promises "two bounded production prerequisites were created
and linked" without naming ids. They are its two CHILDREN: `task-078af6f1`
(DONE) and `task-4d1f8ba5` (BLOCKED). Found by scanning `parentTaskId`, which is
the only way — there is no children query.

Related: `mem:task-task-05bf0e0fe7e84afb8584588ecf96db14-handoff`,
`mem:decision-spidr-shell-closure-transit-path`.
