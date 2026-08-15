# Node attempt workspace — DELIVERED (2026-08-08, worker-7e037598)

Commit `8dbe3df`, path-limited over the ten owned paths. Gate:
`pnpm --filter @moe/control-room typecheck && pnpm --filter @moe/control-room test`
-> exit 0, 7 files / 90 tests. Mine: node-authority 12, node-context 10, node-evidence 10,
attempt-detail 10, review-surface 10.

## Shape that landed

`node-authority.tsx` is the shared presentation kernel for all five modules, not just the
authority panel. It owns `PresentedFact`/`SuppliedFact`, `UNKNOWN_FACT_VALUE`,
`NO_COMMANDS_SUPPLIED`, `NONE_SUPPLIED`, `FactRow`, `FactList`, `Panel`, `CommandKindList`,
`isSupplied`, `isIdentified`, `readIdentity`. Reuse those rather than re-deriving; truth
mapping itself still lives in `kernel.tsx` (`Fact`/`TruthChip`/`presentTruthClass`).

`FactRow` is the single choke point: the class travels with the value, so a withdrawn value
drops its class and cannot keep a green chip. `absentValue` overrides only the display text
(review calibration uses the spec's "calibration not yet measured"); the chip still reads
UNKNOWN/ABSENT.

## IDs a composing task must not rename

- inspector sections `cr.inspector.section.{identity|phase|lease|plan|binding|input|result|context|recovery|receipts|artifacts|findings|blockers}`
- `cr.inspector.{receipt|artifact|finding|blocker|journal}.{id}`, `cr.inspector.loopcounter`,
  `cr.inspector.legalcommands`, `cr.inspector.recoverycommands`
- attempt detail deliberately uses its OWN namespace `cr.attemptdetail.section.*` so it can
  never collide with the inspector's `receipts` section — but the transcript keeps the spec's
  `cr.inspector.transcript.{attemptId}` exactly.
- review: `cr.review.surface` + exactly `cr.review.{diff|criteria|receipts|findings|context}`,
  plus `cr.review.row.{path}` for diff rows. Rows use the declared row grammar precisely so
  the "exactly five components" audit (single-segment regex) does not inflate — same trap as
  `mem:convention-control-room-test-id-prefixes`.
- command labels `cr.action.<kind with . -> ->`, evidence links `cr.evidence.link.{kind}.{id}`.

## Two defects the adversarial pass caught (both fixed, both now tested)

1. `readValue` accepted `"   "`, so a whitespace value rendered blank beside a confident
   chip — the one presentation §10.3 bans. Now `value.trim() !== ""`. `isSupplied` inherits
   it, so a whitespace base SHA also refuses the diff.
2. Every list keyed on record identity, so two records that both lost their identity
   collapsed to key `"UNKNOWN"` and React may drop one — evidence vanishing rather than
   showing UNKNOWN. All collections now key `${index}:${id}`.

## Known and deliberate

- Duplicate supplied ids yield duplicate `data-testid`s (selector ambiguity only; both rows
  render). Bounding list length is the daemon's job, not the component's.
- No route, fetch, store, state, clock, or command construction anywhere. The generated
  client still has request-envelope builders only — no node/attempt/evidence/review DTO
  exists, and none was invented.

## Process hazards hit this session

- Two siblings' broad commits swept my in-progress files into THEIR commits (`633422f`,
  `ac61db2`). History attribution for this task is wrong and was NOT repaired — rewriting
  shared history is forbidden. See `mem:gotcha-shared-index-commit-capture`.
- The package gate was blocked twice by a sibling's in-flight `src/shell` red phase; polled
  the real command to green rather than substituting a scoped run. See
  `mem:gotcha-shared-package-gate-broken-by-sibling-red-file`.
