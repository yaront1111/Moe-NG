# Handoff — task-47eecd22b3b94a57a9632672c19ebd97 — Durable resource and integration recovery inventory providers

**STATUS: DONE. QA approved at HEAD `192360e` (reopen #1 cleared).**

Two commits. Impl `fc35d14` (9 files, +2066). Reopen #1 fix `192360e` (test file only, +307/-1).
Production bytes are byte-identical across `fc35d14`, `192360e` and disk — sha256 verified by QA on
all four TS sources. Per-file 257 (contract) / 261 (shape) / 315 (writer) / 355 (reader), four
one-line LF `.js` bridges. Test file 1180 lines, 31 tests.

## QA verification actually performed (reopen #1 close-out)

Gate fresh, foreground, each leg to its own file: `SCHED=0 STORE=0 DAEMON=0 TYPECHECK=0`.
scheduler 43/1319, store 41/469, daemon 76 files/**1631** tests (baseline 1625, delta = exactly the
six new tests), typecheck 0 errors, zero `FAIL`/`error TS` lines in any log, no foreign red.

Four independent QA drills (Edit mutate, focused run, reverse Edit, `sha256sum -c` after each;
final tree 5/5 OK, `git status --porcelain apps/daemon/src/recovery/` empty, no untracked probes):

| drill | mutation | result |
|---|---|---|
| A | `reader.ts:170` drop `storeProjectId !== projectId` | 1/31 red — `expected 'RECOVERY_ANCHOR_UNAVAILABLE' to be 'RECOVERY_INVENTORY_INPUT_INVALID'` |
| B | `contract.ts:247` `projectId`/`projectTag` -> `""` | 2/31 red — 9-field injectivity sweep + projectTag shadow `RECORD_NOT_FOUND` |
| C | `reader.ts:305` kill seal digest **pair** | 2/31 red — `expected 'RECORD_CONFLICT' to be 'RECOVERY_INVENTORY_RECORD_UNREADABLE'`, plus respelled seal reading ok |
| E | `reader.ts:150` row digest recompute | 1/31 red — `expected 'SUBJECT_DUPLICATE' to be 'RECOVERY_INVENTORY_RECORD_UNREADABLE'` |

Every kill lands on a **reason-code** assertion, never on a bare "not ok". Drill A specifically
shows the dead-clause fallback answer is `ANCHOR_UNAVAILABLE`, so the test would have been vacuous
had it only asserted refusal.

## Disclosed survivor — reviewed and deliberately NOT rejected

`decodeRow`'s `sameDurableBytes(encodeDurableRow(row), bytes)` clause survives **alone**
(31/31 green when replaced with `return row;`). Not a hole: the seal commits per-class
`rowDigests` + `itemCount` and the reader cross-checks both, so every reachable respelled row is
still refused — a respelled *existing* row as `SUBJECT_DUPLICATE`, a respelled *new* row as
`RECORD_CONFLICT`. Killing it swaps one UNKNOWN code at `INVENTORY_ADAPTER` for another; no
authority leaks, no partial list. The **pair** (digest recompute + re-encode) reddens — drill E.
Contrast the seal path, where killing the pair made a respelled seal READ SUCCESSFULLY; that one
was a genuine leak and was the legitimate reject.
See `mem:gotcha-surviving-mutant-behind-a-stronger-downstream-commitment`.

## Reusable techniques proven here

- **Forging into the window's own aggregate**: `resolveDurableWindow` is exported, so a test gets
  `aggregateId` / `scopeDigest` / `state.version` from PRODUCTION, then commits raw bytes via
  `store.commitExpectedVersionDecision` mirroring the writer envelope (`commandKind` +
  `key.projectId` are what `isOwnEvent` checks). `encodeDurableSeal` / `encodeDurableRow` /
  `durableSealBody` / `durableInventoryDigest` are exported, so the forgery is canonical and
  correctly digested and is refused ONLY by the guard under test. Each tamper ships an
  honest-forgery control that must be accepted.
- **Digest injectivity against the production function** when a field cannot be killed end to end
  (`projectId` can't: the store validates the caller against `getHealth`, so two projects are two
  files). Sweep perturbs each of nine fields, asserts `toHaveLength(9)` and `Set(...).size === 10`,
  and carries the field name into the compared string so a survivor names itself.

Focused run form (root vitest never sees `apps/**`):
`pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/recovery/durable-recovery-inventory.test.ts`

Downstream consumer: `task-cf7fb147bd1c47698cbd65c9535370aa` composes these registrations.
