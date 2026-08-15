# Slice 2 recovery-inventory adapters (provider/lock + workspace) — handoff

Landed 2026-08-09 by worker-901cc711. Six files, all under
`packages/runner/src/recovery-inventory/`:
`provider-lock-inventory.{ts,js,test.ts}` (248 / 1 / 405 lines) and
`workspace-inventory.{ts,js,test.ts}` (250 / 1 / 475 lines).
Gate: `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test`
-> exit 0, 45 files / 1403 tests (baseline was 43 / 1366).

## The two shape decisions the next agent must not undo

**Registration is a FACTORY, not a constant, and the aggregate is never edited.**
`createRecoveryInventoryRegistry` (recovery-inventory.ts:53) takes an immutable
caller-supplied tuple and its doc comment explicitly refuses a module-global
registry. So each module exports
`providerLockInventoryRegistration(input) => RecoveryInventoryRegistration` and
`workspaceInventoryRegistration(input) => ...`, each returning a frozen
`{ class, enumerate }`. The task description's "two-line registration edit in the
slice-1 aggregate" is wrong and the architect ruled it out; slice 3 should land
the same way. Diff over `recovery-inventory.ts`, `index.ts` and
`index-surface.test.ts` is empty, and both new modules are deliberately OFF the
`@moe/runner` root seam (as is `supervisor/launch-lock.ts`).

**Who is a row and who is an authority.** A provider is NOT a recoverable row.
The probes are the capability authority: `PROCESS_TREE_TERMINATION` gates "can
this population be enumerated at all" (UNSUPPORTED -> CAPABILITY_UNSUPPORTED) and
`RUN_ENUMERATION_NEGATIVE_PROOF` on *both* providers mints the
`negativeProofDigest`. Rows are launch locks and process observations only.
Emitting a provider row would make the class permanently non-empty and silently
retire the negative-proof requirement the empty case exists to enforce.

## The precedence order that dictates every reason code

`collectClass` (recovery-inventory.ts:211-245) answers in this order:
unregistered -> throw (ENUMERATOR_FAILED) -> unreadable (RESULT_MALFORMED) ->
UNAVAILABLE -> UNSUPPORTED -> `items.length > 4096` (RESULT_OVER_LIMIT) ->
`!complete` (RESULT_TRUNCATED) -> per-item admission -> only then
"empty AND digest null" (NEGATIVE_PROOF_MISSING).

Two consequences worth reusing verbatim in slice 3:
- NEGATIVE_PROOF_MISSING is reachable ONLY with `complete: true` and zero items.
  So "I could not prove I saw everything" must be `complete: false`, and "I saw
  nothing and cannot prove nothing exists" must be `complete: true` + null digest.
  Collapsing the two makes one of the reasons unreachable.
- `readPortResult` reads items through `readList(value, MAX + 1)`
  (shape:213), so a population above **4097** reads as RESULT_MALFORMED, not
  RESULT_OVER_LIMIT. Drive the OVER_LIMIT case with exactly 4097 items.

## Measured facts that cost time to discover

- `capabilityStatus` is exported by BOTH `claude-probe.ts` and `codex-probe.ts`
  over different profile types. Unaliased imports do not compile; alias them.
- `identityKey` (shape:121) does NOT normalize — `readIdentity` (shape:106) does.
  `admitItems` composes readIdentity THEN identityKey. A test that calls
  identityKey on a raw identity goes red for the wrong reason.
- `canonicalPathRejection` (scope-contract.ts:229) REJECTS backslashes inside
  workspace paths, so a separator-collision case must be driven through the
  workspace *ref* prefix, not through a manifest entry path.
- `canonicalDigest` is not on the runner root seam; import it relatively.
  `SCOPE_OBSERVATION_VERSION`, `scopeObservationDigestInput`, `ScopeObservation`
  and `ArtifactRef` all ARE on the seam.
- A `ScopeObservation` is cheap to build in a test: fill the body and seal with
  `canonicalDigest(scopeObservationDigestInput(body))` — that is the production
  binder both the producer and `buildResultManifest` recompute from.

## Workspace enumerator behaviour, for the daemon coordinator

Port is `{ list: () => { workspaces, listingComplete } }`; each source is
`{ workspaceRef, baseIdentity, rootPath, producer, result }`. The enumerator does
the real filesystem walk itself (`readdir` recursive + `readFile` + `sha256Hex`)
and seals through `buildInputManifest`; a source carrying a `result` aspect also
gets a `buildResultManifest` row. Item identities are
`PATH ${workspaceRef}/${entryPath}` and `OPAQUE workspace-result:${workspaceRef}`.
Colliding refs are deliberately NOT merged — both rows are emitted so the
aggregate can refuse with RECOVERY_INVENTORY_EXTERNAL_IDENTITY_DUPLICATE.

Fail-closed map: lister throws OR either manifest refuses to seal -> UNAVAILABLE;
unreadable root or non-regular tree member -> `complete: false`; nothing sealed at
all -> null negative proof.

Consumer per global rail clause 1: daemon coordinator
`task-cf7fb147bd1c47698cbd65c9535370aa`. The consumer edge is NOT landed here.

Related: `mem:gotcha-restore-untracked-mutation-drill-by-byte-compare`,
`mem:gotcha-shared-index-race-defeats-pathspec-commit`.
