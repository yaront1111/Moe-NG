# Gotcha: invariant enforced only in a helper, entry point fails open

Found during QA of task-84e875f9 "Anti-blocking admission" (packages/scheduler/src/admission, commit f221eb1). Rejected despite a fully green gate (typecheck 0; `pnpm --filter @moe/scheduler test` 0, 26 files / 357 tests, deterministic across runs).

## The defect

`admitGraph` (admission-pass.ts) admitted a graph whose every HARD edge carried
`necessity.truthClass: "AGENT_REPORTED"` — and also `"UNKNOWN"` — with **zero** issues:

```
AGENT_REPORTED necessity     -> {"ok":true,"codes":[]}
UNKNOWN necessity+contract   -> {"ok":true,"codes":[]}
```

Two independent causes:

1. **Absent evidence defaulted to the value that grants authority.**
   `collectContracts` (admission-pass.ts:108-110): a contract entry with no
   `necessityWitness` was given `{ kind: PROVING_WITNESS_KIND }` i.e.
   `"TYPED_CONTRACT"` — the *only* class `checkContract` (:172-175) accepts.
   Omitting the witness was strictly more permissive than supplying an honest one.
2. **The truth-class gate did not exist on the pass.** `checkContract` (:165-188)
   checked witness class, fact staleness and milestone, never
   `contract.necessity.truthClass`. The kernel does not gate it either —
   `dependency-contract.ts:210` only validates union membership.

The correct rule *was* implemented, in `evaluateNecessityClaim`
(admission-necessity.ts:123), with an accurate docstring at :4 ("An AGENT_REPORTED
... NEVER admits a hard edge") and a seeded property test. But `admitGraph` never
called it, and `packages/scheduler/src/index.ts` never exported it, so no caller
was structurally forced through it.

## Why the suite could not catch it

- The property was asserted against the **helper** (`admission-invariants.test.ts:266`),
  never against `admitGraph`.
- Every happy path in `admission-pass.test.ts` used `entryFor()`, which **omits**
  `necessityWitness` — so the fail-open default was load-bearing in the tests.
  Fixing the default would have turned the suite red, which is exactly the signal
  that was missing.

## Rules to carry forward

- An invariant tested only on a helper is **not enforced**. Assert it at the entry
  point a real caller reaches. Unreachable-from-the-entry-point + not-exported =
  documentation, not a guarantee.
- **Never default absent evidence to the value that grants authority.** Missing
  witness/attestation must map to the refusal code (here
  `ADMISSION_HARD_DEPENDENCY_UNPROVEN`), per the epic rail "missing or
  unverifiable evidence stays UNKNOWN and never gains authority".
- Watch for fixtures that omit an optional field which then defaults permissively —
  the whole happy-path suite silently rides the weak path.
- QA technique that found it: write a throwaway probe test against the **public
  entry point** using the task's own fixtures, run it, read the output, delete it.
  Reading the diff alone would have missed this; both modules read as correct in
  isolation.

## Resolution (2026-08-08)

The reopen fix removed the synthesized TYPED_CONTRACT witness, made test fixtures carry an explicit edge-bound necessity claim, and composes every validated HARD edge through `evaluateNecessityClaim` using the landed counterfactual for that edge. Only matching DAEMON_VERIFIED claim/contract necessity admits. The seeded invariant now calls `admitGraph` across truth permutations. Missing and every non-admissible outcome yields one edge-scoped `ADMISSION_HARD_DEPENDENCY_UNPROVEN`; HELD remains a pure helper record and the binary graph pass conservatively refuses it.

## Size finding (separate)

f221eb1 was +1757/-0 net across 14 files, 4.4x the 400-net-LOC review bar, with no
covering exception. Per-file discipline was fine (max production module 237 lines).
Approved size exceptions live in `.moe/proposals/*.json` — read the JSON and check
`status`/`resolvedBy`/scope directly. `prop-2eaa632d` is scoped to commit `bcdc2f6`
only. Precedents an agent cites in a completion note ("+1412 approved",
"+1621 accepted") are agent-asserted and are not approvals.
