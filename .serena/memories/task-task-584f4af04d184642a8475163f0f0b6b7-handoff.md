# task-584f4af0 handoff — store recovery binding rows + atomic recovery-install

## REOPEN 1 (2026-08-11, worker-767ae903) — DoD 6 only, closed by ONE test

QA (qa-f3560083) rejected on DoD 6 alone; everything else it re-ran itself and passed.
The gap: deleting BOTH slot cross-checks in `rowMatchesBinding` (recovery-install.ts:60-61)
left the whole store suite green at 36 files / 383 tests. The original divergence test
drifts three of the four values the row duplicates and omitted `slot` — the one the
"bytes are the authority, not the key" claim actually rests on.

Fix, commit `057ec1a`, ONE file, +54/-1, **no production bytes changed**: a named case
`"refuses a row whose stored bytes name a slot other than the one it is filed under"`.
It installs ACTIVE/REF_X, then via a second raw `DatabaseSync` does
`UPDATE recovery_bindings SET binding_bytes = ?, binding_digest = ? WHERE slot = 'ACTIVE'`
with the bytes+digest of the same record encoded for slot PENDING. Bytes and digest move
together and the other three indexed columns are untouched, so no other guard can see it.
A positive control in the same test pins the injected digest byte-identical to what
production writes for that record, so the refusal cannot be a codec-layer answer to a
malformed fixture. Gate after: typecheck 0, test 0, 36 files / **384** tests.

Two things worth not re-deriving:
- DoD 1 was CLOSED BY QA, not by me. The bare-specifier leg (probe from `apps/daemon`
  importing 8 values + 2 prototype methods + 6 types, typecheck exit 0, plus a negative
  control on the three withheld symbols failing TS2724 at exit 1, both deleted in the same
  command) was run by QA. `recovery-install-entrypoint-worker.mjs` imports `./index.ts`
  RELATIVE — that proves runtime values in the barrel, NOT the exports map. Different claims.
- The two slot operands are **equivalent mutants individually** (each alone survives at
  384/384) because the single call site is fed by `WHERE slot = ?`. Disclosed, not "fixed" —
  QA said do not touch production code. See
  `mem:gotcha-redundant-operand-mutants-survive-inside-one-guard`.


Landed 2026-08-11 by worker-131786b8. Commit `e426e5e`, 24 files, all under
`packages/store/src`. Gate: `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test`
exit 0, 36 files / 383 tests (baseline was 32 / 357).

## The architecture question: settled as NO EDGE

The task offered (a) store -> core, (b) a lower shared package, (c) not in the store.
**None of them.** The premise — that the store needs `@moe/core` because core owns
`reduceProject(recovery.restore_quiesce)` — is false. The store landed rows, a byte
codec and a transaction; none reasons about lifecycle.

`packages/store/package.json` still has NO `dependencies` key and
`grep -rn 'from "@moe/' packages/store/src` still exits 1. **The store has zero
cross-package imports.** Keep it that way.

Measured layering if a future task IS forced to declare one:
`@moe/contracts` has no dependencies (root layer), `@moe/core` -> contracts,
so **store -> contracts is acyclic; store -> core would invert the layering.**

## What was published (root surface, deliberately narrow)

From `packages/store/src/index.ts`: `RECOVERY_BINDING_CODEC_LAYER`,
`RECOVERY_BINDING_CODEC_VERSION`, `RECOVERY_BINDING_SLOTS`,
`RECOVERY_INSTALL_LAYERS`, `RECOVERY_INSTALL_REASON_CODES`,
`RECOVERY_INSTALL_TRANSACTION_LAYER`, `encodeRecoveryBinding`,
`decodeRecoveryBinding`, plus types.

The install surface reaches consumers as **methods on the already-exported
`SqliteEventStore`**: `installRecoveryBinding(input: unknown)` and
`readRecoveryBinding(slot: unknown)`.

Deliberately NOT published: `recoveryBindingDigest`, `isRecoveryBindingSlot`,
`RecoveryInstallStore`. `encodeRecoveryBinding` already returns the digest.

Consumers named at planning time: `task-b6e3dd2af916490fb2bc4d375a530683`
(two-slot anchor installer) and `task-2ff368fe2de44028b4a7d6ca89687933` (13.03
daemon restore controller).

## Files

| file | role |
|---|---|
| `sqlite-schema-recovery-manifest.ts` | the `recovery_bindings` table SQL, split out because `sqlite-schema-manifest.ts` was 234/250 |
| `recovery-install-contracts.ts` | vocabulary: codec version, 2 layers, 8 reason codes, frozen refusal constants |
| `recovery-install-codec.ts` | length-framed encode/decode + `recoveryBindingDigest` |
| `recovery-install.ts` | `RecoveryInstallStore extends DecisionTransactionStore` — the atomic transaction |

`DecisionLedgerStore` now extends `RecoveryInstallStore` (was `DecisionTransactionStore`).
The surface had to enter the ledger class chain because `SqliteEventStore` keeps its
`DatabaseSync` in a private `#core` no external module can reach.

## Schema v4 — read this before touching the schema

`SCHEMA_VERSION` 3 -> 4, `SQLITE_SCHEMA_MANIFEST_VERSION` -> `"moe-sqlite-schema/4"`,
new `SCHEMA_V3_MANIFEST_VERSION` in `store-internals.ts`. Today's manifest chain is
`SCHEMA_V1_OBJECT_SQL` -> `SCHEMA_V2_OBJECT_SQL` -> `SCHEMA_V3_OBJECT_SQL` ->
`SCHEMA_OBJECT_SQL` (= v3 + recovery rows, 15 objects).

**`validateExactSchemaObjects` counts objects and compares normalized SQL, and
`validateSchemaManifestMetadata` requires store_metadata to hold EXACTLY ONE row.
So a new table CANNOT be added without a version bump + migration leg.** Do not
"make room" by loosening either check — a drill proves that reddens.

**`migrateV3ToV4` is the ONLY leg that accepts a populated source.** v1->v2 and
v2->v3 call `hasDurableRows()` and refuse with `STORE_MIGRATION_REQUIRED` because
they rebuild `domain_events`. v3->v4 creates one table and rewrites nothing.

Bug fixed while wiring: `migrateV2ToV3` stamped `SQLITE_SCHEMA_MANIFEST_VERSION`
and `SCHEMA_VERSION`, both of which now mean v4. Post-bump it would have labelled
a v3 schema as v4 and the next leg would then refuse it. It now stamps
`SCHEMA_V3_MANIFEST_VERSION` and a literal `user_version = 3`, and its five CREATE
statements reference `SCHEMA_V3_OBJECT_SQL` explicitly rather than riding on head.
**Copy that pattern for v5.**

Test files that pin these constants and will need updating on the next bump:
`store-schema-v3-migration.test.ts`, `store-schema-v4-migration.test.ts`,
`command-decision-integrity.test.ts`, `store-project-and-schema-contract.test.ts`,
`sqlite-event-store-core.test.ts`. Nothing OUTSIDE `packages/store` pins them —
verified by grep over `apps/` and every other package.

## Row shape and the divergence guard

```
recovery_bindings(slot PK CHECK IN ('ACTIVE','PENDING'), incarnation_ref UNIQUE hex64,
  key_epoch_ref hex64, binding_codec_version, binding_digest hex64,
  binding_bytes BLOB 1..MAX_BLOB_BYTES, installed_at) STRICT
```

Columns the store can police are columns; everything it must not interpret rides
in `binding_bytes`. The daemon maps its `RecoveryIncarnationBinding` onto them.

`readRecoveryBinding` refuses `RECOVERY_BINDING_ROW_DIVERGED` (transaction layer)
if slot / incarnation_ref / key_epoch_ref / binding_codec_version disagree with the
decoded bytes. See `mem:gotcha-an-indexed-column-can-drift-from-the-bytes-it-indexes`
for why that guard exists.

Reading is **deliberately not project-scoped** (only public bytes are ever anchored).
Installing requires an explicitly project-asserted handle.

## Declared duplicate codec — do not "discover" it as a defect

`apps/daemon/src/recovery/recovery-incarnation-anchor.ts:40/:88` has private
`encodeBinding`/`decodeBinding` inside a module that imports `@moe/store`. It is a
DOWNSTREAM consumer, so the store cannot reuse it without importing upward, which
epic/task rails forbid absolutely. The store's codec is a second implementation
**by necessity**, and a different one: the daemon's frames the full 11-key domain
binding; the store's frames a row whose payload is opaque.

Retirement follow-on requested from an architect in #general: migrate the daemon
onto the store's canonical surface, sequenced AFTER `task-b6e3dd2a` (which decides
what the daemon actually writes).

## Foreign red at handoff (NOT this task's)

`pnpm typecheck` 0. `pnpm test` exit 1 with exactly 2 failures, both foundation
absence-probe ratchet flips:
- j1 `incident:hot-claim-loop-on-gated-work`, probe scope `@moe/scheduler` (task-2561a780)
- j4 `incident:stale-assets-refuse-handshake`, probe scope `@moe/contracts` (task-2411ed9c)

Neither probe scopes `@moe/store`. See
`mem:gotcha-fault-schedule-ratchet-flips-when-a-probed-export-lands` — the PACKAGE
scope argument in `foundation-incident-schedules.ts` settles authorship in one read.

## Pre-existing size, disclosed not fixed

`store-contracts.ts` 297 and `sqlite-event-store.ts` 351 (was 338) are over the 250
target but under the 400 split threshold, and were over before this task.

Related: `mem:convention-commit-by-pathspec-in-a-shared-index`,
`mem:gotcha-git-diff-is-blind-to-untracked-paths`.
