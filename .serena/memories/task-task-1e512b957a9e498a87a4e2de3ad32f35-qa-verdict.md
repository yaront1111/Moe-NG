# QA verdict: Evidence receipt pipeline — APPROVED (2026-08-09)

`packages/runner/src/evidence/`, 11 files tracked, working tree clean at review time.
Worker handoff: `mem:task-task-1e512b957a9e498a87a4e2de3ad32f35-handoff`.

## Gate re-run by QA, not trusted from the summary

`pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` -> EXIT 0,
20 suites / 720 tests. (Ran twice, 717 then 720 — the delta is foreign, other agents
are adding runner tests concurrently in the shared worktree. Evidence subtree is a
stable 4 suites / 59 tests both runs.)

## Independent 6-mutation drill — ALL KILLED

QA re-ran its own drill rather than trusting step 9. Every mutation neutralised an
operand with a constant; no line was ever deleted. Files backed up to an out-of-tree
temp, restored by `cp`, restore verified with `git hash-object` against the HEAD blob.

| # | mutation | result |
|---|---|---|
| M1 | `observed[index] !== declared[index]` -> `false` | 1 suite / 1 test red |
| M2 | `truthClass === "PROVEN"` -> `true` | 1 suite / 1 test red |
| M3 | `support.kind === "AGENT_REPORT"` -> `false` | 1 suite / 2 tests red |
| M4 | `ref === undefined` -> `false` (foreign+undeclared) | 1 suite / 3 tests red |
| M5 | `!refMatches(read.value, ref)` -> `false` | 1 suite / 1 test red |
| M6 | receipt binds `[...execution.argv]` again | red on the named smuggling test |

M6 is the regression for `mem:gotcha-index-vs-iterator-smuggling-between-check-and-bind`
and it is genuinely load-bearing: reverting the bind reddens exactly
"cannot be made to bind argv a second read smuggled past the divergence check".

**Drill hazard hit:** the `mut` helper's restore for `candidate-rematerialization.ts`
failed (never backed up), and `set -e` did NOT abort the loop — so M6 ran with M5 still
live and its counts were inflated. Re-ran M6 alone from a clean baseline. Back up EVERY
file the drill will touch, and re-run any mutation whose restore step errored.

## DoD, item by item

1. **Agent text cannot discharge** — enforced by SHAPE: `BuildEvidenceReceiptInput` has
   no prose-carrying parameter; `AGENT_REPORT` carries `reportedBy` + `reportSha256` only.
   Backstop at ONE source (`checkSupport`, receipt-obligations.ts:49) firing before any
   field inspection. Tests assert the code AND `layer === "OBLIGATION"`, so a nearer shape
   gate cannot silently take the rule's place.
2. **Binding list** — `receiptDigestInput` covers all 10 DoD fields; the test asserts SET
   EQUALITY against a hand-written `DOD_BOUND_FIELDS`, `.length === 10`, and drives the
   per-field digest-change sweep off that same list with `covered.length` asserted equal
   to the list length and `> 0`. Rail 6's "a sweep that generates zero cases passes" is
   closed.
3. **Rematerialization** — FOREIGN and UNDECLARED are separate codes with separate
   fixtures; `refMatches` is the production surface (M5 red proves the assertion is not
   masked by the later reconcile raising the same code); manifest tamper, recipe-digest
   mismatch, input-tree divergence and `CANDIDATE_NOT_EMPTY` clean-start all covered.
   Refusal path removes every byte it wrote.
4. **Gate** — EXIT 0, verified above.

32 of the 33 codes in `RUNNER_EVIDENCE_ERROR_CODES` are asserted by name in tests; only
the generic `RUNNER_EVIDENCE_EXECUTION_INVALID` is not pinned directly. Not a gap.

## Rails

Per-FILE cap fine: production 141/149/220/228/235/240/248 lines, all under the 250 target
(largest test file is 545 — the cap is per production source, not a rejection reason, and
task-level LOC is never one). Fence swept clean: zero `child_process` / `spawn` / `kill` /
`Date.now` / `Math.random` / `node:fs` / `require(`; the only node import is `node:path`.
No `.js` bridges. No debug/scratch/generated files.

## Commit history is split, and that is NOT the worker's defect

The worker's own commit `1be8e2c` is 9 files, all `evidence/`, explicit per-file pathspec —
compliant. But 8 of those files were first swept into `42f1c21`, task-4a3b5ec0's commit, by
a foreign harness whole-tree auto-commit; and `c42b578` carries THIS task's commit message
while containing only `supervisor/` + `coordination/` foreign files. Both are
`mem:gotcha-completion-hook-commits-whole-tree`, not a rail-3 violation by this worker.
Do not reject a task for a commit it did not author. Attribute by *content*, not by the
task id in the subject line.

## One seam noted, deliberately not a rejection

`disposition` / `exitCode` are validated but NOT bound into the receipt digest, by design —
disposition is an admissibility gate (`UNKNOWN` yields no receipt, `FAILED` still earns
one). Consequence a downstream consumer must know: **a receipt for a FAILED verifier run
and one for a COMPLETED run with the same outputs have the same digest.** DoD 2's field
list does not include it and the set-equality test pins that list, so binding it now would
redden the suite. If a later task needs "did the verifier pass" to be evidence, it must
bump `EVIDENCE_RECEIPT_VERSION` and extend the list at both `receiptDigestInput` and
`DOD_BOUND_FIELDS`.
