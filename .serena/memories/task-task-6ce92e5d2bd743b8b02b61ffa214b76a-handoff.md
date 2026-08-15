# Handoff: clean workspace foundation (DONE, commit 99f5898)

@moe/runner shipped: artifacts/, scope/, workspace/. 106 tests, focused typecheck+test exit 0,
repo gate 71 files / 892 passed / 1 skipped (skip is foreign). Commit `feat(runner): clean workspace
foundation`, 18 files by explicit pathspec, pnpm-lock.yaml included (all importers resolved).

## Public surface (packages/runner/src/index.ts)
- `createArtifactStore({root, fs, nextStagingCounter})`, `createNodeArtifactFs()`, `refMatches`, `refRejection`
- `observeScope(input)`, `createNodeGitObserver`, `createNodeScopePaths`, `hermeticGitEnvironment`, `canonicalPathRejection`
- `buildInputManifest`, `buildResultManifest`, `inputManifestDigestInput`, `resultManifestDigestInput`
- shared: `src/canonical.ts` (canonicalJson/canonicalDigest/deepFreeze/isNormalizedText/isCanonicalUtcTimestamp) — NOT exported from index, import by path.

## Invariants a consumer must respect
- Artifact ref is returned ONLY after write -> fsync -> close -> rename -> persistAfterRename -> re-read verify.
  Never rename onto an occupied address (exists-check dominates the single rename call). Post-rename verify
  failure unlinks the address (poisoned-address hazard). Deletion needs `{state:"ZERO_REFERENCES", scannedGenerations:[...]}`
  with a NON-EMPTY generation list; UNCERTAIN/empty -> RUNNER_ARTIFACT_REFS_UNCERTAIN, bytes kept.
- `observeScope` is caller-timestamped (`observedAt` canonical ISO-8601 UTC, format-validated). Freshness is the
  CONSUMER's re-observation duty (design 810) — re-observe before provider start, candidate verification, integration.
- Attribution admissible for result bytes: CLEAN or ABSENT only. DIRTY/STAGED/UNTRACKED/UNKNOWN/UNMERGED/IGNORED all reject.
- Input-manifest `producer` is mandatory and typed: `{kind:"BASE"}` | `{kind:"PREDECESSOR", attemptRef, epoch, adoptionRef?}`.
  A digest is one-way; producer identity can never be recovered later, so it must be supplied at input-manifest build time.
- Result manifest digest embeds inputManifest.sha256 + scopeObservation.sha256 + baseIdentity + sorted authoredPaths +
  inherited/authored split + sorted artifact refs. Both upstream digests are RECOMPUTED before use (tamper -> INVALID code).
- FOREIGN vs UNDECLARED: UNDECLARED = path declared nowhere (not authored, not in input closure). FOREIGN = path IS
  declared but the bytes have no producer in the claimed direction (INHERITED with no input entry, or AUTHORED with no
  authored declaration). INHERITED_PRODUCER_MISMATCH = input entry exists but bytes/length drifted.

## Explicit deferrals (named in workspace-contract.ts comment, vs design 219)
Authored commit, canonical authored delta, receipts, decisions, journal references -> later result-sealing task.
`ResultTreeEntry.kind` is OBSERVED BY THE CALLER (scanner), not stat'ed here — this module does zero IO.

## Follow-on work
Result sealing must add the deferred fields, and whoever writes the scanner must supply `kind` honestly
(SYMLINK/DIRECTORY/OTHER all reject) since the workspace module cannot verify it.
