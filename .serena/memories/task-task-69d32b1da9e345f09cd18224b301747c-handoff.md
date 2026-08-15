# task-69d32b1da9e345f09cd18224b301747c — Legacy snapshot decoder and shadow projection contract

Landed in commit **65f3375** (24 files, explicit pathspec, nothing foreign swept in).

## What exists now

- `packages/import/src/legacy-decoder.ts` (249) — `decodeLegacySources({manifest, root})`.
  Read set is `manifest.entries` ONLY; each entry is re-hashed against its digest
  BEFORE parsing. `payload = document MINUS the envelope keys {id, legacyId, time}`;
  `kind` comes from the directory family (`tasks/`->task, `skills/`->skill), which
  selects WHICH decoder applies the way an extension selects a parser. Nothing else
  is path-derived. Refusals, all at layer `DECODE`: `IMPORT_SOURCE_MALFORMED`,
  `_UNSUPPORTED`, `_AMBIGUOUS` (legacyId vs the older `id` dialect disagree),
  `_DIGEST_MISMATCH`, `_UNREADABLE` (also covers a manifest entry whose path escapes
  the tree).
- `packages/import/src/shadow-contract.ts` (111) — frozen vocabulary: kinds
  `[BLOCKER, CLAIM, LINK]`, per-kind field lists, mismatch kinds, and a frozen
  kind->disposition map whose only arms are `NEEDS_RECONCILIATION` and `UNKNOWN`.
- `packages/import/src/shadow-projection.ts` (246) — `projectLegacyImport` and
  `compareShadowProjections`. Pure; compares PLAIN DATA both sides supply and does
  NOT import the daemon's BoardProjection (that would invert the dependency graph —
  see the task's planningNotes; @moe/import still declares zero dependencies).
- `tools/import/import-shadow.ts` (237) + `shadow-input.ts` (99) — read-only CLI,
  typechecked by the new root script `typecheck:import`.
- `packages/import/corpus/legacy-project/**` — 9 committed legacy files. Manifest
  digest `d1ab82e6115ed2432cc1efa351ee2c2a29be69471fa8d234c1ddc08a3020eff0`;
  decode = 6 records + 3 refusals; reconcile = 4 findings; CLI vs an empty current
  side = 10 mismatches.

Consumer edge for the global rail: the CLI is a landed durable call site, and the
named consumer tasks are **task-22cfca91c5134b24aaf3e5734444fb93** and
**task-4e1fe69630da494eb313e27a4543c5c8**.

## Named follow-up, deliberately NOT done here (outside owned paths)

`tests/migration/import/import-determinism.test.ts:65-73` still builds records from
manifest paths and hand-writes `payload: { owner: "alice" }` while its own fixture
bytes at line 40 already say `"owner":"alice"`. That invented-payload defect is what
motivated this task. The fix is now available: rewrite `recordsFor()` to call
`decodeLegacySources` — the fixture BYTES already decode correctly, only the record
construction needs replacing. Whoever owns that path should take it.

## Things that will bite the next person

- Two hazards found by adversarial review, both real and both drilled:
  `mem:gotcha-proto-key-silently-drops-and-repoisons-a-payload` and
  `mem:gotcha-tools-dir-needs-js-bridges-too`.
- The comparator's mismatch order is total over (entityKind, entityId, field,
  mismatchKind) and that totality is LOAD-BEARING: a held claim yields a CLAIM and a
  BLOCKER sharing one id. Mismatches are emitted in caller order and sorted after, so
  an id-only sort genuinely reddens instead of being an equivalent mutant under V8's
  stable sort.
- `SHADOW_PROJECTION_VERSION` is the drift signal against the real BoardProjection.
  If a consumer wires the two together, mismatched vocabulary must surface as a
  version disagreement, not a silent field rename.
- Corpus digests are pinned by hand in `legacy-shadow.test.ts`. `.gitattributes` is
  `* text=auto eol=lf`; the gate asserts no corpus file contains byte 0x0D so a
  mangled checkout names itself rather than failing on an opaque digest.

## Verification at the committed bytes

`pnpm --filter @moe/import typecheck` 0 · `pnpm --filter @moe/import test` 7 files /
87 tests · `pnpm typecheck:import` 0 · `vitest run tests/migration/import` 7 tests.
Repo-wide `pnpm typecheck` exit 0. Root `pnpm test` has ONE foreign red —
`tests/integration/control-room/control-room-transport.test.ts`, a DAEMON_WALL_CLOCK
seamObservation compared against a reading 8 ms later (owning commit 4c39f3a,
task-1430dfae). Reproducible across isolated re-runs; zero references to
`@moe/import` in that module graph.
