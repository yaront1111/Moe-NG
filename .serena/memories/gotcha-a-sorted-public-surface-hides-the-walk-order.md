# A sorted public surface erases the order you are trying to pin

`reconcileImport` (packages/import/src/import-reconcile.ts) ends with
`found.sort(compareFindings)`, and `compareFindings` is a TOTAL order over
distinct findings (path, then class, then detail). So every assertion made
through the public function is blind to the order its internals emitted.

Rewriting `graphFindings` from recursion to an explicit stack is exactly the
change that perturbs emission order — and golden fixtures captured through
`reconcileImport` cannot see it. Proof: a `push` -> `unshift` mutant reddened
both direct-call tests; the sorted assertions on the SAME graphs could not
distinguish the two orders at all.

**Before rewriting a traversal, check whether the public entry point sorts.**
If it does, export the walk and assert its raw sequence directly, and give the
raw assertion teeth with `expect(publicOutput).not.toEqual(rawOutput)` — proving
the sort really does reorder that fixture, so the raw test is not a restatement
of the sorted one.

## Where order still leaks through a sort

Order can still be SET-affecting, and then the sorted surface does catch it.
Here the cycle dedupe key is `cycle:${ref}` — keyed on the TARGET alone — so
whichever node reaches the target first decides the emitted detail text and
provenance. Different walk order = a different finding, not the same finding in
a different slot.

Corollary for capturing goldens on a not-yet-exported private walk: capture the
public goldens first, do the extraction as a PURE MOVE, then capture the raw
sequence against the still-original algorithm in its new exported home. That
raw capture is a genuine pre-rewrite snapshot, not a post-hoc rationalisation.

Related: [[qa-prove-a-structural-view-is-bound-to-the-real-source]],
[[layered-validator-sweep-goes-vacuous]].
