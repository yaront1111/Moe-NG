# Publish REVIEW_HANDLERS on @moe/daemon root — architect handoff

- Task `task-f5d1dae629ec4c8bbb74b370c0a1d789` was planned and submitted in SPEED mode with 4 steps, 2 owned files, status `AWAITING_APPROVAL`.
- Owned paths are only `apps/daemon/src/index.ts` and `apps/daemon/src/index-surface.test.ts`; no review module, fixture, manifest, lockfile, or bridge edits.
- Publish exactly one new runtime root symbol: `REVIEW_HANDLERS`. The DoD fixes `EXPECTED_EXPORTS` at 32 (31 -> 32), so do not also expose `runReviewCommand`, the decoder, review constants, or fixtures.
- Add the necessary review type-only closure from `review-contracts.ts` and `review-ledger.ts`. Existing bootstrap root exports collide on `CommandHandler`, `HandlerContext`, and `HandlerTable`; alias the review types as `ReviewCommandHandler`, `ReviewHandlerContext`, and `ReviewHandlerTable`.
- Root tests must import through `@moe/daemon`, pin `REVIEW_HANDLERS` as an object, exact runtime export-set equality, and exact sorted keys: `escalation.decide`, `integration.accept_output`, `qualification.replan`, `review.submit`.
- `apps/daemon/src/index.ts` was observed at 222 physical lines. Keep explicit `.js` named/type exports compact enough to remain <=250; block instead of widening ownership if this proves impossible.
- Adversarial mutations must prove: missing symbol is detected, a wrong object-valued handler table is detected by key assertions, and an extra runtime export is detected by set equality/cardinality.
- Exact completion gate combines daemon typecheck, daemon tests, repo typecheck, and a plain Node package-root probe from `apps/daemon`; retain daemon test count and path-attributed repo-wide baseline evidence.
- Related landed implementation: `mem:task-task-9011e3b32c414e9ca0d49f49fdfaaf08-handoff`. Prior root-publication pattern: `mem:task-task-6054520bc52942889d32cd7481e61d4c-handoff`.

# Worker outcome (worker-4e85eff4) — landed, REVIEW

Commit **f1a494e**, exactly the two owned paths: `index.ts` +27/-0 (222 -> 249
lines), `index-surface.test.ts` +70/-1 (265 -> 333). Plan followed as written; no
step needed amending.

## Published surface

One runtime export (`export { REVIEW_HANDLERS } from "./review/review-services.js"`)
plus 22 type-only names in two grouped `export type` blocks:

- from `./review/review-contracts.js` (12): ReviewRequest, ReviewCommandKind,
  ReviewDecodeResult, ReviewDecodeRefusal, ReviewRequestAccepted,
  ReviewRequestRefused, ReviewInputRejected, ReviewIngressRefusalCode,
  ReviewPrerequisiteRefusalCode, ReviewRefusedBy, DeltaClassification,
  DeltaNodeClassification.
- from `./review/review-ledger.js` (10): ReviewOutcome, ReviewAccepted,
  ReviewRefused, ReviewLedger, ReviewRoundRecord, ReviewDaemonLayer,
  ReviewDaemonRefusalCode, and `CommandHandler as ReviewCommandHandler`,
  `HandlerContext as ReviewHandlerContext`, `HandlerTable as ReviewHandlerTable`
  — the alias the architect predicted is real; bootstrap-ledger owns those three
  bare names at index.ts:25,28,29 and tsc raises TS2308 without it.

`ReviewLedger`/`ReviewRoundRecord` come from `review-read-model.ts` but are
re-exported by `review-ledger.ts:20-21`, so the root imports them from the ledger
module and never reaches past the seam.

## Evidence

Owned gate exit 0: daemon typecheck 0; daemon suite 26 files / **483** tests
(baseline 480 at merge-base 1ce0059, +3, never below). Plain-Node root probe,
cwd `apps/daemon`, Node v24.16.0 — `object ["escalation.decide","integration.accept_output","qualification.replan","review.submit"]`.
`mem:pattern-prove-a-published-package-root-with-plain-node`.

Three mutation drills, index.ts sha256 identical before/after (backup kept in
/tmp, outside the tree, per `mem:gotcha-mutation-drill-swept-by-foreign-completion-hook`):
drop the export -> red by NAME (Object.hasOwn) before red by count; publish
`GOAL_HANDLERS as REVIEW_HANDLERS`, which keeps the exported-name set at 32 ->
red on the four-key assertion (`[ 'goal.close', 'goal.create' ]`), which is the
drill that proves the test pins table IDENTITY, not typeof; add one unapproved
export -> red on set equality.

Repo-wide typecheck is exit 1 and none of it is this diff:
`packages/contracts/src/distribution/distribution-manifest.test.ts` (already red
at merge-base) and `apps/control-room/src/a11y/ui-wide-acceptance.test.tsx(4,54)
TS6133`. Both UNTRACKED at merge-base, delta-by-path ∩ owned paths = empty.

## The thing the next agent actually needs to know

**32 publishes the table, not the pipeline.** `runReviewCommand`
(review-services.ts:177), `readReviewLedger` and `decodeReviewRequestBytes` are
all still internal, so a consumer can NAME every review type and dispatch
`REVIEW_HANDLERS`, but cannot construct a `ReviewHandlerContext`
(`{ ledger, request, store }`) through production authority — the ledger can only
come from `readReviewLedger`. If **task-97554aa4** (Foundation canary) drives a
review command end-to-end rather than merely reaching the table, it needs a
follow-on task publishing `runReviewCommand` at cardinality 33. Raised to
governor-f70d1157 in #general (msg-d1a05fcfb77644b6a39b0b4edecbedc7) before
unblock. Global rail Clause 1 is the reason this matters: exporting symbols is
not composition.

Also new from this task: `mem:gotcha-moe-complete-task-verification-command-500-char-cap`.