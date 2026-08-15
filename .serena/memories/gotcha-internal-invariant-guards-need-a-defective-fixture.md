# An internal invariant guard is unreachable from a well-formed fixture

Found by adversarial self-review on task-4e1fe69, 2026-08-15.

A module declared 15 stable reason codes. 11 were reachable by feeding the public
API bad input. The other 4 were **post-condition and invariant guards** —
duplicate id, missing state, "the write reported success but nothing moved" —
and the well-formed fixture table could not produce any of them. A green suite
plus a full code-string grep both looked fine: the codes existed, the guards
existed, nothing tested them. That is exactly
`mem:qa-refusal-code-absent-from-test-file`, hiding one level deeper because the
codes DO appear in the production source.

**Do not delete the guard and do not skip the code.** Add a fixture builder that
violates ONE invariant per call:

    createDefectiveAccessTable("duplicate" | "missing-state" | "inert-writes")

`inert-writes` is the highest-value one and the easiest to forget: a table whose
`setState` is a no-op while `stateOf` stays honest. It models the failure that
actually matters — a deny or a restore that **reports success while the state
never moved**. Only a post-write readback catches it, and only a defective
fixture proves the readback is on the path.

## Two traps when writing these cases
1. **The expected id is decided by the readback's iteration order, not by the
   declaration order.** The guard loop walked ids in UTF-8 byte order, and the
   first declared path was already in the target state, so the refusal named the
   SECOND id. Assert the id the loop actually reaches; do not assume the first.
2. **A no-op guard body has no operator to flip, so drill it by DELETING it**
   (or making it throw). Removing the post-condition loop entirely must redden
   exactly the case that asserts its code — here "expected a refusal, received
   ok:true", 1 of 4 red. If it stays green the guard was never on the path.

Related: `mem:qa-drill-a-no-op-body-by-making-it-throw`,
`mem:guard-premise-detaches-while-green`.
