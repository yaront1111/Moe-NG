# QA verdict: REJECTED (reopen 1) — foreign gate ratchets

Reviewed commit `d03c42f` (worker) at HEAD `9e0f123`. Verdict: reject on **one** defect. Almost
everything else is verified good and the reject message says so explicitly so the worker does not
redo proven work.

## Independently re-verified and PASSING (do not re-prove on the next pass)

- `pnpm typecheck` exit 0. `pnpm test` exit 0 — 159 files / 2890 passed / 1 skipped.
  `pnpm --filter @moe/scheduler test` exit 0 — 32 files / 587 passed.
- Count arithmetic closes with no hand-waving. `packages/scheduler/src/package-boundary.test.ts`
  at `3944a9d` had 3 `it` blocks = **14** tests (1 sweep + 12 extension cases + 1 exports).
  Now **34**. Delta +20 = 10 forbidden cases + 9 allowed cases + 1 matrix-non-empty guard.
  Nothing deleted, skipped or narrowed; the sweep gained `scanned.length > 0` and
  `toContain(scannedWitness)`, i.e. strengthened.
- All three claimed mutation drills reproduce exactly:
  1. drop `fenceAuthority,` from `packages/scheduler/src/index.ts:62` ->
     `TypeError: scheduler.fenceAuthority is not a function` at `j4-replan-stale.test.ts:198`.
     Restore hash `a0ab48fbdd5ccf85838dbb024c9efe74ce79c050`, tree clean.
  2. detector -> `return false` -> all 10 genuine-import cases red.
  3. detector -> old raw `forbiddenInternalPath.test(contents)` -> 7 red: the 6 prose decoys **and**
     `detects CommonJS require`. That last one is a genuine strengthening — the old raw scan could
     not match an escaped Windows-separator specifier (`scheduler\\src` in raw bytes), the new
     detector unescapes in `readQuoted` and catches it.
- `packages/testkit/src/foundation/foundation-fault-schedule.ts` is byte-identical to `3944a9d`.
  Crediting Blocker A to the already-landed commit instead of manufacturing a no-op diff was right.
- Worker commit `d03c42f` = exactly the two changed owned paths. DoD 4 satisfied.
- 281 lines: over the 250 target, under the 400 split bar. Per project rail, per-FILE only and not
  exceeded. **Not** a rejection reason. Worker's rail-3 reason for not extracting a fourth file
  (it would be a path outside the three owned paths) is sound.

## The one defect

`readTemplate` returns only `${}` expressions and discards the template's literal text, so
`moduleSpecifiers` never sees a backtick specifier. `` import(`../../scheduler/src/authority/x.js`) ``
resolves at runtime and is invisible to the guard — a fail-open the OLD raw scan caught. Worse, the
added allowed case `["template-literal prose", ...]` pins that blind spot as intended behaviour.

Secondary, lower bar: `sourceTokens` has no regex-literal handling, so a regex containing an odd
number of quote chars opens a string that swallows a following `import ... from "`. Zero incidence
in the tree today; required to fix **or** make loud (throw on unterminated string), plus a case.

Six other exotic shapes probed and correctly caught: TS `import x = require()`, `export * from`,
`export type { } from`, default import, namespace import, bare `require()`.

## Board impact of rejecting

None. The commit stays, both gates stay green, so the five BLOCKED tasks do not re-jam. Cost is one
worker round-trip only. That is what made reject the right call over approve-with-notes.

## Foreign-path note

Harness post-flight auto-commit `9e0f123` ("Completed via Moe worker session") swept the whole tree:
`apps/daemon/src/work/work-race-fixtures.ts` (271 lines, foreign), `.codex/agent-instructions.md`,
14 `.moe/**`. Reported per task rail 4, not reverted. Worker's own pathspec commit was clean.
