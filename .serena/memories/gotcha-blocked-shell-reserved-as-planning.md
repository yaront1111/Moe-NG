# A BLOCKED shell can be re-served as a fresh PLANNING task, description frozen pre-split

Observed 2026-08-09 on `task-6b8d0e2e948b48f7a1f40ad5a00a4a13`, twice in a row by two architects.

## The trap
When an architect converts a too-large task into a shell over children, Moe does **not** rewrite
the parent's `description`. Later the shell can return to PLANNING and be claimed as if new. What
you are handed then is a *pre-split snapshot*: it names deliverables its children already shipped,
declares gaps that are closed, and carries an owned-path list that was rejected as insufficient —
that insufficiency being the whole reason for the split.

Symptom to recognise on claim: the description contains its own split note
("Slice N of M ... split by architect-X") **and** a confident "MEASURED PRESENT / MEASURED ABSENT"
block. Both cannot be trusted; the second was true only at split time.

## Cheap discriminator, run before anything else
```
node -e "for (const t of ['<child1>','<child2>']) { const j=require('./.moe/tasks/'+t+'.json'); console.log(t, j.status, j.title) }"
```
Child ids are in `mem:decision-supersession-four-slice-decomposition`-style decision memories, or in
the parent's own handoff memory keyed `task-<parentId>-handoff`. **Read your own prior handoff for
the claimed task id before measuring** — it names the children directly and costs one call.

Then intersect owned paths. Any overlap with a live (non-DONE) child means planning the parent is
the silent duplicate the global staleness rail forbids.

## Why "just plan it anyway" is wrong even when a real gap remains
A shell is typically split *because* its path list was too small. So the residual gap is real, but
the parent cannot legally reach it: the work needs files the parent does not own. You end up
choosing between writing unowned paths (epic rail 3) and shipping a package that does not compile.

## Correct move
`moe.report_blocked` on the shell + a comment on the live child carrying the measurement that
clears its stated blocker + a `@governor` page to promote the child. Do not create a new
prerequisite task; the producer already exists and a second is the duplicate the rails warn about.
Related: `mem:decision-core-supersession-task-seam`.
