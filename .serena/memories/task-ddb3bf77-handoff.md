# task-ddb3bf77 — Runs / Resources / circuit-breaker surfaces (handed to QA 2026-08-09)

Status: REVIEW. 10/10 steps. Gate `pnpm --filter @moe/control-room test` = 39 files / 569 tests, EXIT 0; package typecheck EXIT 0.

## What QA should look at first
1. `apps/control-room/src/approvals/narrow-parity.test.tsx` — this is the file a prior QA reversed its
   approval over. The source-text scan is gone; parity now runs through the file's own machinery
   (TABLE_SURFACES -> mountAt(1440)/surfaceTestIds/cleanup/mountAt(720)/sorted) with
   `toBeGreaterThan(0)` on BOTH sides before `toEqual`, so it cannot pass vacuously.
   `SURFACES.length` deliberately still `toBe(15)` — not renumbered, by agreement.
2. `shell/frame.tsx` carries a FOREIGN uncommitted -95/+30 shell-composition refactor
   (`shell-chrome.tsx`, `nav-rail.tsx`, `shell-layout.css`). Judge my scope on the committed diff,
   not on `git status`. `grep -rln circuitbreaker apps/control-room/src` resolves in BOTH frame.tsx
   and the new shell-chrome.tsx — the banner survived their move.
3. Downstream: task-fdf3e6aa recorded its spec-4.16 table clause not-applicable BECAUSE cr.runs /
   cr.resources did not exist. They exist now; that task must re-measure, not inherit the exemption.

## Invariants that must not regress
- No clock read, no timestamp comparison anywhere in runs/resources. Lease health is daemon-asserted only.
- CR-J5-001: healthy-renewal + long-quiet ACTIVE row -> both silence datums separate and neutral,
  NO warning glyph, NO revoke affordance.
- No revoke modal here. REVOCATION_CONFIRMATION already lives in `approvals/approval-detail-confirmation.tsx`.
- Circuit breaker composes ALONGSIDE frame.tsx's one-banner early-return chain, never inside it.
- No `cr.graph.*` and no `cr.banner.revision` id — three committed tests ban that prefix.

## Mutation drill already run (rail 6), all reverted to pre-drill sha256
960px-only Runs field -> parity row red and only it (1 failed / 21 passed); derived warning on ACTIVE
lease -> CR-J5-001 red; empty RunsSurface -> "expected 0 to be greater than 0"; bad command kind ->
"expected [] to have a length of 1".

See `mem:gotcha-self-block-clears-via-unblock-worker` for how the block on this task was cleared.
