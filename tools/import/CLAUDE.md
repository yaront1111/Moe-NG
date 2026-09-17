# tools/import

The two operator CLIs over `@moe/import`, plus the one adapter file where that package's
**structurally declared** `ImportStorePort` is allowed to meet `@moe/store`'s real
`SqliteEventStore`. `import-shadow.ts` compares a copied legacy snapshot against the new
side and writes nothing; `import-commit.ts` is the only production path that writes a
`legacy.<kind>.imported` row anywhere. `tools/` is **not** a workspace package
(`pnpm-workspace.yaml` globs `apps/*`, `adapters/*`, `packages/*` only), which is why every
production import here is a deep relative path and why this folder has its own typecheck.

## Seams

- `import-shadow.ts` → `runImportShadow(args): { code, text }`. Run it as
  `node --experimental-strip-types tools/import/import-shadow.ts <copied-root> [--current
  projection.json]`. Real callers: `packages/import/src/legacy-shadow.test.ts` (spawns it
  with `execFileSync`) and `tools/import/import-shadow.test.ts` (calls the function).
- `import-commit.ts` → `runImportCommit(args)`, `parseOptions`, `USAGE`, `Options`. Usage is
  `<copied-root> --store <existing.db> --project <projectId>`; the one caller is
  `tests/integration/import/legacy-import-commit.test.ts`.
- `durable-import-store.ts` → `commitLegacyImport(input)`, `DURABLE_COMMIT_LAYER = "STORE"`,
  and the result union `DurableCommitted | DurableCommitRefused | ImportRefused |
  ImportEventRefused`. Callers: `import-commit.ts`,
  `tests/integration/import/legacy-import-commit.test.ts`,
  `tests/integration/portability/shadow-corpus-harness.ts` (`ingestCorpus`), and
  `tests/security/import-shadow-boundary-scenarios.ts` (`seedLegacyImport`).
- `shadow-input.ts` → `parseOptions`, `readCurrent`, `USAGE`. Consumed only by
  `import-shadow.ts`; it is the untrusted-input boundary (argv plus the `--current` file).
- Upward imports are exactly `../../packages/import/src/index.js`,
  `.../canonical-bytes.js`, `../../packages/store/src/sqlite-event-store.js` and
  `.../store-contracts.js`. Nothing here reaches `apps/daemon`.

## The model

- **The durable adapter is the absence of transformation.** `ImportCommitInput` already *is*
  a `CommitInput`, and `const commitInput: CommitInput = input` in `durablePort` is that
  claim stated where the compiler checks it — no re-encoding, no spread-with-defaults that
  could let the store's generic `DOMAIN_EVENT_SCHEMA_VERSION` displace the draft's, no added
  event. `legacy-import-commit.test.ts` asserts the durable ids are exactly the drafted ids.
- **A store refusal is recorded, rethrown, and answered from the record.** `applyImport`
  wraps every *thrown* commit failure as `IMPORT_COMMIT_FAILED` / `APPLY`, which would erase
  "the store refused this command" versus "the store broke". So `CONFLICT_CODES`
  (`COMMAND_ID_CONFLICT`, `EXPECTED_VERSION_CONFLICT`) are captured verbatim into
  `CommitRecord.refusal`, rethrown, and consulted *before* `applyImport`'s own result. A
  closed handle still comes back `IMPORT_COMMIT_FAILED` / `APPLY`.
- **`outcome` is the store's disposition, verbatim.** `COMMITTED | REPLAYED` — a
  byte-identical re-import replays and appends nothing; the same manifest digest with
  different facts is `REFUSED` / `COMMAND_ID_CONFLICT` at layer `STORE`, because
  `applyImport` always commits at a fixed `expectedVersion: 0` with a manifest-derived
  command id.
- **`import-commit` creates no store.** `existsSync` is the first thing after argv, then
  `SqliteEventStore.openForProject(path, project)` — plain `open` asserts no project scope
  and the store then refuses every durable effect. `store.close()` runs in a `finally`.
- **`import-shadow` proves read-only on bytes, not in prose.** `observeSources` records
  digest **and** `mtimeMs` **and** `size` for every manifest entry before the run and again
  after; `driftBetween` names each file that moved and the run refuses
  `IMPORT_SOURCE_DIGEST_MISMATCH` / `MANIFEST`. A write that restores identical content
  still moves mtime, so it is caught. Its `DISCARDING_STORE` port keeps no state and returns
  `{ currentVersion: 0 }`, so the comparator never sees an authority-bearing store.
- **The shadow is bound to the durable run.** Both CLIs pass the store's own
  `MAX_EVENTS_PER_COMMIT` (currently `256`) as `maxEventsPerCommit`; anything looser would
  let the advisory run certify a snapshot the real importer refuses with
  `IMPORT_TOO_LARGE_FOR_ONE_COMMIT`. Both also hard-code the same
  `KNOWN_FIELDS = ["dependsOn", "held", "owner", "parent"]`.
- **`import-shadow` derives through production, never restates it.** `applyShadowImport`
  composes `applyImport` for claims and links rather than re-deriving them locally — a
  second copy is how a shadow report starts disagreeing with the importer it shadows.
- **`parseCurrent` refusal vocabulary.** Version is checked **first** and against the file's
  own word: a foreign or absent `version` is `IMPORT_SOURCE_UNSUPPORTED` (a real shape this
  comparator declines), not `IMPORT_SOURCE_MALFORMED` (bytes that fail to be what they
  claim). Two rows for one `(kind, id)` whose `canonicalJson` differs is
  `IMPORT_SOURCE_AMBIGUOUS`; byte-identical duplicates collapse. `seen` is a
  `Map<kind, Map<id, canonical>>`, never a joined `kind:id` key, mirroring `index()` in
  `shadow-projection.ts`. Fields are built with `Object.fromEntries`, not `text[key] =`, so
  a `__proto__` field cannot vanish silently through the inherited setter.
- **Process shape is uniform.** Exit `2` for an argv refusal, `1` for everything else, `0`
  on success; success to stdout, refusals to stderr. Every refusal prints
  `{ code, detail, layer, outcome: "REFUSED" }`. Both files end with the same self-invocation
  guard, `import.meta.url === pathToFileURL(argv[1]).href`, so importing them from a test
  does not run the CLI.

## Gotchas

- **`pnpm typecheck:import` is the only thing that typechecks this folder.** It names all
  four `.ts` files explicitly on one `tsc` line (that is also why the deep relative imports
  do not trip TS6059). `pnpm --recursive typecheck` reaches workspace packages and `tools/`
  is in none — a new file added here is checked by *nothing* until it is added to that
  script.
- **The script strings are pinned by hand.** `tests/security/lane-smoke.security.ts` pins the
  whole `test:integration` script byte-for-byte as `INTEGRATION_SCRIPT` because it is the
  only invocation of `typecheck:import`, and pins the root vitest `include` as an exact
  4-element list (`tools/**/*.test.ts` is the fourth root, added for this folder). Editing
  either reds `pnpm test:security`.
- **`.js` bridges are needed for intra-`tools/` imports only.** `durable-import-store.js` and
  `shadow-input.js` exist because a runtime file imports them; the two CLI entry points have
  none and need none. `tsc` resolves `.js` → `.ts` and so does vitest, so a missing bridge is
  invisible to `pnpm typecheck:import` and to every suite — only actually running
  `node --experimental-strip-types tools/import/<entry>.ts` finds it
  (`ERR_MODULE_NOT_FOUND`). See Serena `gotcha-tools-dir-needs-js-bridges-too`.
- **`tests/integration/import/tsconfig.json` names `../../../tools/import/import-commit.ts`
  in its `include`** — a second tsconfig that will red if that path moves.
- **Two test harnesses hand-copy `const MAX_EVENTS_PER_COMMIT = 512`**
  (`tests/integration/portability/shadow-corpus-harness.ts`,
  `tests/security/import-shadow-boundary-scenarios.ts`) — twice the store's real `256`. Do
  not copy that number back into a tool; the CLIs must keep importing the constant.
- **`packages/import/src/legacy-shadow.test.ts` pins the CLI's whole report**: exact counts
  (`records: 6`, `decodeRefusals: 3`, `reconciliations: 4`, `mismatches: 10`,
  `shadowRefusals: 0`, `sourceFiles: 9`, `verifiedFiles: 9`), `CORPUS_MANIFEST_DIGEST` and
  `sourceIntegrity`. Any new key in `runImportShadow`'s success JSON, or one corpus byte,
  reds it — re-measure rather than widen.
- `import-shadow.test.ts` derives its fixture sizes from `MAX_EVENTS_PER_COMMIT`, so the
  over-cap arm writes 257 files into `tmpdir()` per run and a store cap change moves the
  suite with it. Every temp root is registered in `roots` and removed in `afterEach`.
- The 250-line source rail is why `shadow-input.ts` was split out of `import-shadow.ts`
  (now 242 lines); the split is the rail, not a seam — `shadow-input.ts` is reached through
  one specifier.

## Testing

- One file / whole folder are the same command: `import-shadow.test.ts` is the only test
  file here. `pnpm vitest run tools/import/import-shadow.test.ts` (root config,
  `environment: "node"`, `include` carries `tools/**/*.test.ts`), and `pnpm test` runs it.
- Types: `pnpm typecheck:import`. `pnpm typecheck` does **not** cover this folder.
- Outside coverage: `pnpm test:integration` (runs `typecheck:import` first, then
  `tests/integration/import/legacy-import-commit.test.ts` for `commitLegacyImport` and
  `runImportCommit` against a real file-backed store, and
  `tests/integration/portability/projection-shadow-matrix.test.ts` whose current side is
  populated only through `commitLegacyImport`); `pnpm test:security`
  (`import-shadow-boundary-scenarios.ts` seeds `SEEDED_IMPORT_ROWS = 2` through the same
  writer, `durable-store-boundaries.security.ts` reads them back);
  `pnpm vitest run packages/import/src/legacy-shadow.test.ts` for the spawned-CLI arm.
- CI: `.github/workflows/cross-host.yml` has a dedicated Windows **Typecheck (import)** step,
  because the `portability-evidence` job that otherwise runs it is ubuntu/macOS only.
