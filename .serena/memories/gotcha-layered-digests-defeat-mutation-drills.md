# Gotcha: a field bound by TWO digests cannot be mutation-tested

Found 2026-08-09 while building `packages/runner/src/materialization/input-manifest-digest.ts`
(`task-e17da1c9`). Applies to every content-addressed record in this repo, and there are many.

## The trap

Records here are layered: an inner digest is embedded in an outer one
(`inputTreeDigest` -> `manifestSha256` -> `inputBindingHash`; `workspace-contract.ts` does the same
with `inputManifestSha256` inside `resultManifestDigestInput`).

The natural instinct is to list every field in every digest-input builder, "so nothing is missed".
Do NOT. If field `X` appears in both the inner and the outer builder, then **deleting `X` from
either one leaves the suite green**, because the other still covers it. The digest is still
correct — but the assertion protecting it has silently detached, and epic rail 6's mutation drill
cannot tell you.

That is the exact failure mode rail 6 exists to catch, hiding inside a construct that looks like
defence in depth.

## The rule

**Bind each field in exactly ONE digest-input record.** Let it reach the others through the digest
that already covers it. Then deleting any field from any builder reddens.

Document the chain where a reviewer will look, mapping the spec's required list item by item to
where each is bound and whether it is direct or transitive — otherwise a QA reader checks the
outer builder against the spec, does not see half the items, and flags a false positive. See the
doc comment at the top of `input-manifest-digest.ts` for the shape.

## The hole this opens, and how to close it

Single coverage means the outer record no longer *textually* contains the inner fields, so a
post-seal mutation of an inner field would not be caught by recomputing only the outer digest.

**Close it by recomputing ALL digests in the tamper check**, not just the outermost. In
`manifest-staleness.ts` `revalidateSealedManifest` recomputes all three and compares each. Without
that, single coverage trades a testability win for a real tamper hole.

## Choosing a mutation operand that proves coupling

A mutation that makes the code CRASH reddens the suite but proves nothing about whether the
assertion is attached — a `TypeError` would redden any test that touches the line.

Prefer an operand that leaves the code running and returns the WRONG answer. Example from this
task: to kill the `MONOTONIC`-without-proof downgrade, the obvious guard edits make `proof`
undefined and throw. Replacing the returned literal `"REVOCABLE"` with `contract.stability`
instead leaves every genuinely-revocable path unchanged and flips only the downgrade — red by
assertion, not by crash.

Related: `mem:gotcha-guard-order-mutant-survives-when-only-one-guard-can-refuse`.
