# QA verdict: clean workspace foundation (@moe/runner) — APPROVED

Reviewer qa-91cf5a2f. Commit `99f5898 feat(runner): clean workspace foundation`, 18 files, 3587 insertions(+), 0 deletions.

## Gates re-run by QA (not trusted from worker summary)
- `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` -> exit 0, 3 files / 106 tests passed.
- Repo gate `pnpm typecheck && pnpm test` -> all 5 packages typecheck Done; 71 files / 892 passed / 1 skipped (skip is foreign, pre-existing).
- Determinism grep over production sources for `Date.now|new Date|Math.random|process.env` -> zero hits.
  (`process.platform` IS present at scope-observation.ts:39 — case-fold for win32 containment. Legitimate
  filesystem-semantics branch, not a digest-input nondeterminism. Do not "fix" it.)
- Per-file rail: max production module 272 lines (workspace-manifest.ts); all 12 under the 400 hard cap.

## DoD mapping (each item has a named test, exact-code assertions, zero toBeTruthy/toBeDefined in the suite)
1. Fail-closed candidates: 17-case hostile-path matrix in scope-observation.test.ts:79-96 (absolute/UNC/drive/colon/
   backslash/dot-segment/reserved device/trailing dot-space/non-NFC/lone surrogate/length), junction-escape,
   submodule boundary; workspace-manifest.test.ts:318-380 covers ESCAPED, SYMLINKED, KIND_UNSUPPORTED, DIRTY,
   STAGED, UNTRACKED, ATTRIBUTION_UNKNOWN, UNDECLARED, FOREIGN (both directions), INHERITED_PRODUCER_MISMATCH.
   56 distinct RUNNER_* codes exercised.
2. Digest binding: result body embeds inputManifest.sha256 + scopeObservation.sha256 + baseIdentity + sorted
   authoredPaths + inherited/authored split; both upstream digests RECOMPUTED before use. Reproducibility tests
   across declaration orders and repeated runs, plus "changes the digest when any bound fact changes".
   Cross-module seam is real: workspace-manifest.test.ts imports and calls the actual `observeScope`, so
   `canonicalDigest(unsealed)` and `scopeObservationDigestInput` cannot silently drift apart.
3. Staging: write -> fsync -> close -> exists-check -> (reuse-existing | rename -> persistAfterRename -> re-read
   verify). Fault injection parameterized over all 5 boundaries; poisoned address unlinked before the failure
   returns; deletion needs `ZERO_REFERENCES` with a NON-EMPTY scannedGenerations list.
4. Focused gate exit 0, re-run above.

## Rail check
Commit touches only `packages/runner/**` + the 6-line `packages/runner:` importer in pnpm-lock.yaml. Every
importer in the committed lockfile resolves to a package.json tracked in that same commit (ordering rule held).
No scratch/debug files. Working tree clean for the owned subtree.

## Size tension — recorded deliberately, not overlooked
3587 net inserted LOC (2153 production / 1403 test / 31 config) far exceeds the QA >400-net-LOC
reject-as-oversized heuristic. Approved anyway because: the per-file epic rail (<=250 target, <400 hard) is met
by every module; the three-area scope was fixed upstream by the governor's task decomposition, so "split it" is
not an action the worker can take; and the same epic already merged comparable greenfield packages
(16334bd 2327+, f4cdba6 1412+, 0a305cd 1047+). FOR THE GOVERNOR/ARCHITECT, not the worker: greenfield package
tasks in this epic routinely land 1000-3500 LOC. If that heuristic is meant to bind, decompose at task-creation
time — rejecting at REVIEW produces churn with no defect to fix.
