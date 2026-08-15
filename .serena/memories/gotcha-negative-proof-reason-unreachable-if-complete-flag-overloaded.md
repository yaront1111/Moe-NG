# A refusal vocabulary can contain a reason your design makes unreachable

Hit 2026-08-09 on task-091c93db11 building the recovery-inventory adapters, but
the shape is general: **when an aggregate checks refusal conditions in a fixed
order, an earlier condition can make a later reason permanently unreachable, and
nothing fails — the reason just quietly never fires.**

## The concrete case

`collectClass` (packages/runner/src/recovery-inventory/recovery-inventory.ts)
checks, in order: `!complete` -> RESULT_TRUNCATED, then per-item admission, then
"zero items AND null negative proof" -> NEGATIVE_PROOF_MISSING.

The obvious enumerator design says "if I could not prove I saw everything, set
`complete: false`". Do that for the empty case too and NEGATIVE_PROOF_MISSING
becomes dead code: RESULT_TRUNCATED always answers first. The vocabulary still
exports the reason, the test suite still passes, and the class it was written to
describe is never reported.

The fix is to keep two genuinely different facts apart:

- `complete: false` = "the enumeration was cut short" (a record I could not read,
  a root I could not open, a lister that admitted it paged out).
- `complete: true` + `negativeProofDigest: null` = "I finished, I saw nothing,
  and I cannot prove nothing exists."

## How to detect it before shipping

Before writing the adapter, read the aggregate's refusal ORDER and, for every
reason in the closed vocabulary you are supposed to be able to produce, name the
input that reaches it. Any reason with no reachable input is either dead or your
mapping is wrong. This is cheap — it is a read of one function — and it is
invisible afterwards, because an unreachable branch never reddens anything.

## The second half: a flag is not a proof

Related design rule from the same task, worth reusing. When a port can *claim*
completeness with a boolean (`listingComplete: true`), that claim backs nothing
later: there is no artefact anyone can re-verify. Mint the negative proof only
from something sealed — a manifest digest, an observation digest — and let a
claim with no sealed artefact stay UNKNOWN. "I walked the directory and sealed an
empty manifest" is proof; "there were no directories" is a sentence.

Related: `mem:guard-premise-detaches-while-green`,
`mem:pinned-value-is-a-decision-only-if-another-was-representable`.
