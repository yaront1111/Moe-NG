# Handoff: Evidence receipt pipeline (`packages/runner/src/evidence/`)

Committed `1be8e2c` (9 files, explicit per-file pathspec). NOTE: 8 of the same files were
swept into `42f1c21` (task-4a3b5ec0's commit) by the harness auto-commit before I could
commit them, so evidence/ history is split across two commits and the earlier half carries
another task's message. Reported in chat; not worker-fixable.

## What exists

7 production modules, all under the 250 target (132-242 lines), 4 test suites / 59 tests.
Deliberately NOT exported from `index.ts` — same precedent as `supervisor/`.

- **evidence-contract.ts** — pinned `VERIFICATION_RECIPE_VERSION` / `EVIDENCE_RECEIPT_VERSION`,
  `EVIDENCE_REFUSAL_LAYERS` (7), `RUNNER_EVIDENCE_ERROR_CODES` (33), `EVIDENCE_OBLIGATION_KINDS`,
  `ObligationSupport`, `evidenceFailure(code, layer, message, path)`.
- **verification-recipe.ts** — `buildVerificationRecipe`, `recipeSealMatches`. argv is never
  sorted (order IS the command); the declared closure and output paths ARE sorted.
- **candidate-rematerialization.ts** + **candidate-reconciliation.ts** — `rematerializeCandidate`.
- **evidence-receipt.ts** + **receipt-obligations.ts** + **verifier-execution.ts** —
  `buildEvidenceReceipt`, `receiptDigestInput`, `ObservedVerifierExecution`.

## Design decisions a reviewer will ask about

**Not blocked on the External effect supervisor.** It appears only as DoD 2's "effect
identities" — an opaque caller-supplied string validated for SHAPE only. Nothing here
imports, launches, or reasons about an effect. Same for graph and lease identity.

**Verifier execution is an OBSERVATION PORT, never a spawn.** The caller supplies what it
observed; the module decides what it proves, exactly like `providers/claude`. Fence swept:
zero `child_process` / `spawn` / `kill` / `Date.now` / `Math.random` / `node:fs` in the
subtree. The only node import is `node:path`, to join `<artifactRoot>/objects/<sha256>` —
`ArtifactStore` has NO read method, so bytes must come through `ArtifactFsPort.readAll`.
That layout coupling is the one real wart; a `readArtifact(ref)` port would remove it.

**DoD 1 is enforced by SHAPE, not by a check.** `BuildEvidenceReceiptInput` has no parameter
prose can arrive through. `AGENT_REPORT` exists in `ObligationSupport` only so the nearest
legal attempt has a representable shape and a coded refusal; it carries `reportedBy` +
`reportSha256`, never text. Backstop lives at ONE source (`checkSupport`) and fires before
any field is inspected, so no shape gate can answer first.

**FOREIGN vs UNDECLARED are two distinct facts.** FOREIGN = a path the recipe mentions
nowhere. UNDECLARED = a declared OUTPUT slot holding content no ref declares (rematerialization
runs before the verifier produced anything). Separate codes, separate fixtures.

**Disposition is an admissibility gate, not a bound field.** `UNKNOWN` yields no receipt;
`FAILED` still earns one, because a failure is a proven fact and absence of a fact is not.
That contrast pair is tested — without it the rule degenerates into "only success counts".

## Two defects the drill/review caught (both fixed, both mutation-proven)

1. **Masked mutation.** Neutralising `refMatches` in `materializeOne` left the test green,
   because the later tree reconciliation raised the SAME `REF_MISMATCH` code at the same path.
   Fixed by asserting `candidate.writes` is empty — a ref mismatch must be caught BEFORE the
   bytes touch the tree.
2. **Index-vs-iterator smuggling between check and bind** — see
   `mem:gotcha-index-vs-iterator-smuggling-between-check-and-bind`. Real exploit against the
   argv divergence property. Every structural read in the subtree now reads by index and binds
   the array built during that same pass.

## Verification

`pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` -> EXIT 0,
18 suites / 663 tests (2026-08-09 00:00).

**`packages/runner/src/supervisor/` churns constantly and broke the SHARED typecheck twice
during this task** (`race-scenarios.ts` TS2322, then `race-harness.test.ts` TS2339, then
`race-world.ts` / `race-steps.ts`). Both times: foreign untracked files, tests fully green,
error confined to `supervisor/`. Do not fix them; post the diagnosis to chat and poll — their
owner cleared both within minutes. `pnpm --filter @moe/runner test` alone is a useful signal
when typecheck is red for foreign reasons.

Related: `mem:convention-hostile-shape-reads-in-pure-kernels`,
`mem:gotcha-digest-mutation-that-proves-nothing`.
