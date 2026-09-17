# tools/packaging

`pnpm pack:windows` lives here: the pipeline that turns one **tracked Git commit** into
`dist/moe-windows.zip`, plus the distribution-manifest signer the release scripts use. Its job
is adversarial — the operator's checkout is never the subject. Everything shipped is
re-materialized from Git objects, hashed against them, and built by executables resolved from
fixed OS paths and pinned digests, never from `PATH`. Nothing in `apps/**` or `packages/**`
imports this folder; only `tests/**`, `scripts/release/**` and CI do.

## Seams

- `pack-windows-main.ts` — the `pnpm pack:windows` entrypoint (`packWindowsFromRepository`).
  Also exports `WINDOWS_PACK_REPOSITORY_ROOT`, `packWindowsFromCommit`, `packChildEnvironment`,
  `assertPackRuntimeMatchesCommit`, `resolvePackExecutable`. CI runs it through
  `authenticate-node.ps1 -Entry tools/packaging/pack-windows-main.ts`, pinned by
  `tests/integration/release/release-workflow-contract.test.ts`.
- `pack-windows-materialized-main.ts` — the second process, spawned *inside* the materialized
  tree. Builds the Rust broker, then calls `packWindows`. Exports `stageArtifactBroker`,
  `verifyArtifactBroker`, `PACKAGED_BROKER_ARTIFACT_PATH`.
- `pack-source.ts` — `withMaterializedPackSource(request, consume, dependencies)`, the
  callback-scoped source boundary; `pack-inventory.ts` — `inspectStagedTree`, `isTestArtifact`,
  `REQUIRED_STAGED_PATHS`; `pack-imports.ts` — `collectImportFaults`; `pack-staging.ts` —
  `walkFiles`, `findWorkspacePackages`, `pruneTestArtifacts`. All four are imported directly by
  `tests/integration/distribution/{pack-inventory,pack-artifact-sweep,
  pack-import-faults}.test.ts`.
- `distribution-build.ts` / `distribution-inventory.ts` / `distribution-startup.ts` — a separate
  concern that only lives here: the signed component manifest. Callers are
  `scripts/release/release-subject.mjs` and
  `tests/integration/distribution/distribution-packaging.test.ts`. These are the only modules
  here that import `packages/contracts` and `packages/skills`.
- `pack-tool-identity.ts` (`capturePackFileIdentity`, `normalizedTreeSha256`, `pathInside`),
  `pack-pnpm-package-identity.ts` and `toolchain-pins.ts` are re-used by
  `scripts/release/pnpm-runner.mjs` and `tests/integration/release-supply-chain.test.mjs`, which
  import them as **`.ts`**, not through the `.js` bridges.
- `smoke-windows-artifact.ps1` imports nothing from the repo; its only input is the zip.

## The model

- **Three processes, narrowing trust.** `packWindowsFromRepository` (operator's checkout) →
  `assertPackRuntimeMatchesCommit` → `withMaterializedPackSource` extracts `git archive` of
  `HEAD` into an OS-temp tree → `pack-windows-materialized-main.ts` runs *from that tree* under
  `runWindowsLeasedProcess`, writing into a private candidate dir →
  `publishPrivateWindowsCandidate` renames it to `dist/`. The packer never writes into the
  repository.
- **Five refusal layers, each with its own code list**: `PACKAGING_SOURCE`
  (`PACK_SOURCE_ERROR_CODES`, 16 codes, `PackSourceError`), `PACKAGING_INVENTORY`
  (`PackRefusalCode`, 8 codes), `PACKAGING_OUTPUT` (`PACK_OUTPUT_CODES`, 5),
  `PACKAGING_TOOLCHAIN` (`PackCargoToolError`) and `PACKAGING_BROKER` (`PackBrokerError`,
  whose `reason` — not `code` — distinguishes `BROKER_SOURCE_UNUSABLE` from
  `BROKER_DIGEST_MISMATCH`). `PackSourceError` messages are deliberately non-diagnostic:
  repository contents may be secret.
- **Git is membership authority.** `parseRoster` reads `ls-tree --long`; the extracted walk
  (`materializedPaths`) is compared to it, then `verifyMaterializedContents` re-derives each blob
  SHA (`sha1` or `sha256`, chosen by `sourceSha.length === 64`). A `120000` mode entry is
  `PACK_SOURCE_SYMLINK_UNSAFE` outright. `.moe/` is excluded by `PACK_SOURCE_ARCHIVE_PATHSPEC`.
  Contents are verified again *after* the consumer returns.
- **Secrets are refused by path, and separately by bytes.** `isSensitivePackSourcePath` is
  path-only so a refusal cannot echo the secret; `createSensitivePackSourceByteScanner` runs
  during the same read that hashes each blob. `EXACT_SECRET_STEMS` matches whole stems, never
  substrings, because `tokenizer.ts` and `credential-codec.ts` are ordinary source. Leading dots
  are stripped *all* of them before classification.
- **The inventory gate and the prune share one predicate** (`isTestArtifact`), by design — two
  predicates would let them drift. `TEST_SEGMENTS` matches directory segments only; vendored
  `node_modules` bytes are exempt. `TEST_SUPPORT_STEMS` names 11 test-only modules whose filename
  gives nothing away, and cannot go stale in either direction: an entry wrongly missing surfaces
  as a `PACK_DANGLING_IMPORT` from `collectImportFaults`, which parses every shipped source with
  `@babel/parser` and proves the pruned tree still resolves.
- **The artifact is not a `pnpm deploy` tree.** Node 24 refuses `.ts` under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so `reshapeDeploy` moves `@moe/*` out to
  `apps/daemon` and `packages/*`, records the mapping in `moe-workspace-links.json`, and
  `moe start` junctions them back.
- **Toolchain identity is pinned, not discovered.** `toolchain-pins.json` (Node + pnpm digests)
  and `cargo-toolchain-pins.json` (rustup toolchain `1.96.0-…`, cargo version line and SHA-256)
  are read at **module load** of `pack-command.ts` — importing it anywhere throws
  `PACK_STEP_FAILED: toolchain pins invalid` if either file is malformed. pnpm is resolved only
  from `npm_execpath` or `PNPM_HOME` (`resolvePnpmHandoff`), cargo only from
  `RUSTUP_HOME`/`USERPROFILE\.rustup`, git/tar/node/powershell only from `C:\Program Files` and
  `C:\Windows\System32`. The child env is an allowlist of 10 variables plus a `PATH` rebuilt from
  the resolved tool directories.

## Gotchas

- **`pnpm typecheck` does not cover this folder.** `tools/**` is in no workspace package (see
  `pnpm-workspace.yaml`), so the recursive typecheck never reaches it. Only
  `pnpm typecheck:packaging` does, and its file list in the root `package.json` is
  hand-written — a new root module that nothing in that list imports is typechecked by nobody.
- **`.js` bridges are load-bearing here because Node really executes these modules.**
  `pack-windows.js` etc. are one-line `export * from "./x.ts";`. Five `.ts` files have no bridge
  on purpose — `pack-windows-main.ts`, the three `distribution-*.ts` (imported as `.ts` by
  `.mjs` release scripts) and `pack-source-test-fixtures.ts`.
- **A version literal in a *comment* here is pinned.**
  `tests/integration/release/release-version-surfaces.test.ts` pins `pack-docs.ts`
  (the exclusions comment naming what the release genuinely omits), `smoke-windows-artifact.ps1`, and the historical
  the `shipping … once carried 25…` sentence in `pack-inventory.ts` with
  `expectedCurrentCaptureCount: 1`. Rewording that prose reds the release lane.
- **`PACK_SOURCE_PACKER_DRIFT` fires on your own working tree.** `assertPackRuntimeMatchesCommit`
  diffs `package.json` and `tools/packaging` against `HEAD` and also refuses *untracked* files
  and any non-`H` `ls-files -v` flag. An uncommitted edit here — or a stray scratch file —
  means `pnpm pack:windows` refuses before doing anything.
- **Most of the interesting tests are `runIf(process.platform === "win32")`.** On any other host
  the publication, lease, candidate and sentinel arms silently do nothing. `pack-source.test.ts`
  inverts this: its mode-bit arms are `skipIf(win32)`.
- **`pack-windows.test.ts` and `pack-windows-process-lease.test.ts` are the repo's known 5 s
  timeout flakes** under the full root suite (child-process contention); re-run the file alone
  before attributing a red.
- `pack-cargo-tool` needs the pinned rustup toolchain installed and defaulted — CI does this
  explicitly because the rustup proxy reads `rust-toolchain.toml` from the cwd, not from
  `--manifest-path`.
- `DISTRIBUTION_INVENTORY` is hand-written and frozen, and **order is part of the subject**;
  never regenerate it from a directory walk (the walk it replaced shipped two test-fixture
  files).

## Testing

- One file, from the repo root: `pnpm vitest run tools/packaging/pack-inventory.test.ts` — the
  root `vitest.config.ts` include carries `tools/**/*.test.ts`, so `pnpm test` runs this folder.
- Whole folder: `pnpm vitest run tools/packaging`.
- Typecheck: `pnpm typecheck:packaging` (also runs first inside `pnpm test:integration`).
- Outside coverage: `tests/integration/distribution/{pack-inventory,pack-artifact-sweep,
  pack-import-faults,distribution-packaging}.test.ts`,
  `tests/integration/release/{release-version-surfaces,release-workflow-contract}.test.ts`, and
  the `node --test` arms `tests/integration/release-supply-chain.test.mjs` and
  `tests/integration/release/verify-windows-release.test.mjs` (all under
  `pnpm test:integration`).
- The real end-to-end proof is CI only: `reusable-windows-candidate-build.yml` runs
  `authenticate-node.ps1 -Entry tools/packaging/pack-windows-main.ts` then
  `smoke-windows-artifact.ps1 -Zip dist/moe-windows.zip`.
