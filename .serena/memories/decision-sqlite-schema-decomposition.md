# SQLite schema decomposition (task-9e3faf3b, commit 9e16dde)

`packages/store/src/sqlite-schema.ts` 648 -> 71 lines, split into four internal
modules. Behavior-neutral: no schema version, table, index, pragma, DDL, or
stable error changed; zero test edits. Gate 18 files / 112 tests, unchanged
from the pre-edit baseline.

## Shape

    sqlite-schema.ts            71  facade: canonicalDatabasePath,
                                    isFreshDatabaseFileCandidate,
                                    compareVersions + re-exports
    sqlite-schema-conformance.ts 72  normalizeSchemaSql (private),
                                    validateExactSchemaObjects,
                                    validateSchemaManifestMetadata
    sqlite-schema-integrity.ts  215  validateSchema
    sqlite-schema-migration.ts  100  migrateLocked
    sqlite-schema-bootstrap.ts  227  isFreshDatabase, resolveProjectBinding,
                                    isSqliteBusy, bootstrapAndValidateSchema

Graph is a strict DAG:
facade -> bootstrap -> {integrity, migration} -> conformance -> {contracts, rows}

`sqlite-schema-manifest.ts` deliberately untouched — all DDL still lives there
and is imported, never duplicated. `index.ts` never referenced sqlite-schema,
so no package-root export changed. The five exported names are identical to
HEAD; `isSqliteBusy` and `bootstrapAndValidateSchema` are now re-exports.

## Do not "simplify" these

- **Two near-identical message families exist and must not be merged.**
  migration carries the v1-worded strings ("foreign-key verification found v1
  relationship violations", "SQLite v1 quick_check did not pass"); integrity
  carries the current-schema equivalents without "v1". Separately, bootstrap
  has TWO STORE_BUSY messages: "database startup lock timed out" (BEGIN
  IMMEDIATE) and "database bootstrap timed out" (inner catch). Deduplicating
  either pair changes observable errors.
- **OUTCOME_UNKNOWN precedes the STORE_BUSY check** in the bootstrap catch.
  Reordering silently converts an unprovable commit into a retryable busy.
- **`commitAttempted = true` must stay immediately before `exec("COMMIT")`.**
  It is the entire basis of acknowledged-COMMIT-loss detection.

## Why the green suite is not the proof

The store suites assert error CODES only — STORE_CORRUPT x34,
STORE_SCHEMA_INVALID x4, STORE_MIGRATION_REQUIRED x1. Reordering two checks
that raise the same code, or rewording any message, passes 112/112 silently.
STORE_MIGRATION_REQUIRED in particular has a single assertion guarding the
whole populated/advanced-sequence refusal branch.

Proof used instead — see `mem:gotcha-refactor-coverage-arithmetic`.
