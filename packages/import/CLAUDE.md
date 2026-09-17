# @moe/import

The deterministic, read-only importer for a **frozen copy** of a legacy Moe project
(design §21.2-§21.7): a pure function from source bytes to a canonical import, where ids,
ordering, provenance times and payloads all derive from source digests and the manifest.
No clock, no random source, and no dependency at all (`package.json` declares none) —
either a clock or a host-dependent ordering makes §21.7's "identical bytes produce
identical canonical hashes" unprovable. Live legacy reads, write-back, dual write and
every cutover step (§21.9-§21.13) are out of scope.

## Seams

- Export map is `.` → `src/index.ts` only, and `index.ts` lists **curated named exports**
  rather than `export *`, so the published surface is a reviewed decision.
- The chain a consumer composes: `buildSourceManifest(root)` → `decodeLegacySources` →
  `applyImport` (which folds in `reconcileImport`) → `projectLegacyImport` /
  `compareShadowProjections`.
- `apps/daemon/src/projections/import-shadow-reader.ts` and `import-shadow-mapper.ts` are
  the production readers; `import-shadow-contracts.ts` takes types only and forwards this
  package's `IMPORT_EVENT_*` codes at their own layer without restamping.
  `import-generation-reader.ts` reads the same aggregate for the v2 cutover marker.
- `tools/import/import-shadow.ts` is the read-only CLI, `durable-import-store.ts` the real
  `ImportStorePort` over `SqliteEventStore`, `import-commit.ts` the commit entry point.
- `ImportStorePort` (in `import-apply.ts`) is declared **structurally**, so this package
  never depends on `@moe/store`; `durable-import-store.ts` is the one place the two
  shapes meet, and its `const commitInput: CommitInput = input` is the whole adapter.
- Test-side consumers: `tests/integration/portability/shadow-corpus-harness.ts`,
  `tests/security/import-shadow-boundary-scenarios.ts`, `tests/integration/import/`.

## The model

- **Two refusal vocabularies, one layer union.** `IMPORT_REFUSAL_CODES` (11 `IMPORT_*`
  codes) speaks about SOURCE bytes; `IMPORT_EVENT_REFUSAL_CODES` (7 `IMPORT_EVENT_*`)
  speaks about committed EVENT bytes. They are deliberately disjoint so an operator can
  tell a corrupt legacy file from a corrupt row. Both carry a member of
  `IMPORT_REFUSAL_LAYERS` = `INPUT, MANIFEST, DECODE, CANONICAL, APPLY, SHADOW`, listed in
  pipeline order; `SHADOW` is advisory and can never be on a writing path.
- **Two design rules are enforced by TYPES, not checks.** `ImportedClaimStatus` is
  `HISTORICAL | SUSPENDED` with no ACTIVE arm (§21.4), and `LegacyLink.evidenceOnly` is
  the literal `true` (§21.5). The event codec re-asserts `evidenceOnly: true as const` on
  decode rather than copying it, so a decoded link cannot widen to `boolean`.
- **Three ambiguity authorities, kept apart on purpose**: `DESIGN_AMBIGUITY_CLASSES` (the
  §21.6 seven), `SKILL_ASSET_AMBIGUITY_CLASSES` (the 2026-08-07 roadmap amendment's five
  `SKILL_*`), `DERIVED_IDENTITY_AMBIGUITY_CLASSES` (`DUPLICATE_IDENTITY`). Every finding
  carries the single `AMBIGUITY_OUTCOME = "NEEDS_RECONCILIATION"`. `reconcileImport` never
  throws and never drops a record — the import completes and reports.
- **Identity is a digest over a canonical RECORD, never a joined key.**
  `deriveImportedId` hashes `{kind, legacyId, manifestDigest, sourcePath, version}`
  because `kind "a" + id "b:c"` and `kind "a:b" + id "c"` both render `a:b:c`.
  `linkId`, `orderRecords` and `duplicateIdentityFindings` all use the same reasoning.
- **`byCodeUnit` is the only string comparator allowed.** `localeCompare` depends on host
  ICU data, so two machines would order the same paths differently and digest differently.
  `canonical-bytes.ts` mirrors `packages/runner/src/canonical.ts` deliberately (the
  runner's `exports` map is exclusive, so no specifier reaches it) and is **stricter**:
  `isPlainRecord` requires `Object.prototype` or `null`, rejecting `Uint8Array`, `Date`,
  `Map` and `Set`, which would otherwise digest as `{"0":1,…}`.
- **Time.** `declaredTime` is whatever the source declared, validated as canonical UTC
  `YYYY-MM-DDTHH:mm:ss.sssZ` at DECODE; otherwise provenance takes
  `DETERMINISTIC_TIME_SENTINEL` (`1970-01-01T00:00:00.000Z`) and `timeBasis`
  `MANIFEST_SENTINEL`. `applyImport`'s `committedAt` is the latest source time or that
  sentinel.
- **The manifest is the read set.** `source-manifest.ts` sorts every `readdir` listing
  before descending, uses `lstat` (a symlink refuses `IMPORT_SOURCE_UNREADABLE` rather
  than being skipped), refuses a non-NFC on-disk name, refuses an empty tree
  (`IMPORT_MANIFEST_EMPTY`) and refuses two entries aliasing one path.
  `legacy-decoder.ts` holds **no `readdir` and no globbing**: it re-hashes each manifest
  entry before parsing (`IMPORT_SOURCE_DIGEST_MISMATCH`), derives nothing from the path
  except which family applies (`SUPPORTED_SOURCE_FAMILIES = {skills: "skill",
  tasks: "task"}`, matched with `Object.hasOwn` so `__proto__` cannot become a kind),
  strips `RECORD_ENVELOPE_KEYS` (`id`, `legacyId`, `time`) from the payload, and refuses
  `IMPORT_SOURCE_AMBIGUOUS` when `id` and `legacyId` disagree.
- **One import is ONE commit.** `aggregateId` is `legacy-import:<manifestDigest>` at a
  fixed `expectedVersion: 0`; exceeding `maxEventsPerCommit` refuses
  `IMPORT_TOO_LARGE_FOR_ONE_COMMIT` rather than splitting. Event payloads are the
  `import-event-facts` canonical encoding of the DERIVED facts, and `foldRecord` reads the
  claim and links back OUT of those bytes so the report is the stored representation. A
  repeated derived id with identical facts collapses to one draft (the store holds
  `UNIQUE(event_id)`); with different facts it refuses `IMPORT_EVENT_IDENTITY_CONFLICT`
  at `APPLY` before anything is written.
- **`decodeImportEventFacts` re-encodes and compares to the input text.** That last step
  is load-bearing: duplicate keys, reordered keys and inserted whitespace all parse
  identically, and only the compare sees them (`IMPORT_EVENT_BYTES_NONCANONICAL`).
  Fields are read through `Object.getOwnPropertyDescriptor`, never `value[key]`, so an
  accessor cannot answer differently on its second call.
- **The shadow comparator declares its own target vocabulary** (`shadow-contract.ts`,
  `SHADOW_PROJECTION_VERSION`) instead of importing the daemon's `BoardProjection` —
  depending on `apps/daemon` would invert the dependency graph. Dispositions are only
  `NEEDS_RECONCILIATION | UNKNOWN`; an undeclared field reports `FIELD_UNMAPPED` plus one
  `IMPORT_SHADOW_FIELD_UNMAPPED` refusal at layer `SHADOW`. A `SUSPENDED` claim projects
  both a `CLAIM` and a derived `BLOCKER`.
- **The file splits are the 250-line rail, not seams.** `import-event-facts.ts` /
  `import-event-codec.ts`, `shadow-contract.ts` / `shadow-projection.ts`, and
  `import-duplicate-identity.ts` + `import-reconcile-graph.ts` out of `import-reconcile.ts`
  are all "split the file, never the task"; each pair is published through ONE specifier.
  `graphFindings` keeps its own heap stack so a long `dependsOn` chain cannot overflow.

## Gotchas

- Every `.ts` module here needs its sibling one-line `.js` bridge (`export * from
  "./thing.ts";`); test files deliberately have none.
- `corpus/legacy-project/` is pinned **by hand** in `legacy-shadow.test.ts`:
  `CORPUS_MANIFEST_DIGEST`, and a per-file `[path, sha256, size]` table, plus exact counts
  (6 records, 3 decode refusals, 4 findings, 6 CLAIM / 1 BLOCKER / 3 LINK). Touch one
  corpus byte and all of it reds — re-measure, never widen. A separate arm asserts no
  `0x0d` byte, so a CRLF checkout names itself instead of producing an opaque digest miss.
- The last corpus arm spawns `node --experimental-strip-types tools/import/import-shadow.ts`
  and compares digest, size **and mtime** of every covered file before and after: any
  write-mode open in that CLI reds it even if the bytes are restored.
- `tests/security/boundary-roster.security.ts` pins `"packages/import": 1` (just
  `IMPORT_REFUSAL_LAYERS`, axis `transport`). A second `export const *_LAYER(S)` in this
  package reds `pnpm test:security`.
  `tests/integration/release/release-version-surfaces.test.ts` pins this `package.json`.
- `tools/` is not a workspace package (`pnpm-workspace.yaml` globs `apps/*`, `adapters/*`,
  `packages/*` only), so `tools/import/*` imports `../../packages/import/src/index.js` by
  deep relative path and is typechecked **only** by `pnpm typecheck:import`, which names
  each file explicitly — a new file there must be added to that script or nothing checks it.
- `applyImport` always commits at `expectedVersion: 0` with a manifest-derived
  `commandId`, so a re-import of the same tree is a store `COMMAND_ID_CONFLICT`;
  `commitLegacyImport` reports that as `REPLAYED` with `DURABLE_COMMIT_LAYER = "STORE"`
  rather than letting it surface as `IMPORT_COMMIT_FAILED`.
- `import-apply.test.ts` asserts a live emitter for every declared event code and
  `import-contract.test.ts` a finding for every ambiguity class: an unreachable one reds.
- `import-reconcile-graph.test.ts` holds goldens captured from the ORIGINAL recursive
  walk. They police finding ORDER and the cycle dedup key (`cycle:${ref}`), so an
  innocent-looking reordering of the walk changes which node reports a shared cycle.
## Testing

- One file, from the repo root: `pnpm vitest run packages/import/src/legacy-shadow.test.ts`
  (the root config includes `packages/**/*.test.ts`, `environment: "node"`).
- Whole package: `pnpm --filter @moe/import test` (its script is
  `vitest run --root ../.. packages/import/src`); typecheck with
  `pnpm --filter @moe/import typecheck`.
- Outside coverage: `pnpm test:migration` (`tests/migration/import/import-determinism.test.ts`
  — two full runs over separate trees against a real `SqliteEventStore`),
  `pnpm test:integration` (`tests/integration/import/legacy-import-commit.test.ts`,
  `tests/integration/portability/shadow-corpus-*`, and `pnpm typecheck:import` which it
  runs first), `pnpm test:security` (`boundary-roster`, `import-shadow-boundary-scenarios`,
  `transport-hostile-*` which import `canonicalPayload` and `IMPORT_REFUSAL_LAYERS`
  directly), and `pnpm --filter @moe/daemon test` for
  `apps/daemon/src/projections/import-shadow-*` and `import-generation-reader`.
