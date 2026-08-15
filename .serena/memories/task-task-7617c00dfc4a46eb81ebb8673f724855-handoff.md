# Handoff: Subscription cursors with CURSOR_GAP snapshots — DONE (approved reopen 1)

qa-fb528454, 2026-08-08 21:05. Task `task-7617c00dfc4a46eb81ebb8673f724855`, SPIDR step 4
of 5. Approved after one reopen. Final tree = `dfcea2d` (all 11 source files) +
`b897317` (the two missing bridges, +2 lines). `73804e0` / `74f5e6c` are wrapper sweeps —
`.moe/` and `.idea/` only, never the worker's (`mem:gotcha-qa-must-diff-the-workers-commit-not-head`,
4th confirmation).

## What SPIDR step 5 inherits

`packages/store/src/subscriptions/`, 13 tracked files, package-internal (NOT exported from
`index.ts` — the relay set that precedent and this task kept it).

Public entry points, all now loadable under plain Node:
- `subscription-writes.js` — registerSubscription, acknowledge, publishSnapshot,
  advanceGeneration, reseatToSnapshot (5 exports)
- `subscription-read-page.js` — readSubscriptionPage (+1) (2 exports)
- `subscription-contracts.js` — types + code/cause unions (15 exports)
Internal: `subscription-doc-codec.js` (11), `subscription-internals.js` (22).

Seam shape step 5 must satisfy: `readEventsAfter(after: bigint, limit?, maxDecodedBytes?)`
returning `CursorPage<StoredEvent, bigint>` — structural, `SqliteEventStore` already fits.
The module holds its OWN `DatabaseSync` on the same file; it must be opened
`{timeout: 5000}` (node:sqlite default busy timeout is 0).

## Why this reopened, and the check that must now be routine

Sole defect: two production `.ts` files created by a mid-task split had no sibling `.js`
bridge, so all three public entries threw `ERR_MODULE_NOT_FOUND` under Node while 305
vitest tests stayed green. Mechanism + detection recipe:
`mem:gotcha-vitest-hides-missing-js-bridge` and
`mem:gotcha-missing-runtime-bridge-invisible-to-vitest`.

QA closed it with the full two-part probe, not just resolution: every entry imported from
repo root, and each namespace asserted non-empty with zero `undefined` bindings — which is
what rules out a TDZ hole in the real `contracts <-> doc-codec` ESM cycle that vitest never
exercised. Results: 15 / 5 / 2 / 11 / 22 exports, no undefined.

**Rule for any future store/scheduler module: every plan-deviation split needs its own
bridge, and `complete_task` evidence must include the plain-node probe next to the vitest
counts. The focused gate exit-0 is not evidence the module loads.**

## Verified green (do not re-derive)

`pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test` → tsc clean,
**28 files / 305 tests, exit 0**, run by QA at 19:28:51 and again at 21:05:25, identical.
Store baseline before this task was 25 files / 201 tests.

- DoD1 durable reopen `subscription-writes.test.ts:345`; GENERATION_CHANGED → reseat →
  resume `subscription-read-page.test.ts:142`.
- DoD2 is STRUCTURAL, not just tested: `subscription-read-page.ts:30` makes `snapshot` a
  required parameter of the private `gap()` helper, so no CURSOR_GAP arm can be built
  without one; the five call sites `:105 :108 :117 :120` all pass the digest-verified
  baseline. Missing/unparseable sentinel refuses `SUBSCRIPTION_STATE_CORRUPT` instead of
  fabricating.
- DoD3 frozen-page determinism; pagination sweep asserts its own case count
  (`sizes.length > 0` :470, `rounds > 0` :492), seam-failure table likewise (:505).
- Rails: zero `outbox-relay|projections/` import hits; per-file wc -l
  150 / 301 / 265 / 247 / 140, all under 400 (task-level LOC is not a bar —
  `mem:moe-epic-rails-override-qa-loc-bar`).

Design points already audited and sound, skip on any follow-up: publishSnapshot CAS matches
generation AND checkpoint; decode is the strict inverse of encode so tamper has no repair
path; `requireSubscriberId` checks the reserved `moe-snapshot/` prefix before
`requireIdentifier` and every entry point routes through it; `clampToCheckpoint` recomputes
`hasMore` inside the clamped bound and delivers the event exactly at the checkpoint.
`mem:decision-subscription-docs-in-filter-json` records why the docs live where they do.
