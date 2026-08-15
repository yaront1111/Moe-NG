# task-69fdb23140ab472ebd34c3e4478c3ef2 — worker handoff (DONE, supersedes the architect note)

Genesis-aware restore record classification. Landed by worker-06df66bb.
All 10 plan steps executed. Both this task's bytes and the fix found in
adversarial review are committed.

## What shipped

1. **Genesis persists the canonical binding.** `genesis-recovery-binding.ts`
   installed `encoder.encode(binding.storeContextDigest)` (64 hex chars, from
   which nothing is verifiable). Now `encodeBinding(binding)`.
2. **Genesis anchors itself.** New `settle()` drives `anchorIncarnation` off the
   read-back SLOT BYTES, covering both INSTALLED and PRESENT, so a store whose
   install landed but whose anchor did not is HEALED on the next boot instead of
   stranded unanchored forever.
3. **New module `recovery/restore-genesis-classifier.ts`** (172 lines) —
   `classifyGenesisFence` + `inspectGenesisFence`, 8 stable
   `GENESIS_FENCE_REJECTIONS`.
4. **`RestoreInspection` gained one arm**: `{incarnationRef, keyEpochRef,
   ok: true, outcome: "GENESIS_FENCED"}`.
5. **`readInstalledRestore(store, projectId)`** — the projectId parameter was
   FORCED; `SqliteEventStore` publishes no projectId getter.

## The two things the architect could not resolve — both resolved

**`read.bindingDigest` is NOT `binding.bindingDigest`.** The store's is sha256
over `frame([slot, incarnationRef, keyEpochRef, installedAt, payload])`
(`recovery-install-codec.ts:109`); the mint's is `digestOf("binding", ...)` over
derivation inputs. Asserting equality would refuse EVERY valid genesis. The
classifier instead RECOMPUTES the derivation through `snapshotGenesisContext` +
`deriveIncarnation`. See `mem:gotcha-two-different-binding-digests`.

**The anchor write's invariant change is asserted, not discovered.** After this,
`hasAnchoredIncarnation` is true for a genesis store, so a cleared ACTIVE slot
DEFERS rather than re-minting. Correct — a store fenced once must not be
silently re-fenced — and pinned by a named test.

## Conjuncts actually checked (7, not the plan's 5)

decode+origin, row refs, project context (recomputed), derivation
(incl. fingerprint re-derived from the SPKI), **signature actually verified**,
anchor present, anchor bytes byte-equal. The last is the only one a forger
cannot satisfy: every other check is computable by anyone holding the project
id, because a genesis binding proves itself with a key it minted for itself.

## Forced deviation worth knowing

`readAnchoredIncarnation` was RESTORE-only and its own comment said "A future
genesis anchor needs its own reader". So was `anchorIncarnation`'s idempotence
lookup — a genesis re-anchor would have been reported as a failure. The module
is now origin-parameterized. See `mem:gotcha-anchor-reader-was-restore-only`.

## Verification

- `pnpm --filter @moe/daemon typecheck` exit 0.
- Focused tests exit 0 (53). Full daemon suite 71 files / 1553 tests, exit 0.
- Repo-wide `pnpm typecheck` exit 0.
- Repo-wide `pnpm test` exit 1 on ONE foreign test,
  `tests/integration/control-room/control-room-transport.test.ts` — an 8ms
  wall-clock delta in `seamObservation.reading.value`, produced by
  `apps/daemon/src/http/event-stream.ts`, last touched by `4c39f3a`
  (task-1430dfae "server timing observations"), which is an ANCESTOR of this
  session's base `5a9bf0b`. Predates this work; zero path overlap.

## 5 mutation drills, all red for the right reason

discriminator removed; anchor byte-equality removed; project-context
recomputation removed; **the rail-1 drill** (decode failure as ABSENT) which
reddened 4 tests INCLUDING a pre-existing restore-record guarantee; and the
race-fix drill. Restored with Edit + `sha256sum -c` every time.

## Commits

Most bytes are inside FOREIGN commit `3b928c2` (task-45d12ec, whole-tree hook) —
the known hazard; committed bytes verified identical to the gated tree. The
adversarial-review fix is my own `fdc821f`. QA should review by
`git diff 5a9bf0b..HEAD -- apps/daemon/src/recovery apps/daemon/src/identity`.
