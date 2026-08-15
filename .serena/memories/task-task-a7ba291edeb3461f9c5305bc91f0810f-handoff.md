# Recovery doctor console — implementation handoff

`task-a7ba291edeb3461f9c5305bc91f0810f` implemented by `worker-0b27a5cc` on 2026-08-09.
Status REVIEW. Commit `5b06596`. Gate: `pnpm --filter @moe/control-room test` EXIT=0,
25 files / 369 tests.

## Shipped files (ten, not the planned eight)

Production (all <=250 physical lines, `grep -c ""`):
- `apps/control-room/src/doctor/doctor-console.tsx` (249)
- `apps/control-room/src/recovery/recovery-actions.tsx` (250)
- `apps/control-room/src/recovery/reconciliation-inventory.tsx` (192)
- `apps/control-room/src/recovery/recovery-external.tsx` (134) — split from recovery-status
- `apps/control-room/src/recovery/recovery-status.tsx` (149)

Tests: `doctor-console.test.tsx`, `recovery-actions.test.tsx`,
`reconciliation-inventory.test.tsx`, `recovery-status.test.tsx`, and
`recovery-import-ban.test.ts` (structural scan split out; recovery-status.test.tsx was
464 lines before the split).

`doctor/doctor-j1.tsx` is byte-untouched; `shell/j1-flow.test.tsx` still imports it.

## The authority shape, if you extend this

`RecoveryActions` is the ONLY mutation path on these surfaces. Everything else — the
reconciliation narrative, the doctor suggestions, the inventory prose — is copy.
- `RecoveryActionPresentation` is a two-arm union discriminated by optional `commandId`:
  a command arm (commandId + exact target + label/qualifier) or an unavailable arm
  (commandKind + a fully supplied `{phrase, reasonCode, layer}`). An expectation that
  matches nothing AND explains nothing renders nothing.
- The join needs exact `commandId` AND `targetAggregateId`, and returns a command only
  when EXACTLY ONE matched. A blank id or target never matches.
- `onRequestConfirmation(command, presentation)` gets the original frozen objects by
  reference. Never clone, envelope, dedupe, or classify.
- `enabled = actionsEnabled && authorityMode === "LIVE"`. `useGating().stale` is
  deliberately never read — a lagging view still shows commands the daemon returned
  and those revalidate daemon-side (§8.6). Two tests pin that lag does not block.

Doctor renders ZERO `cr.action.*` by design (CR-DOC-001), so the offline suggestion list
is `<li>` text.

## Test-id grammar added

`cr.health.check.{checkId}`, `cr.health.outcome.{checkId}` and `cr.health.outcome.overall`
(deliberately a different prefix from the row so a `^=` selector counts each exactly),
`cr.health.doctor.banner|suggestion.{i}`, `cr.health.reconciliation.row.{recordId}` and
`.narrative.{recordId}` / `.choose.{recordId}`, `cr.health.outbox|versions|backup|export`,
`cr.health.inventory.{classId}`, `cr.action.<dashed-kind>[.<qualifier>]`,
`cr.recovery.unavailable.<slug>`, `cr.recovery.feedback.{commandId}`. Action groups carry
`data-recovery-actions` so a surface can prove no control renders outside one.

## Constants that are verbatim spec/design and must not be reworded

§8.7 offline banner and reconciliation sentence tail; §12 line 711
`still working — the daemon accepted the command (event pending)`; the design-16.5
post-cursor RPO sentence; the export-is-not-a-backup note; the two not-a-proof lines for
an empty reconciliation list and an empty inventory class. Tests hand-write each one;
never assert them by calling the production formatter.

## Distinctions the daemon owns and this layer must never compute

Overall health roll-up, per-check severity ranking, SQLite compatibility, outbox lag from
the two cursors, backup completeness, orphan-inventory completeness, and
`recovery.complete` eligibility. `UNKNOWN` (payload said nothing usable) is rendered as a
DIFFERENT state from `UNKNOWN_TRUTH` (daemon reached an unknown-truth verdict).

Related: `mem:convention-control-room-test-id-prefixes`,
`mem:gotcha-blank-string-renders-as-a-confident-empty-cell`,
`mem:gotcha-import-meta-url-is-http-in-tsx`, `mem:gotcha-pol-chip-is-not-a-truth-chip`,
`mem:gotcha-source-scan-anchors-must-not-be-bare-prefixes`,
`mem:gotcha-foreign-whole-tree-commit-preempts-your-pathspec-commit`.
