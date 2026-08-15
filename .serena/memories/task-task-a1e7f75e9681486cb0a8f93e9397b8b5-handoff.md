# task-a1e7f75e (Expansion protocol public hardening) — DELIVERED, in REVIEW

worker-131786b8, 2026-08-11. Commit **a069364**, 8 files, exactly the staged set.
Gate exit 0: `pnpm --filter @moe/core typecheck && test && pnpm --filter @moe/scheduler
typecheck && test && pnpm exec vitest run tests/integration/expansion-protocol.test.ts`
-> core 27 files/549 tests, scheduler 42/1137, integration 1/113.
Repo-wide at HEAD: `pnpm -r typecheck` exit 0; `pnpm test` 239 files / 4979 passed,
1 skipped, exit 0. **No foreign red** — the two `tests/fault/foundation` failures
task-b863bae8's handoff disclosed were fixed by task-40983c7c in the meantime.

## What landed

Core root +8 values/+25 types (expansion preparation + approval); scheduler root
+7 values/+23 types (expansion admission + evidence). New
`packages/core/src/index-surface.test.ts` (385) and
`tests/integration/expansion-protocol.test.ts` (1391).

## Three things a successor will otherwise re-derive the hard way

**1. THREE namespace pins guard the core root, not one.** The plan named the
scheduler's `toBe(65)` at index-surface.test.ts:99. There is a SECOND one in a
file no publication task owns: `packages/core/src/supersession/supersession-engine.test.ts:83`
asserts `Object.keys(core).filter(k => k !== "default").length`. Publishing 8
values turned it red with "expected 69 to be 61". Update the literal; do not
delete it and do not relax it. It is now 69, and the third pin (the new core
surface test's hand-transcribed 69-name list) is the one that makes the count
reviewable. See `mem:gotcha-closed-enum-ALL-array-breaks-sibling-sweep`.

**2. Publishing the two core expansion modules FORCES exactly two `.js` bridges.**
`expansion-approval.js` and `expansion-preparation.js`, byte-exactly
`export * from "./<name>.ts";` + LF. Not optional and not scope creep — see
`mem:gotcha-js-bridge-is-illegal-for-an-unpublished-core-module`, which is the
same rule read from the other side. I replicated runtime-entrypoint.test.ts's
closure walk with a script before editing: publishing those two newly reaches
exactly those two modules and nothing else. Scheduler needs none; its
`scheduler-runtime-entrypoint.test.ts` is a strip-types smoke load with no
bridge-set audit, and its four expansion bridges already exist.

**3. `EXPANSION_LIMITS` is NOT exported.** `admission-records.ts:22` is a bare
`const`, and its only escape (line 189) is an AdmissionExpansionRecord that
`checkExpansionLineage` — the accessor `expansion-admission.ts:201` actually
calls — discards. Any plan saying "compose EXPANSION_LIMITS rather than writing
the literals" is unsatisfiable without adding an `export` to a file you probably
do not own. What works instead, and is stronger: DISCOVER the boundary by
walking the dimension upward through `admitExpansion` until the named
`ADMISSION_EXPANSION_*_EXCEEDED` code appears, then pin `{lastAdmitted,
firstRefused}` to `{3,4}` / `{6,7}` / `{9,10}`. Throw on any OTHER refusal, or an
unrelated failure reads as a plausible wrong limit.

## tests/ cannot use bare `@moe/*` specifiers

`import "@moe/core"` from `tests/integration/**` dies with ERR_MODULE_NOT_FOUND —
`mem:gotcha-bare-moe-specifier-unresolvable-from-repo-root`. Every existing suite
there uses relative paths; this one imports `../../packages/{core,scheduler}/src/index.js`
and NOTHING else, enforced by two guard tests that read the file's own source.
Anchor such a guard on the import STATEMENT: my first version scanned for any
quoted `@moe/...` and went red on this file's own header comment explaining the
problem. Bare-specifier resolution is proven separately in the package surface
tests, which is where it belongs anyway.

## Type proofs must live in the PACKAGE suites

`tests/` is collected by vitest and typechecked by no gate, so a type annotation
there is transpiled away. All 48 published expansion types are annotated in
`packages/{core,scheduler}/src/index-surface.test.ts`, where `pnpm --filter …
typecheck` sees them. That is also why the scheduler surface test now drives a
full happy-path admission: the success-side types have no real value to annotate
otherwise. See `mem:gotcha-type-only-root-export-invisible-to-count-test`.

## DoD 4 findings, for QA and for the expansion shell

15 mutations, all restored byte-exact and verified against `git rev-parse HEAD:<path>`.
10 of the 11 named guards went red. The survivor was `fairness capacity`, and it
resolved into three different things — see
`mem:gotcha-capacity-snapshot-order-and-inflight-were-unasserted`.

## DoD 5's durable consumer is ARCHIVED

`task-9634ed3b72014fe781591c7df9674da2` (Multi-node daemon composition) is
ARCHIVED, so it can compose nothing. Recorded as written and disclosed rather
than silently substituted; worker-767ae903 raised the same thing for
task-b863bae8 in `msg-adbdb389c39e43a9bd98d2fd2b9e6e0d`. The live consumer edge
this task actually landed is the cross-package `admittedFrom` mapping in the
integration suite. Durable atomic child activation is still uncertified and
taskRail 1 explicitly defers it to daemon composition — which now has no live
owner. `mem:gotcha-consumer-edge-named-against-an-archived-task`.
