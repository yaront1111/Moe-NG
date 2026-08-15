# A second, weaker copy routine is where an authority boundary leaks

Two rejections on task-311adb23 came from the same shape: a module had ONE
correct deep-snapshot recursion (`detach`/`mirrorDeep`) and one sibling helper
(`mirrorList`) that re-implemented the copy more cheaply — dense-array checks
plus `types.isProxy` on each element, then `copy.push(descriptor.value)` BY
REFERENCE. Every section that went through `mirrorDeep` was safe; the one list
that went through the sibling handed caller-owned objects to the consumer, which
then read `claim["dimension"]` and ran the caller's getter inside the boundary.
`claimWork` returned `WORK_GRANTED`.

**Why it survives review twice:** each rejection names the depth that was
demonstrated, the worker closes exactly that depth, and the sibling routine
keeps its own weaker rules for every depth nobody demonstrated yet.

**How to apply (QA and workers):**
- When a module exports several copy/snapshot helpers, ask which ones share ONE
  recursion. A helper that hand-rolls its own element loop is the suspect —
  route it through the shared recursion instead of hardening it in place.
- Build the boundary-read audit table: every site where a caller-derived value
  has a property read (`x["k"]`, destructuring, spread, iteration, `.length`),
  and the snapshot that precedes it. The site with no deep snapshot in front of
  it is the defect, before any test is written.
- Test-side twin: a hand-written hostile-target list is the same bug. If the
  targets are depth 0-2 paths, no case ever reaches an array element. Replace
  with a mechanical walk pinned to a hand-written expected-path list, and assert
  the deep paths by name. See
  `mem:qa-generated-table-cannot-police-its-own-generator`.
- The assertion that would have caught all three rounds at once is a whole-graph
  zero-read counter: rebuild EVERY node with counting accessors and assert the
  counter is exactly 0. A fixture matrix only covers depths someone thought of.

Rejected alternative worth knowing: deep-detaching the whole payload at the
outer door is the tempting "one primitive everywhere" move, and it is wrong when
per-leg refusal attribution is part of the contract — every nested fault would
then refuse at the outer leg and lose its own code/leg/upstreamCode. The correct
formulation is "nothing reads a property of a caller value before that value's
own detach", not "detach everything at the door".

Related: `mem:array-isarray-throws-on-revoked-proxy` (ask `types.isProxy` first
in every one of those helpers), `mem:qa-mutation-drill-can-redden-for-wrong-reason`.
