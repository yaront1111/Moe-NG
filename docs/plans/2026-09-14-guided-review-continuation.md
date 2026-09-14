# Guided review continuation implementation plan

**Goal:** Deliver a human's implementation answers to the next coding attempt through the same explicit approval that permits that attempt.

**Architecture:** Extend the existing human-only `escalation.decide` action with optional bounded `implementationGuidance`. Commit it atomically beside the existing continuation source, and read it only through that exact unconsumed decision and its approved compiled source. This does not create a second retry grant, alter criteria, or retire repository ownership.

**Tech stack:** TypeScript, the existing SQLite decision store, React, Vitest, and the Windows package entrypoints.

## Required behavior

- A supported escalation offer may accept `implementationGuidance`, a nonblank string of at most 4,000 UTF-16 code units and 16,000 UTF-8 bytes.
- Guidance is permitted only on `ALLOW_MORE_ATTEMPTS` for a provable approved compiled node and its exact reviewed source. An absent field retains legacy behavior and result bytes.
- The existing configured-operator or durable-paired-human authority check remains mandatory. The command stays excluded from agent MCP tools.
- The approved source identity and text are committed in the existing decision result. Its result digest binds the guidance together with the continuation. No extra aggregate version or retry allowance is created.
- The next wrapper mission follows the current unconsumed continuation's decision ID and digest, rechecks the approved source, and presents the exact text as separately labelled operator implementation guidance.
- Missing optional guidance is normal. Present but unverifiable guidance must not become an ordinary brief or silently disappear while an attempt runs.
- Guidance never overrides approved requirements, changes criterion ownership, supplies verifier proof, or grants another attempt after its continuation is consumed.
- A newer UI must not send guidance to an older daemon that would silently ignore it. The supported offer must explicitly advertise the capability, and the UI must validate it before dispatch.

## Backend work

Files:

- Modify `apps/daemon/src/daemon-command-payload-keys.ts` to admit the optional field for the existing kind.
- Modify `apps/daemon/src/review/review-acceptance.ts` for bounded validation and atomic inclusion beside `continuationSource`.
- Create `apps/daemon/src/review/review-implementation-guidance.ts` and its physical `.js` bridge for the source binding, decoder, and exact decision reader.
- Share the existing byte-identical canonical artifact renderer between `review-submission-artifact.ts`, `review-submission-package.ts`, and the guidance reader.
- Modify `apps/daemon/src/orchestrator/wrapper-review-missions.ts` to include proven guidance outside the truncated agent diagnostic block.
- Add focused guidance service and wrapper tests, reusing the actual approved-plan and host-prepared review fixtures.
- Modify the escalation offer producer in `apps/daemon/src/http/affordance-read.ts` to advertise the exact guidance capability. Verify the existing client affordance decoder accepts the advertisement before selecting its representation.
- Update the command registry and vocabulary test inventories for the admitted optional payload field.

First reproduce the missing guidance with a failed test: create an approved compiled plan, submit three host-prepared failed rounds, approve one attempt through the authenticated human command path with guidance, and inspect the real next wrapper brief. Then implement the minimum carrier and reader.

The regression must prove one decision/version increment, exact text consumption, unchanged criterion denominator and checks, and no cross-node or cross-graph carry. Refusal cases cover malformed/oversized text, `REPLAN`, stale versions, forged or expired identities, changed replay bytes, corrupt decision evidence, and consumed grants.

## UI work

Files:

- Modify `apps/control-room/src/v2/approvals/escalation-port.ts` and its tests to carry supported guidance without changing the offered target or version.
- Modify `apps/control-room/src/v2/approvals/needs-you.tsx` and `live-needs-you.tsx`; extract a focused guidance input component if needed to retain the source size limits.
- Add render and live callback regressions in the existing escalation test consumers.

Expose an optional labelled text area with the bound length limit only when supported. Entered text changes the action label to `Retry with guidance`; sending it is the same explicit one-attempt approval. Reset draft state when the node or offered review version changes. Preserve the text on a refusal and retain the existing missing/stale finding protections. Keep REPLAN independent of this field.

## Completion evidence

Run focused red/green tests, then required repository gates and the full UI suite. Build from the locally committed source, verify the packaged module bridge and UI, and run the actual packaged startup smoke. Preserve the running project until the user permits the required restart.

Prepare the already-delegated implementation choices as concrete guidance for review. The live outcome is not complete merely because tests pass: the replacement runtime must receive the approved guidance, the next worker must demonstrably consume it, and the actual task must pass review or expose a different concrete implementation blocker. Repeating the same unanswered findings is a failed outcome.
