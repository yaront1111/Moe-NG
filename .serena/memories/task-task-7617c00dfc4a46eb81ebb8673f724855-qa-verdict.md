# QA verdict: Subscription cursors with CURSOR_GAP snapshots — APPROVED (after 1 reopen)

Final: **DONE**, qa-fb528454, 2026-08-08 21:05. Supersedes the reject verdict below.
Full inheritance notes for SPIDR step 5 live in
`mem:task-task-7617c00dfc4a46eb81ebb8673f724855-handoff`.

## Pass 2 — approval evidence

Fix hash **`b897317`**: 2 files, +2 lines, the two missing one-line bridges, nothing else.
`git diff --stat dfcea2d..HEAD -- 'packages/store/src/subscriptions/*.ts'` is **empty** —
zero production `.ts` bytes changed since the hash reviewed in pass 1, so pass 1's review
was carried forward rather than repeated. That empty-diff check is the cheap way to scope a
reopen review honestly.

Defect closure, verified by QA not taken from the worker's note:
- bridge audit — all 5 production `.ts` have a one-line sibling `.js`; test files have none.
- plain-node probe from repo root (v24.16.0), all five entries import clean:
  contracts 15 exports, writes 5, read-page 2, doc-codec 11, internals 22, **zero
  `undefined` bindings** → the real `contracts <-> doc-codec` ESM cycle has no TDZ hole from
  any entry point. Both false-pass modes in
  `mem:gotcha-vitest-hides-missing-js-bridge` were checked, not just resolution.
- gate re-run 21:05:25: tsc clean, 28 files / 305 tests, exit 0 — identical to the
  19:28:51 baseline.
- `git status --porcelain -- packages/store/src/subscriptions` empty; 13 tracked files.

## Pass 1 — the reject, kept for the record

Reviewed `dfcea2d` (11 files, 2523 insertions, all owned). Sole defect: missing
`subscription-doc-codec.js` and `subscription-internals.js` bridges, imported by
`subscription-contracts.ts:5,11`, `subscription-read-page.ts:14`,
`subscription-writes.ts:19` — all three public entries `ERR_MODULE_NOT_FOUND` under Node
while 305 tests stayed green. `73804e0` / `74f5e6c` were wrapper sweeps (`.moe/` + `.idea/`
only), not the worker's.

Everything else passed in pass 1 and was re-confirmed unchanged: DoD1 durable reopen
(writes.test.ts:345) and GENERATION_CHANGED → reseat → resume (read-page.test.ts:142);
DoD2 snapshot on every gap arm — structural, `gap()` at read-page.ts:30 requires it —
plus NULL-floor both ways and `SUBSCRIPTION_STATE_CORRUPT` on missing/unparseable baseline;
DoD3 determinism and a pagination sweep asserting its own case count; DoD4 gate 0, tree
clean; rails zero `outbox-relay|projections/` hits, per-file 150/301/265/247/140 under 400.

### Two things a future reviewer should not re-litigate

- `subscription-docs.test.ts` has no `SUBSCRIPTION_*` string assertions and does not need
  them: the codec's refusal surface is `null`, so `toBeNull()` **is** the exact reason
  assertion there. Codes and layers are pinned in the two DB suites (writes 20 code +
  17 layer; read-page 5 code + 5 cause + 2 layer).
- Design already audited sound: publishSnapshot CAS on generation AND checkpoint; decode is
  the strict inverse of encode (no repair path for a tampered doc); reserved-prefix guard
  ahead of `requireIdentifier` on every entry point; `clampToCheckpoint` recomputes
  `hasMore` inside the clamped bound.
