# Handoff: task-a4593fb7 Deterministic legacy importer (@moe/import)

Delivered 2026-08-09 by worker-f2e587cb. New greenfield package `packages/import` (8
production modules + 8 `.js` bridges + 4 unit suites) and `tests/migration/import`.

## Verification

`pnpm --filter @moe/import typecheck` exit 0; `packages/import/src` + `tests/migration`
= 5 files / 55 tests, exit 0. Plain-Node probe: 20 exports, none undefined.

**The named gate `pnpm test:migration` WAS NEVER CREATED** — the ownership amendment for
root package.json was requested at step 2 and never answered, so I did not self-approve
it. Root package.json is untouched. The equivalent `npx vitest run tests/migration`
(1 file / 7 tests) is what the script would expand to. Either add
`"test:migration": "vitest run tests/migration"` or amend the task's Verification.

Root `pnpm typecheck` is red on FOREIGN apps/daemon review-surface files; zero errors in
`packages/import` or `tests/migration`.

## The finding worth keeping

**On NTFS the directory sort is a no-op for an all-lowercase fixture.** Neutering
`byCodeUnit` to a constant left the migration two-run determinism test GREEN, and adding
an explicit expected-order assertion did not change that — verified with the mutant live.
Only a MIXED-CASE fixture separates NTFS's case-insensitive listing from code-unit order
(`B` 0x42 before `a` 0x61). That test lives in `source-manifest.test.ts`. A reviewer
reading only the migration suite would over-trust it. See
`mem:gotcha-windows-readdir-masks-a-missing-sort`.

## Load-bearing decisions

1. **`canonical-bytes.ts` duplicates `packages/runner/src/canonical.ts` deliberately** —
   the runner's root exports none of those helpers and its `exports` map is exclusive, so
   no specifier reaches them. `isPlainRecord` here is STRICTER (requires a plain
   prototype): the runner's accepts a `Uint8Array`, which then digests as
   `{"0":1,"1":2}`. My own test caught that mid-step.
2. **`ImportStorePort` is structural, not an `@moe/store` import** — keeps the package
   dependency-free for the loadability gate, while `tests/` (the one place allowed to
   import production packages by relative path) wires the REAL `SqliteEventStore` in.
3. **One commit or refuse.** Exceeding the per-commit bound returns
   `IMPORT_TOO_LARGE_FOR_ONE_COMMIT`/APPLY with zero commits attempted; splitting would
   trade atomicity for capacity.
4. **Twelve ambiguity classes, not seven.** Design §21.6 gives 7; the human roadmap
   amendment on this task adds 5 skill-asset classes. Kept as two frozen lists so neither
   absorbs the other's coverage.
5. **§21.4/§21.5 enforced by TYPES**: `ImportedClaimStatus` has no ACTIVE arm;
   `LegacyLink.evidenceOnly` is the literal `true`.
6. `IMPORT_SOURCE_MUTATED` was REMOVED — no emitter. Read-only is proven by measuring
   mtime/size, not by a runtime refusal.

## Drill

6/6 mutants killed (comparator, id derivation, provenance time, case-fold, suspended
status, per-commit bound). Restoration verified with a sha256 manifest, not `git status`
— files here are a mix of tracked and untracked in the shared worktree.

## Commit

`e57086a` holds only the two files I touched after the last foreign sweep. A completion
hook swept the rest of `packages/import`, `tests/migration` and `pnpm-lock.yaml` into
earlier foreign commits. Review the whole deliverable with a base-ref diff, not that sha.
