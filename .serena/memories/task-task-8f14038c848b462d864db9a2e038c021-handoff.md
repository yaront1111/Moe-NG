# Project goal lifecycle core — implementation + QA verdict

Task task-8f14038c848b462d864db9a2e038c021 implemented @moe/core project and goal lifecycle reducers. **QA APPROVED** (qa-91cf5a2f, independent re-verification).

## Commits
- `16334bd` — package scaffold, public root exports, project/goal contracts, validators, reducers, tests (13 owned paths).
- `1f8f7e6` — packages/core pnpm-lock importer only.
- `0967d48` — malformed optional close proofs stay invalid instead of collapsing to absence.

## Key semantics
- Project matrix: register -> BOOTSTRAPPING; repeatable repository binding; activation -> READY; restore quiesce -> QUIESCED + recoveryRequired; recovery complete -> READY; DEGRADED representable but unreachable (all cells ILLEGAL_TRANSITION).
- Goal matrix: create DRAFT, activate EXECUTION_ENABLED, closure CLOSING, zero-authority COMPLETED (two-event atomic close, versions +1/+2), invalidation rollback to EXECUTION_ENABLED, fenced cancellation, orthogonal scheduling, terminal successor reopen.
- Reopen keeps lifecycle terminal, advances old-aggregate version, returns generation+1 successor as DATA (never a second live aggregate).
- Reducers deep-snapshot descriptor values before validation/dispatch; caller-owned state is never frozen. Unique symbol sentinel separates malformed optional proofs from genuine absence.
- Only registry codes used: EXPECTED_VERSION_CONFLICT, IDEMPOTENCY_CONFLICT, ILLEGAL_TRANSITION, UNKNOWN_ERROR. No invented PROJECT_*/GOAL_* namespace. No reducer replay branch — commandId echoed into every event; decision ledger owns replay.

## QA evidence (re-run independently, not trusted from summary)
- `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` => exit 0, 6 files / 132 tests.
- `pnpm typecheck` => exit 0 (all packages). `pnpm test` => exit 0, 71 files, 892 passed / 1 skipped.
- Purity grep (Date.now|new Date|Math.random|process.|readFile|writeFile) over production sources => 0 hits.
- Production modules: project-contract 144, project-reducer 197, project-validation 196, goal-contract 216, goal-reducer 247, goal-validation 245, index 58 — all <=250 target.
- Working tree clean for packages/ and pnpm-lock.yaml; no scratch files.

## QA notes for future core tasks
- Diff is ~2345 added LOC (~1305 production, ~1040 test) — far over the 400-LOC QA sizing heuristic, but per-file epic rails all pass and sibling core/skills tasks landed at 1047/1412. Architect should split future dual-aggregate lifecycle tasks (one aggregate per task).
- `packages/core/src/index.ts` exports project+goal only; the earlier identity area (`0a305cd`) is NOT reachable from the package's single `"."` export. Not introduced by this task (identity never touched root index), but an integration gap someone must close.
- `snapshot*Command` validates `kind` and field shapes but does not reject unknown extra top-level command keys (witness objects ARE exact-key checked). Deliberate leniency; worth pinning if commands ever cross a trust boundary.

See also `mem:gotcha-pure-reducer-deep-freeze-aliasing`.
