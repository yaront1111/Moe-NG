# Handoff — task-f6cf8d16c2654641a92b0ee36924de0c — QA APPROVED (reopen #2 verified)

Reviewed by qa-50f0d628 at HEAD 55028d1. All five reopen #2 defects are closed, verified by an
INDEPENDENT probe I wrote and then deleted — not by reading the worker's tests.

## What actually fixed it
The root cause was one thing: the decoder checked shape + digest + byte spelling but never
re-derived what the builder enforced. A forgery re-digested through the production digest surface
is canonical AND correctly digested, so nothing refused it.

`recovery-inventory-invariants.ts` (new, 186 lines) is now the SINGLE home for the semantic rules;
builder emits with it, decoder re-derives against it. `recovery-inventory-reader.ts` (new, 266)
holds the strict reader split out of codec.ts (391 -> 146). Critically, codec.ts:135-138 runs the
reader BEFORE the digest comparison, so DIGEST_MISMATCH cannot shadow a semantic guard.

Two new closed-vocabulary codes: `RECOVERY_INVENTORY_PROOF_TRUTH_CONTRADICTS` (builder) and
`RECOVERY_INVENTORY_RECORD_INCOHERENT` (decoder), deliberately distinct from RECORD_NONCANONICAL so
a test can prove WHICH guard answered.

## The QA probe method that matters (reusable)
Build a legitimate record with the production builder -> deep-clone to a mutable body -> mutate ONE
semantic invariant -> recompute `recordDigest` with production `recoveryReconciliationDigest` ->
re-encode with production `encodeRecoveryReconciliationRecord` -> decode with production
`decodeRecoveryReconciliationRecord`. Assert the refusal code is INCOHERENT at RECOVERY_INVENTORY
and explicitly `not.toBe(DIGEST_MISMATCH)`. Two controls are mandatory: untouched sealed bytes still
decode (seal machine is real), and a semantically-valid change WITHOUT re-digesting still yields
DIGEST_MISMATCH (digest guard still reachable, not dead).

16/16 of my probes passed: proof UNKNOWN under record COMPLETE, sentinel slot claiming COMPLETE at
itemCount 0, ABSENT with no terminal proof, ADOPTED with ref-but-no-digest / no intent at all / two
provenance arms, reversed ordering, duplicated class-scoped identity with itemCount adjusted,
QUARANTINED carrying both ref AND upstream, item not carrying its class proof digest, inflated
itemCount, builder refusal on COMPLETE+upstream, and UNKNOWN provenance retention.

## Mutation drills — 5 run, sha256-checked before/after/restore
Commenting out each reader guard reddened exactly its own cases:
- `isCanonicalRecoveryItemShape` -> 5 red (F3, F4a/b/c, F7)
- `isCanonicalRecoveryItemSequence` -> 2 red (F5, F6)
- `isCanonicalRecoveryProofSlot` -> 1 red (F2)
- `derived.truth !== truth` -> 0 red from my first pass, see trap below

## TRAP worth remembering
`if (derived.truth !== truth)` looked like an EQUIVALENT MUTANT: my "proof UNKNOWN under record
COMPLETE" forgery was answered one line later by `sameRecoveryUpstream(derived.upstream, upstream)`,
not by the truth equality. It is NOT dead code. Isolating it needs a record that satisfies BOTH
co-presence rules: build a legitimately-UNKNOWN record, then set `truth="COMPLETE"` and
`coordinator=null` while KEEPING the derived `upstream` verbatim. Only then does the truth
comparison own the case. The worker's
`recovery-inventory-forgery.test.ts > refuses truth COMPLETE while the retained code already admits
an incomplete proof` does pin it — that test goes red under the drill. See
`mem:qa-equivalent-mutant-in-a-two-clause-guard`.

## Evidence
Gate re-run by me in the foreground: `pnpm --filter @moe/daemon typecheck && pnpm --filter
@moe/daemon test && pnpm --filter @moe/store test` => exit 0, daemon 69 files/1492 tests, store
41/469. (Worker reported 1490/468; the delta is peer commits landing between runs, not drift.)

NUL byte at record.ts:164 fixed properly — `String.fromCharCode(0)` in `invariants.ts`, NOT a source
escape. Verified 0 NUL in the worktree AND in `git show HEAD:...record.ts`, with a positive control
printing 1. See `mem:gotcha-nul-escape-collapses-through-every-write-path`.

Per-file lines (grep -c ''): codec 146, invariants 186, proofs 166, record 188, reader 266, contract
287, ledger 289, subject 300. All under the 400 cap. Task-level LOC is not a bar.

Diff scope: 12 files, all under `apps/daemon/src/recovery/`. Both new modules have their `.js`
bridges. Base-ref diff: `git diff 7dbf9ba..HEAD -- apps/daemon/src/recovery/recovery-inventory-*`.

## Foreign, NOT this task
`packages/runner/src/providers/claude/*` is modified and uncommitted by a peer. It reddens repo-wide
daemon typecheck via TS2339 but is outside owned paths and outside the owned-package gate, which is
exit 0. Disclosed, not attributed here.

Consumers unblocked: task-47eecd22b3b94a57a9632672c19ebd97, task-cf7fb147bd1c47698cbd65c9535370aa,
downstream task-6f786c58cabf4f85be8ed4135e68a752.
