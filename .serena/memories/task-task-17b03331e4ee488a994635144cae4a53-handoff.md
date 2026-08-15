# task-17b03331 handoff — `.js` runtime bridges for @moe/skills, @moe/mcp, @moe/control-room-client

**DONE, committed `22898bc`** on `moe/work-2026-08-08`. 19 files, +667, **all `create mode`**
(zero `M`), so no `.ts` was modified anywhere. Executed by `worker-29cc6667` 2026-08-09.
Same defect class as `task-eb9ff081` (@moe/runner, `160215a`), `task-386fcb4c` (@moe/core,
`3e7081d`) and `task-b7049554` (@moe/context + @moe/review).

## The bridge count is 16, NOT the plan's 17 — read this before reviewing

Non-test `.ts` is 5 + 10 + 3 = 18. **Two** mcp modules are test tier, not one:

| module | why excluded |
|---|---|
| `mcp/src/http/http-server-test-helpers.ts` | `*-test-helpers.ts` suffix (the plan knew) |
| `mcp/src/dispatch-conformance.ts` | **imports `vitest` at module scope**, consumed only by 5 `*.test.ts` |

`dispatch-conformance.ts` carries no test suffix — it is `mem:gotcha-test-tier-modules-have-no-test-suffix`
made real, and the plan's "nine bridges, NOT ten" would have published a vitest import on the
runtime surface. Both are used as negative controls, so the exclusion is *asserted*, not described.
Deviation was announced in channel before committing, not after.

## Bridge set rule used here, and why it is NOT @moe/core's reachability rule

All three packages pin an exclusive `"exports": { ".": "./src/index.ts" }`, so
`mem:gotcha-core-bridge-set-needs-reachability-not-name-or-closure` is *applicable* — but
reachability alone gives mcp only **4** (index + `stdio/{stdio-server,stdio-dispatch-port,stdio-tool-schemas}`).
`http/` is real production code that `index.ts` does not export yet.

> Rule that generalises across all four sweeps: **bridge every production module; exclude test tier.**
> Reachability coincided with that in @moe/core only because its excluded set happened to be all test tier.

Bridging an unreachable production module is inert; skipping a reachable one breaks the entry.
So the tests assert reachable ⊆ bridged (a SUBSET, deliberately not equality — commented in
`mcp-runtime-entrypoint.test.ts` so nobody "fixes" it).

## Evidence (a green vitest run is NOT evidence for this task)

- Plain-Node probe, **Node v24.16.0**, repo root, one process per entry. skills **15 exports / 0
  undefined** (was `ERR_MODULE_NOT_FOUND :: skill-contract.js`), mcp **12 / 0** (was
  `stdio/stdio-server.js`), control-room-client **1 / 0** (was `client-compat.js`).
  `exports:1` for crc is correct — `createCompatGate` is its only value export.
- All 16 bridges probed as their own entry in **separate** processes:
  `PROBED=16 FAILED=0 UNDEFINED_BINDINGS=0 ZERO_EXPORT=1 NODE_MODULES_FAILURES=0`.
  The one zero-export is `stdio/stdio-dispatch-port.js` — 2 export lines, both `export type`/`interface`.
  Verified against committed precedent `scheduler/graph-preview-model.js`,
  `store/projections/projection-rebuild-contracts.js` (both 0 in the same sweep).
- Bare-specifier probe through each real `exports` map: `@moe/skills` 15, `@moe/mcp` 12,
  `@moe/control-room-client` 1 from `apps/control-room`.
- Regression controls unchanged: scheduler 36, store 26, runner 66, core 39, contracts 46,
  coordination 14, testkit 11, context 19, review 23.
- **10 mutation drills, all killed** — 5 against the audit script, 5 against the new tests
  (delete a bridge; bridge each of the two exclusions; CRLF flip; neighbour-pointing bridge).
- Committed **blobs** od-verified LF: `N=16 BAD=0`.
- Gates exit 0. skills 2 files/75+1skip → **3/80+1skip**; mcp 6/125 → **7/131**;
  control-room-client 3/26 → **4/32**. `generator-determinism` + `generated-coverage` still
  pass (2 files / 16); no generated file hand-edited, generator NOT taught to emit bridges.
- `@modelcontextprotocol/sdk` resolves clean (server/index.js 1, types.js 171,
  webStandardStreamableHttp.js 1). **No probe failure named node_modules**, so DoD item 4 had
  nothing to report. Shown non-vacuous by asking for `.../sdk/does-not-exist.js`, which *does*
  return a node_modules-path failure.

## Two traps I hit; see the linked gotchas

1. My first bare-specifier probe reported `Cannot find package '@moe/skills'` for all four —
   a **harness artifact**, not a defect: bare specifiers resolve from the importing MODULE and
   `probe.mjs` deliberately lived outside the repo. Re-run via `node -e` (referrer = cwd), all
   IMPORTED. `mem:gotcha-bare-specifier-probe-needs-an-in-repo-referrer`.
2. `tests/runtime/package-loadability.test.ts` had an allowlist naming THIS task as owner —
   a cross-task coupling nothing in the task description mentioned.
   `mem:gotcha-package-loadability-allowlist-names-its-owner-task`.

## For the next module added to any of these three packages

Add its sibling bridge in the SAME commit. Each package now has a
`*-runtime-entrypoint.test.ts` that reddens in **both** directions (missing AND unexpected),
pins each exclusion by name AND reason, and asserts bridge bytes so a CRLF flip lands in
`wrongContent`. Drills confirmed all of it fails when it should.

Related: `mem:gotcha-vitest-hides-missing-js-bridge`, `mem:gotcha-scheduler-js-shims`,
`mem:gotcha-core-bridge-set-needs-reachability-not-name-or-closure`,
`mem:gotcha-test-tier-modules-have-no-test-suffix`,
`mem:gotcha-bash-tool-mangles-dollar-quoted-cr-pattern`,
`mem:mutation-drills-in-shared-worktree`,
`mem:task-task-386fcb4c6d0241289f177cec9a3010e8-handoff`.
