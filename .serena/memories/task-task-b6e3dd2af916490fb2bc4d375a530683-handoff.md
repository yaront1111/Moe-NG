# task-b6e3dd2a handoff — crash-safe two-slot recovery anchor installer

**SUPERSEDES the 2026-08-09 "correctly returned to BACKLOG" note that used to live
under this name.** That note listed 5 capability-fitness blockers. Read below for
which ones actually applied, because one of them nearly misled me.

Landed 2026-08-11 by worker-767ae903, commit `1009d99`, 13 files, all under
`packages/store/src`. Gate `pnpm --filter @moe/store typecheck && pnpm --filter
@moe/store test` exit 0, **38 files / 441 tests** (baseline 36 / 384).

## The stale blocker that nearly cost a round trip

The old memory says "Node has no portable OS-backed DPAPI/Keychain/libsecret
keystore primitive", and DoD 1 literally says "one versioned **OS-protected**
anchor record". Read naively that is still unsatisfiable today. **It is not this
task's clause.** taskRail 3 defines what OS-protected means here: descriptor-
oriented write -> fsync -> close -> rename/switch -> parent persistence ->
read-back verification. The task objective independently puts "minting
entropy/keys" out of scope. The anchor is *bound to* an incarnation and key epoch
handed to it; it never mints or protects key material.

Blockers 2 and 3 (store schema, atomic install surface) were genuinely cleared by
task-584f4af0. Blocker 1 (process-local key handle) is irrelevant for the same
reason as above.

## Architecture, and the two things that are not obvious

`@moe/store` still declares **no dependencies** and imports nothing upward.
`grep -rn "@moe/core\|apps/daemon" packages/store/src/recovery-anchor*.ts` exits 1
(control: the same pattern hits 21 files under `apps/daemon`, so the empty result
is a measurement, not a broken command).

**1. Each slot carries its OWN `slot-manifest.json` persistence proof.**
Verification cannot be graded against the anchor. After a crash the fresh reader
usually has to verify the slot the install was *not* writing, and grading gen1's
slot against the in-flight gen2 anchor's digests fails a slot that is perfectly
intact. The manifest deliberately holds no anchor identity, so DoD 1's exclusion
assertion still passes over it.

**2. The database is verified SEMANTICALLY, not by byte digest.** The install
transaction rewrites the file after it is written, so the pre-transaction bytes
are stale by design. Verification reopens the slot database and requires the
stamped binding's incarnationRef/keyEpochRef to match the slot manifest.

## Two digests, because one value cannot satisfy DoD 1 and DoD 5

- `preparedIdentity` — the FENCE. Binds command + generation + incarnation +
  key epoch + preparedAt. **Survives PREPARED -> INSTALLED unchanged**, which is
  what makes "repeated resume reuses its prepared identity" expressible.
- `anchorDigest` — covers the whole record *including* state and currentSlot, so
  DoD 1's "perturbing any of them yields a different identity" holds across the
  transition too.

## Published from the store root (deliberately narrow)

5 constants (`RECOVERY_ANCHOR_ALLOWED_OPERATIONS`, `_CODEC_VERSION`, `_LAYER`,
`_REASON_CODES`, `_STATES`), 6 functions (`prepareRecoveryAnchor`,
`installRecoveryAnchor`, `resumeRecoveryAnchor`, `inspectRecoveryAnchor`,
`discardRecoveryAnchor`, `selectInactiveSlot`), 9 types.

**Withheld on purpose**: the layout constants (`FILE_NAME`, `SLOTS_DIR_NAME`,
`DATABASE_NAME`, `SLOT_MANIFEST_NAME/VERSION`), `RECOVERY_ANCHOR_FAULT_POINTS`
(an injection seam, not a consumer contract), and every internal. A consumer
passes an `anchorRoot` and lets the module own the layout. The publication test
pairs the positive list with a **negative control** on the withheld names.

## Three bugs my own passing tests did not catch

Recording these because each was found by asking "what would this test still pass
with?", not by a failing run.

1. **Resume re-entered the protocol on a settled install.** After the switch
   `currentSlot === targetSlot`, so re-running wrote the payload into the LIVE
   slot. Markers cannot see it — the rewrite lands identical bytes. Caught with a
   **sentinel file** written between install and resume; it only survives if the
   slot was left alone. Fixed with `settledInstall`.
2. **`mutatingOpenAllowed` granted mutation.** A crash at PREPARE leaves the
   prior INSTALLED anchor in place, so `slotVerified && state === "INSTALLED"`
   returned true. INSTALLED means the anchor SELECTED a database, not that
   recovery finished. Now the literal type `false`, with a varying
   `mutatingOpenRefusal` carrying the specific fault code so it is still drillable.
3. **Backslash logical paths.** `"a\b"` and `"a/b"` compare as different strings
   but resolve to the same file on win32, so the duplicate-path guard passed and
   one artifact silently overwrote the other — and still verified, because only
   the survivor is read back. Now rejected outright.

## Mutation drills: 13 run, 2 survived, both closed

Survivors are the interesting part.

- **Non-atomic switch survived.** Faults are injected at boundary granularity, so
  nothing ever crashed *during* a publish and atomicity was genuinely unproven.
  Closed by occupying the staging NAME with a directory so the publish fails
  partway, then asserting the file still reads its previous bytes.
- **Removing the prepared-identity reuse branch survived**, because
  `buildAnchorRecord` is deterministic — identity was reused by determinism, not
  by the branch. But the branch guards a real hazard: without it, preparing again
  over a COMPLETED install rebuilds the record as PREPARED and un-marks a
  finished recovery. Closed with a named test; re-drilled RED.

**The enumeration mattered more than the drill list.** Walking the diff for
"which named test reddens if I delete this?" showed DoD 4 names SIX refusal
causes and I had tests for TWO. That is the exact shape that got task-584f4af0
rejected. `recovery-anchor-refusals.test.ts` now covers all six with **distinct**
codes, every tamper fixture valid at earlier layers, opened by a positive control.

## Gotchas paid for here

- **`/tmp` in Node on Windows is `D:\tmp`**, which does not exist. A drill script
  wrote its restore note there, died mid-way, and left the mutation on disk. Only
  the hash check caught it. See `mem:mutation-drill-restore-anchor-goes-ambiguous`.
- **A botched shell-escaped restore silently DUPLICATED a guard line** rather than
  restoring it. Use the Edit tool for drill restores, not shell escaping.
- **A backslash in a TS string literal is destroyed by shell -> node -> TS
  layering.** `"artifacts\one.bin"` parses as `artifactsone.bin`. Build such
  fixtures with `String.fromCharCode(92)` so no layer can collapse them.
- **`pnpm typecheck` from a package subdir is a convincing false green** with no
  `Scope:` line. The PowerShell tool's cwd had drifted; `pnpm -w typecheck` is
  the repo-wide run. See `mem:pnpm-typecheck-from-subdir-is-not-repo-wide`.

## Repo state at handoff

`pnpm -w typecheck` 0. `pnpm -w test` **239 files / 4900 passed, 1 skipped, exit
0**. `pnpm test:fault` **43/43, exit 0**. The two stale foundation ratchets that
had been red for four sessions are FIXED by task-40983c7c — the plan's
"disclose, do not chase" note about `test:fault` is now stale in our favour.

Commit `fdbdb36` (worker-27fddcb2, a whole-tree sweep) captured an intermediate
copy of `recovery-anchor.test.ts`, so that one file reads as modified rather than
untracked. Final state is in `1009d99`.

## Downstream consumers (epic Clause 1)

`task-2ff368fe` (13.03 daemon restore controller) is the named one — it composes
the core reducer with this surface. Also waiting: `task-8a01c025`,
`task-cf7fb147`, `task-6f786c58`.

**Known limitation, disclosed not fixed:** there is no lock around
`readStoredAnchor -> publish`, so two concurrent installs on one anchor root can
interleave. The write-inactive-only discipline keeps the LIVE slot safe
regardless, and the INSTALLED anchor/slot cross-check now refuses the resulting
mismatch, but a lock belongs to whoever owns bootstrap sequencing.

QA (qa-f3560083) accepted this on review 2026-08-11 and sharpened the reason: on
a disaster-recovery path a lock WITHOUT stale-lock recovery is *worse than none*,
because a crashed installer would permanently block the recovery it exists to
enable. They tried to construct the losing interleaving and could not — every
reachable inconsistency lands on a refusal.

**RESIDUAL THEY FOUND THAT I MISSED, for the follow-on lock task:** slot
verification is MANIFEST-DRIVEN and never `readdir`s the slot, so it cannot see
files present on disk but absent from the manifest. A clobbered install therefore
leaves unreferenced ORPHANS. Disk waste, not a mixed slot — the manifest decides
what is read, so an orphan is never served — but the follow-on should sweep.
Note `markersIn` in the test suite DOES readdir and would catch orphans in tests;
production does not.
