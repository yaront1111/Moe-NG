# Handoff: decision read-model decomposition (REVIEW -> DONE, QA approved)

Commit **a92f1b5**, 7 owned paths, explicit pathspec. Design detail lives in
`mem:decision-read-model-decomposition`; the proof technique lives in
`mem:gotcha-verbatim-move-refactor-proof`.

## Result
`decision-read-model.ts` 553 -> 165. New: `decision-read-sql.ts` (106),
`decision-read-decode.ts` (319), `decision-read-pages.ts` (67), each with a
committed `.js` shim. All under the 350-line DoD cap. Class surface unchanged;
`index.ts` untouched; sole importer outside the file is `decision-ledger.ts`.

## QA verdict (qa-200db8e3) — APPROVED
Re-ran independently, not trusted from the summary:

- `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test` exit 0,
  **18 files / 112 tests passed**, 1.01s.
- **Decode body verbatim, proven mechanically.** `git show a92f1b5^:...` lines
  228-486, dedented 2 and `this.` -> `ctx.`, diffed against
  `decision-read-decode.ts` 67-318: exactly ONE hunk, the pre-declared one
  (inline `this.database.prepare(...)` audit query -> `ctx.loadRejectionAuditRow`).
  Every `DurableStoreError` code, message string, and check order identical.
- **All six SQL constants byte-identical** to the pre-split originals. Loaded
  `decision-read-sql.ts` under `node --experimental-strip-types`, regex-pulled
  every `.prepare(\`...\`)` template out of the HEAD~1 file, resolved
  `${DECISION_DECODED_BYTES_SQL}` from `read-page-queries.ts`, string-compared:
  BY_KEY / BY_POSITION / CANDIDATE_PAGE / AUDIT / RESERVED / SCAN all match, zero
  unmatched HEAD templates.
- **Both silent-break invariants held.** `materializeDecisionCursorPage` is
  called from inside `readSnapshotOperation` with the candidate query as an
  inline argument (one `BEGIN DEFERRED`), and `liveBindingAlreadyValidated` is
  still an explicit parameter — literal `true` only in the `loadByPosition`
  closure, default `false` on by-key and startup-scan.
- Retained class methods diffed clean; only hunks are the SQL-literal ->
  constant swaps already proven identical.
- Commit contains the 7 owned paths and **zero test files**. No `any`,
  `@ts-ignore`, or `eslint-disable` in the new modules. No scratch files under
  `packages/store`. Net +107 LOC (537 ins / 430 del) — well under the 400 cap.

## Foreign, deliberately untouched
Untracked `packages/testkit/src/phase0-evidence-*.ts` (+ its `.test.ts`) belong
to a concurrent phase0-evidence task, and all `.moe/*` state. Nothing foreign
was ever staged by this task.

## Scope note
Mid-epic focused verification only. Full-repo regression belongs to the epic's
hardening task — QA did not run it here and did not treat its absence as a gap.
