# SQLite schema decomposition — implementation handoff

Task `task-9e3faf3b14c64e0c908eca0ffebf846c` implemented by `worker-4dddabde`.
Commit `9e16dde`, exactly 9 owned paths, +625 / -584.
Gate: `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test`
exit 0, 18 files / 112 tests — identical to the pre-edit baseline.

Design and the do-not-simplify list: `mem:decision-sqlite-schema-decomposition`.
Verification technique: `mem:gotcha-refactor-coverage-arithmetic`.

## Method that made this cheap and safe

Every module was GENERATED from the source, not retyped:

```sh
{ cat <<'HEADER'
...imports...
HEADER
  sed -n '<start>,<end>p' sqlite-schema.ts | sed '1s/^function X/export function X/'
} > sqlite-schema-<part>.ts
sed -i '<start>,<end>d' sqlite-schema.ts
```

Four large SQL templates (receipt/event semantics with 5 bound params, the
aggregate-heads UNION ALL, the sqlite_sequence name check, the dense-position
UNION ALL) therefore never passed through a keyboard.

## Repeatable per-extraction loop

1. `awk '/^function NAME\(/{s=NR} s&&NR>=s&&/^}$/{print s"-"NR; exit}' file`
   to get exact bounds — do not eyeball them.
2. Generate the module + its `.js` shim; delete the range from the facade.
3. Fix orphaned imports. **This bites after every single move.** `tsc` reports
   `TS6133: 'X' is declared but its value is never read`. Resolve by occurrence
   count, not by guessing: `grep -c '\bSYM\b' file` — a count of 1 means the
   import line itself is the only occurrence, so drop it.
4. Diff the moved range against HEAD, blank-normalized.
5. Run the focused gate.

Delete ranges HIGH line numbers FIRST when removing multiple blocks, or earlier
ranges shift under you. I removed 226-290 before 60-101 for that reason, then
recomputed the third range because it had moved.

## Shims

All four new modules needed a tracked `<name>.js` containing exactly
`export * from "./<name>.ts";`. Omitting one fails neither `tsc` nor Vitest —
only `store-runtime-entrypoint.test.ts`, with `ERR_MODULE_NOT_FOUND`. In
`packages/store/src` the only shim-less non-test files are `index.js` (package
export resolves `./src/index.ts` directly) and the two `*-test-helpers`.

## For QA

The green suite is necessary but NOT sufficient — codes are asserted, messages
and check order are not. The real evidence is the step-6 range diffs plus
coverage arithmetic, reproducible against `9e16dde^` in about a minute.
