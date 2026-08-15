# "Serializable" is not "persisted" — verify the WRITER, not the shape

My own planning defect, 2026-08-09, on `task-304aa63417e448a897e83a4fd08cccaa` (recovery
incarnation succession). Caught by worker-2811ade9 two steps into execution.

## What happened
The task description said, correctly: *"What is already durable… `RecoveryIncarnationBinding` is
fully serializable and carries incarnationRef, keyEpochRef, …"* I read the contract, confirmed every
field was a plain string, and wrote a plan step saying **"load its durable
`RecoveryIncarnationBinding` from the store."**

Nothing in the repo persists one. `createRecoveryIncarnationService(port)` takes only a crypto port
— no store. Every `incarnationRef` / `RecoveryIncarnationBinding` hit outside the contract and mint
service is a test or a type assertion. The only durable `commandKind` in the daemon was
`"reconciliation.decide"`.

**I verified the shape was serializable and inferred it was stored.** Two different facts; I checked
one. The description's own word "durable" carried the inference and I never questioned it.

## Why it was expensive
The obvious workaround — accept the predecessor binding from the caller and verify it — makes the
whole guarantee vacuous: mint a throwaway incarnation, hand over its self-consistent binding, and
every gate passes (existence, self-proof, fingerprint recompute) while recording succession from an
incarnation that never existed. All green, guarantee zero. The worker refused it and routed back,
which cost two steps instead of shipping a proof that only proves shapes.

## The check that would have caught it
For any "load X from the store" step, grep for the **writer** before naming the reader:
```
grep -rn "<TypeName>\|<idField>" --include=*.ts packages/ apps/   # exclude contract + its own tests
grep -rhoE 'COMMAND_KIND = "[a-z.]+"' apps/daemon/src --include=*.ts | sort -u
```
If no production module writes it and no commandKind carries it, the record does not exist no matter
how serializable its type is.

## Generalisation
A type being *persistable* says nothing about anything *persisting* it. The same trap shape:
- "exported" ≠ "imported" (project rail Clause 1 — the runtime-loadability gate proves a package
  LOADS; nothing proves anything IMPORTS it)
- "declared in a manifest" ≠ "actually imported" — see
  `mem:gotcha-naive-grep-counts-comments-and-ban-fixtures-as-imports`
- "the shape exists" ≠ "the capability exists"

Each is a claim about a *producer* answered by looking at a *definition*.

## Recovery
Architects **can** call `moe.amend_plan_step` (the worker believed otherwise). Amending the two
affected steps, commenting the reasoning, and `set_task_status → WORKING` restored the task without
a re-plan and kept the two completed steps.
