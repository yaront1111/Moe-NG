# A landed family can be complete, correct, well-tested — and consumed by nothing

Clause 1 of the consumer-edge rail says "exports the symbols" is not composition. This is what that
actually looks like in a mature tree, and why it survives review.

## The shape (found on task-1eeb2dcc, architect)

Child task-bcae0b7e landed four modules: `effort-records.ts` (frozen vocabularies),
`effort-admission.ts` (shaping + refusals), `effort-collector.ts`, `effort-intervals.ts`. Each had
real unit tests. Each was green. The task was QA-approved and marked DONE.

`grep -rn 'effort-admission|effort-records' --include=*.ts apps/ packages/ | grep -v '\.test\.'`
returned ONLY the four modules importing **each other**.
`grep -rln 'effort|Effort' apps/control-room/src/live/` returned **nothing at all**.

The family was complete and had zero consumers. Nothing was broken, no test was red, and no gate
could have caught it — because a module that nobody imports is exactly as green as one everybody
imports.

## Why it survives review

A reviewer reads the module and its tests, both good, and stops. The question "who calls this?" is
not asked, because nothing in the diff prompts it — the diff is self-consistent. The unit spec is
the trap: it passes identically whether production has one caller or none, so it reads as coverage
while proving only that the module works in isolation.

The sibling case makes it worse: an adjacent capability from a SIBLING task (timing) *did* get its
live edge, so the area looks wired. Partial integration reads as integration.

## The tell — check the asymmetry, not the module

When one epic lands several capabilities that should be peers, grep each peer for live consumers
and COMPARE. Timing: `main.tsx` → `live-app.tsx` → `live-event-feed.ts` → `wire-timing.ts`, plus a
`live-*-path.test.tsx` guarding the rendered output. Effort: nothing. One peer having a full chain
and another having none is the signal; neither module inspected alone would show it.

## Rule

- An architect planning an integration/hardening slice must run the reachability grep from the LIVE
  entry path (not from the module) for every capability the slice claims to certify, BEFORE writing
  steps. The empty grep IS the deliverable.
- A mutation drill is the acceptance test for the integration test. If weakening the module's guard
  reddens only its own unit spec and no live test, there is no live edge — treat a green live drill
  as a defect in the test, never as a pass.
- The fix is to land the edge, not to point the drill at the unit test. Reddening the unit spec
  "satisfies" the DoD wording while leaving the exact gap the DoD exists to close.

Related: `mem:gotcha-a-production-component-can-be-fixture-only-reachable`,
`mem:qa-drill-the-consumer-to-prove-composition`, `mem:deps-done-is-not-deps-reachable`,
`mem:type-only-export-invisible-to-count-test`.
