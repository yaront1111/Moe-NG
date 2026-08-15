# Gotcha: nothing in this repo typechecks `tests/` — and a test asserts the tsconfig anyway

Found on `task-97554aa4` (2026-08-08) while wiring the `test:e2e` lane.

## The hole

- Root `"typecheck": "pnpm --recursive typecheck"`.
- `pnpm-workspace.yaml` lists only `apps/*`, `adapters/*`, `packages/*`.

**`tests/` is not a workspace package, so `pnpm typecheck` structurally cannot reach it.**

That is not obvious, because `tests/fault/foundation/tsconfig.json` EXISTS and
`packages/testkit/src/foundation/foundation-gate-coverage.test.ts` asserts, in a test named
*"typechecks every owned file through a tsconfig project on the shared base"*, that it exists
and that its `include` covers every owned file.

It asserts the tsconfig's **existence and coverage**. It never asserts that anything
**invokes** it. So ~816 lines under `tests/fault/foundation/` are typechecked by no gate, and
a green board says otherwise. This is the same family as
`mem:gotcha-or-ed-layer-assertion-pins-neither-layer`: an assertion that has quietly detached
from the thing it was written to check.

## What to do in a new `tests/` lane

Put the `tsc -p` in your OWN script, not in the shared `typecheck`:

```json
"test:e2e": "tsc -p tests/e2e/foundation/tsconfig.json && vitest run tests/e2e"
```

Amending root `"typecheck"` to reach `tests/` would change a gate every in-flight task depends
on for its evidence. Your own lane is yours to make honest.

## Two consequences worth knowing before you do it

1. **`tsc -p` follows imports.** Your lane's tsconfig `include` may be `["./*.ts"]`, but tsc
   fully typechecks every `.ts` it reaches through your imports. Import a production package
   and your lane goes red whenever a foreign worker leaves that package mid-TDD-red. Attribute
   such a red BY PATH, and re-run — it often flips green on its own
   (`mem:gotcha-completion-hook-commits-whole-tree`).
2. **A new `tests/**/*.test.ts` file joins the repo-wide `pnpm test` automatically**, because
   `vitest.config.ts` includes `"tests/**/*.test.ts"`. Fine for deterministic files. NOT fine
   for anything that spawns or kills processes — that would land in the gate every concurrent
   worker uses for evidence. Excluding it needs an edit to `vitest.config.ts`, which no task
   owns.

## Measuring the suite-set delta honestly

```bash
npx vitest list --root . --filesOnly | sort > before.txt   # keep OUTSIDE the repo
# ... land your files ...
npx vitest list --root . --filesOnly | sort | diff before.txt -
```

Expect foreign files to appear in that diff too — other agents land tests while you work. On
`task-97554aa4` the delta was +4: my 2, plus `packages/runner/src/supervisor/supervisor-restart.test.ts`
and `packages/scheduler/src/index-surface.test.ts` from other in-flight tasks. Say which are
yours rather than reporting a bare count.
