# A migration leg that stamps the CURRENT version constant mis-stamps the day you add a version

Found 2026-08-16 on task-d20ffd07 (SQLite schema v4 -> v5, adding the
`domain_events_event_type_position` index).

`migrateV3ToV4` in `packages/store/src/sqlite-schema-migration.ts` shipped as:

```ts
database.exec(`${SCHEMA_OBJECT_SQL.recovery_bindings};`);   // CURRENT manifest
database.prepare("UPDATE store_metadata SET value = ? WHERE key = ?")
  .run(SQLITE_SCHEMA_MANIFEST_VERSION, "schema_manifest_version");  // CURRENT marker
database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);          // CURRENT version
```

That is correct *only while v4 is current*. The moment `SCHEMA_VERSION` became 5,
this leg still created just `recovery_bindings` but stamped `/5` + `user_version 5`
— minting a store that CLAIMS v5 while missing the v5 index. The next open then
fails exact conformance, and the file is stuck: it is not v4 (marker says 5) and
not valid v5 (object missing).

**The rule:** a migration leg from N to N+1 must reference FROZEN N+1 constants,
never the moving `CURRENT` ones. Every leg needs its own
`SCHEMA_V<N>_OBJECT_SQL` / `SCHEMA_V<N>_MANIFEST_VERSION` and a literal
`PRAGMA user_version = <N+1>`. Only the LAST leg may legitimately name
`SQLITE_SCHEMA_MANIFEST_VERSION` / `SCHEMA_VERSION`, and it stops being allowed
to the moment another leg is appended after it.

The green suite does not catch this. Before the v5 work every migration test
asserted `user_version: 4` and `moe-sqlite-schema/4`, which the CURRENT constants
satisfied by coincidence. The bug only surfaces when you bump the version — i.e.
in the same commit that has the least attention budget left.

## Adding a version: the shape that worked
1. Freeze the outgoing set under its own name first — `SCHEMA_V4_OBJECT_SQL =
   Object.freeze({...SCHEMA_V3_OBJECT_SQL, ...SCHEMA_V4_RECOVERY_OBJECT_SQL})` —
   so it is a genuine frozen source, not a re-derivation.
2. Define current as `{...SCHEMA_V4_OBJECT_SQL, <one new object>}`.
3. Repoint the previous leg onto the frozen constants + a literal PRAGMA.
4. Widen `validateMigrationSource`'s version union and let the legs chain:
   `if (currentVersion <= 3) migrateV3ToV4(db); migrateV4ToV5(db);`

## Two facts about `validateExactSchemaObjects` that constrain the DDL
Verified against real `node:sqlite`, not assumed:
- It compares the STORED `sqlite_schema.sql` text after `normalizeSchemaSql`
  (trim + strip trailing `;`). The repo's multi-line index idiom round-trips
  BYTE-EXACT, so matching the existing `outbox_pending_order` formatting is safe.
- It derives object type from `normalized.startsWith("CREATE INDEX")`, and looks
  objects up BY NAME — so the manifest KEY must equal the SQLite index name.
- Therefore `IF NOT EXISTS` / partial predicates are forbidden here: they change
  the stored text and convert a fail-closed drift check into a silent pass.

## Why a name-only index assertion is worthless
A column-REVERSED index keeps the same name AND the same object count, and if the
manifest itself is what got reversed, exact conformance compares the mutation
against itself and agrees. Proven by mutation drill: reversing only
`(event_type, global_position)` -> `(global_position, event_type)` left the store
opening cleanly and left `validateExactSchemaObjects` green. What caught it was
`PRAGMA index_info(<name>)` asserting exact column ORDER, plus an
`EXPLAIN QUERY PLAN` detail pinning `(event_type=? AND global_position>?)`.
Assert order and plan, never just presence. See `mem:gotcha-an-indexed-column-can-drift-from-the-bytes-it-indexes`.

## Reaching migrateLocked's unrecognized-source branch
With 1-4 recognized, 5 current and >5 answered by `STORE_SCHEMA_INVALID`, the only
value that still reaches `DATABASE_IDENTITY_MISMATCH` in `migrateLocked` is a
NEGATIVE `user_version` (SQLite stores it signed; -1 round-trips fine).
`user_version = 0` does NOT get there — `isFreshDatabase` in
`sqlite-schema-bootstrap.ts` refuses first with the same code but a different
message ("recognized Moe application ID has no committed schema version"). Two
layers, one code: assert the message too, or the test silently stops covering the
branch it names.
