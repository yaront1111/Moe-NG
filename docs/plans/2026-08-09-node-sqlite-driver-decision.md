c# `node:sqlite` storage driver — retroactive decision record

- **Date:** 2026-08-09
- **Status:** `PROPOSED — AWAITING HUMAN RATIFICATION`
- **Authority:** none. This is a retroactive record of a choice already made in code. It
  does not ratify the driver, does not amend the read-only design, and does not assert
  that the design-required spike was performed. It was not.
- **Scope:** creates only this file. No code changes.

## What the design requires

Design section 4.1 (line 136) is explicit that this choice is gated:

> Node 24's built-in `node:sqlite` is still release-candidate API surface as of this
> design. The storage driver is therefore chosen by a blocking packaging/fault spike, not
> brand preference. A candidate passes only if it bundles SQLite `>=3.51.3`, supports
> required transaction/backup primitives, passes Windows/Linux/macOS packaging, exposes
> its SQLite version to `doctor`, and survives the Phase 2 crash matrix. If no candidate
> passes, Phase 2 is blocked rather than weakening the storage contract.

## What actually happened

The store was built directly on `node:sqlite` `DatabaseSync`. **The blocking spike was
never run and no decision was recorded.** This note exists to make that visible, not to
retroactively satisfy the gate.

The de-facto choice, measured on disk 2026-08-09:

- Driver: `node:sqlite` `DatabaseSync` / `StatementSync`, imported across
  `packages/store/src` (ledgers, projections, outbox relay, backup capture).
- Runtime: Node `v24.16.0`; repo pins `engines.node` `>=24.16.0 <25`.
- Bundled SQLite: `3.53.0` (measured via `select sqlite_version()`).

## The five criteria, measured

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Bundles SQLite `>=3.51.3` | **MET** (enforcement is weaker than it looks — see below) | Bundled `3.53.0`. `MINIMUM_SQLITE_VERSION = "3.51.3"` (`store-contracts.ts:1`), compared at every open and refused (`sqlite-event-store.ts:171-173`). |
| 2 | Required transaction/backup primitives | **PARTIAL — exercised, not qualified** | `backup` used in `backup-generation-capture.ts:4`; `BEGIN IMMEDIATE` in `decision-ledger-transaction.ts:95`, `decision-ledger-replay.ts:21`, `event-ledger-recovery.ts:11`, `projections/projection-rebuild.ts:137`. These pass the local suite. Passing unit tests is not the fault qualification the criterion asks for. |
| 3 | Windows/Linux/macOS packaging | **NOT MET** | `process.platform` is `win32 x64`. Linux and macOS conformance are deferred board-wide: `task-e87a7353` (Linux), `task-e94b2055` (macOS). Recorded here as typed `UNKNOWN` naming those task ids — not asserted, not silently omitted. |
| 4 | Exposes its SQLite version to `doctor` | **NOT MET** | The store half exists: `health().sqliteVersion` (`store-contracts.ts:291`, `store-runtime.ts:85`). The doctor half does not carry it — `doctor-version-contract.ts` reports observed `node`, `pnpm`, `platform`, `arch` plus declared pins and workspace components, and `grep -rn sqliteVersion apps/daemon/src` returns nothing. |
| 5 | Survives the Phase 2 crash matrix | **NOT MET / UNKNOWN** | No recorded crash-matrix run for this driver. |

**One of five criteria is fully met.** By the design's own rule the candidate has not
passed, and the design's stated consequence for that state is that Phase 2 is blocked
rather than the storage contract weakened. This record does not overrule that; it asks a
human to decide knowingly.

### Criterion 1's refusal is not observable as a stable reason code

Found while verifying this note, and reported rather than fixed — this task owns
documentation only and may not edit `packages/store`.

The version check fails **closed**, so the safety property holds. But it throws a plain
`Error` whose message merely *begins* with the token:

```ts
// packages/store/src/sqlite-event-store.ts:171-173
if (compareVersions(sqliteVersion, MINIMUM_SQLITE_VERSION) < 0) {
  throw new Error(`SQLITE_VERSION_UNSUPPORTED: ${sqliteVersion} < ${MINIMUM_SQLITE_VERSION}`);
}
```

Three consequences, all measured:

1. **`SQLITE_VERSION_UNSUPPORTED` is not in the error vocabulary.** `DurableStoreErrorCode`
   (`store-contracts.ts:192-209`) does not contain it. The line immediately above uses the
   typed form — `new DurableStoreError("STORE_UNAVAILABLE", …)` — so the codebase draws
   this distinction deliberately elsewhere.
2. **The token is erased at the boundary.** The enclosing `catch`
   (`sqlite-event-store.ts:214-240`) rethrows a `DurableStoreError` unchanged but rewraps
   anything else as `DurableStoreError("STORE_UNAVAILABLE", "SQLite initialization failed")`.
   A caller therefore observes `STORE_UNAVAILABLE`; the version-specific token survives only
   as an unstructured string inside `error.cause.message`. An unsupported SQLite build and a
   corrupt or unopenable database are indistinguishable to that caller.
3. **Nothing pins it.** `grep -rn SQLITE_VERSION_UNSUPPORTED packages/store/src apps` returns
   exactly one hit — the throw site. There is no test asserting this refusal, so the epic's
   "assert the reason code, not just the outcome" rail is unexercised on this path.

This does not change criterion 1's verdict: the minimum version *is* enforced. It does mean
the enforcement cannot be *attributed* by an operator or a doctor probe, which matters
directly to criterion 4 — a doctor field reporting "SQLite unsupported" cannot currently
distinguish that case from a generic store failure. Worth a narrow follow-on: add the code
to `DurableStoreErrorCode`, throw the typed error, and pin it with a test.

## Evidence actually in hand

Fresh, 2026-08-09, from `D:\projexts\moe-next`:

```
$ pnpm test:store
 Test Files  32 passed (32)
      Tests  357 passed (357)
   exit 0
```

That is real evidence and it is worth something: the transaction, replay, recovery,
projection-rebuild and backup paths all work against the bundled `3.53.0` on this host. It
is **not** equivalent to the design-required spike, which asks for cross-platform
packaging qualification and fault survival — neither of which a single-platform unit suite
can establish, however green.

## Residual risk, not waived

- **The API is a release candidate.** Node v24.16.0's official documentation marks
  `node:sqlite` **Stability 1.2 — Release candidate**
  (<https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html>). A release
  candidate surface can change within the pinned `>=24.16.0 <25` range. The engines pin
  bounds the major, not the API.
- **Migration cost is now non-trivial.** The driver is not behind a seam — `node:sqlite`
  types and `DatabaseSync` are imported directly across the store package. If a spike
  later rejects this driver, the change is broad rather than local. That cost is a
  consequence of skipping the gate and is recorded here rather than discounted.
- **Criteria 3, 4 and 5 stay `UNKNOWN`.** Missing evidence does not become a pass, and no
  reader of this note should cite it as one.

## What ratification requires

A human must choose explicitly:

1. **Ratify with residual risk accepted** — record that `node:sqlite` is the driver, that
   criteria 3–5 are open, and what happens if the RC API breaks; or
2. **Order the blocking spike** the design requires, and treat the current store as
   provisional until it passes; or
3. **Reject the driver**, accepting the migration cost described above.

Two of the open criteria have concrete, narrow follow-on shapes, neither of which this
documentation task may perform:

- **Criterion 4 is one field on a landed surface.** The doctor version report already
  models exactly this shape — `ObservedValue` is `{known: true, value}` or
  `{known: false, code, layer}` — so a SQLite entry can be added without inventing a
  representation, and it fails closed to a typed unknown when the store is unreachable.
- **Criterion 3's Windows half is satisfiable on this host**; the Linux and macOS halves
  are the deferred tasks named above and cannot be observed from `win32`.

Until one of the three choices is recorded, the foundation continues to use `node:sqlite`
because that is what is built — which is a description of the status quo, **not** a
ratification and not a claim that the gate was met.
