# task-9449ce65 — Release supply-chain gate — QA APPROVED (DONE)

qa-5be1a8d6, 2026-08-09. Evidence comment `comment-df21d02ebcc94259b30b83b3fe4707c4`.

## What I actually ran (not trusted from the worker)

`pnpm verify:release` foreground, EXIT 0, at HEAD **0ff900a5** — five commits
PAST the worker's frozen 6daa942, so it is an independent reproduction, not a
replay. Legs: typecheck:release 0, typecheck:packaging 0, vitest
tests/integration 40, `node --test` release suite 41/41 (includes the REAL
`pnpm release:evidence` end-to-end, 17.9s), release:evidence 0.

Owned-path bytes were identical at HEAD and in the worktree, which is why the
gate reproduced despite HEAD moving.

## Evidence record facts (dist/release/<sha>/<digest>/evidence.json, gitignored)

Two independent `git archive` + fresh `pnpm install --frozen-lockfile` trees
produce byte-identical container/manifest/asset digests for all 5 components.
lockBefore==lockAfter, packageBefore==packageAfter. `sbomRawDigest` DIFFERS per
build while `sbomNormalizedDigest` matches — non-reproducible bytes disclosed,
not absorbed. sbom 383 components / audit 95 deps 0 advisories / licenses 4
groups 94 packages, each digest-bound. win32 PASS only; linux+darwin UNKNOWN
with deferred ids; doctor UNKNOWN; releaseVerdict UNKNOWN;
publicationAuthorized false; no private-key bytes.

## My own mutation drill — 5/5 KILLED

Byte-exact anchor replace on `scripts/release/supply-chain.mjs`, abort when the
anchor count != 1, `node --check` gate so a syntax error cannot fake a kill,
targeted `node --test --test-name-pattern <name>` (this is the trick that keeps
the drill cheap — it filters out the 900s real-script test), restore, hash
compare vs `git rev-parse HEAD:<path>`.

Killed: dropped cdxgen pin from the toolchain check; deleted the darwin UNKNOWN
row; publicationAuthorized false->true; doctor UNKNOWN->PASS; neutered
`observed.sourceSha !== source.sourceSha`.

## Non-blocking notes left for the next toucher

1. `release-subject.mjs:22 RELEASE_REFUSAL_REASONS` omits `SOURCE_ARCHIVE_FAILED`,
   which `supply-chain.mjs:61,63,205` emits — and nothing imports or asserts the
   list. See `mem:gotcha-exported-reason-vocabulary-detaches-unnoticed`.
2. `supply-chain.mjs:237` one blanket catch maps ANY body exception to
   `EVIDENCE_WRITE_INTERRUPTED` — fails closed but mislabels the cause.
3. `supply-chain.mjs:205` `"code" in archived` throws if an injected
   archiveSource returns undefined.
4. Test 498-510 assert implementation source TEXT, justified only because
   injected ports cannot see real child-process details.

## Shared-tree attribution

No commit bears this task id for package.json / pnpm-lock.yaml /
release-subject.mjs — foreign sweeps `3ec53d7` and `71af97c` captured them
first (3ec53d7 is what actually landed the cdxgen devDependency). Per the
shared-tree rail that is NOT a rejection reason; verify by base-ref diff over
owned paths plus worktree-vs-HEAD blob equality.
