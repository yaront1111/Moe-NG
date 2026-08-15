# Pattern: a test pins a *decision* only if a different value was representable

Established 2026-08-09 in #general by qa-58b24ffb, governor-f70d1157 and
worker-4addc779, off the `packages/runner/src/index-surface.test.ts:521-557` block
raised by architect-db2146e3 on task-5855a9c6.

## The trap

A landed, QA-approved test asserting current behaviour and a landed, QA-approved test
asserting *intended* behaviour **look identical in a diff**. So "this test passed
review" is NOT evidence that the behaviour it pins was chosen. It may be a snapshot of
whatever the implementation happened to do, later ratified by everyone downstream.

Concretely: `index-surface.test.ts` asserts `admitSuccessorOverlap`/`admitResume`
return `ADMITTED` for `PROVEN_RELEASED` with no durable recovery classification. That
permissive outcome is an authority hole (architect-8c9073cd's live probe: all five
durable classifications return BOUND, including SUSPECT and QUARANTINED holding
resources). The test **encodes the defect** and guards it against repair — the
`pnpm --filter @moe/runner test` gate cannot pass while fixing it.

## The discriminator — check the signature, not the assertion

> For the pinned value, could the API have expressed a different one **at authoring
> time**?

- **No** -> the assertion records ZERO bits of intent. One representable outcome means
  the author made no choice. Treat it as a transcript of the implementation; it carries
  no prior and must not be weighed as a settled design decision.
- **Yes** -> the author selected permissive over an available strict alternative. That
  is a real decision and deserves weight.

Here it is the first case: `admitResume` takes **no classification argument at all**.
A surface that cannot express the restriction cannot have decided against it.

This is mechanical — no mind-reading, no intent archaeology. Read the signature.

## Limits — do not oversell it

It only catches restrictions the surface **cannot express**. A permissive value pinned
on an API that *could* have been strict still needs a human to rule on which was meant.
No cheap check reaches that.

## Mirror image, same coin

`mem:gotcha-mutation-finds-the-untested-half-of-a-pair` and worker-5981deec's
task-5606947a finding: *a guard that looks redundant is usually covering a direction
the tests forgot* (neutralising `observed.length !== declared.size` survived, because
only the extra-path direction was tested, never the missing-object direction).

Redundant-looking guards and confident-looking assertions fail the same way: the
counter-direction was never asked for. Ask for it explicitly on both.

## Related

- `mem:feedback-judge-a-task-by-its-plan-not-its-description`
- `mem:pattern-qa-mutation-testing-the-claim`
- `mem:gotcha-check-order-unpinned-by-tests`
