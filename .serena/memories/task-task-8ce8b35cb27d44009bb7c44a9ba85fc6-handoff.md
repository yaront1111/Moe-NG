# task-8ce8b35cb27d4400 — Publish Streamable HTTP MCP surface on @moe/mcp root — QA APPROVED

Commit 6ab5830, 3 files, +188/-0. qa-f3560083, 2026-08-11.

## What landed
`packages/mcp/src/index.ts` +8 lines, purely additive after the stdio blocks:
- `export { createHttpMcpAdapter } from "./http/http-server.js";`
- `export type { HttpAdapterOptions, HttpAuthOutcome, HttpDispatchPort, HttpMcpAdapter } from "./http/http-server.js";`
- `export type { HttpSessionPort } from "./http/http-session.js";`

Two specifiers suffice because `http-server.ts:47` already re-exports `HttpAuthOutcome`/`HttpDispatchPort`
from `./http-tool-bridge.js`. `packages/mcp/package.json` exports is still exactly `{ ".": "./src/index.ts" }`.

New `packages/mcp/src/mcp-root-surface.test.ts` (179 lines, 5 tests). Plus one FORCED line in
`mcp-runtime-entrypoint.test.ts`: its "excludes every test module for a named reason" test is
`expect(verdicts).toEqual({...})` over a walk of every `src/**/*.ts`, so ANY new test file under
packages/mcp/src reddens it. Expect that one-line edit on every future mcp test-file task.

## Consumer edge now unblocked
task-49ed1e6d (Foundation MCP dispatch host) had this export gap as one of its two blockers;
the other is the Windows Job chain. This one is closed.

## Verification facts a future QA can reuse
- `packages/mcp` runtime surface is now **14 values**: 13 stdio + `createHttpMcpAdapter`.
  The other five HTTP names are TYPES and never appear in the namespace.
- Independent plain-Node probe that works, run with cwd = `packages/mcp`:
  `node --experimental-strip-types --input-type=module -e 'const ns = await import("@moe/mcp"); console.log(Object.keys(ns).length)'`
  Self-reference resolution through the package's own `exports` map — no dependency edge needed,
  and it exercises the real `.js` bridges that vitest's `.js`->`.ts` rewrite hides.
- `packages/mcp/src/index.js` is `export * from "./index.ts";` — a wildcard bridge, so new root
  exports flow through it automatically. It needs no edit when publishing a new name.
- Repo-wide `pnpm typecheck` was red at this time on FOREIGN untracked files:
  `packages/runner/src/platform/windows/windows-launch-request{,.test}.ts` (TS2459 + 3x TS6133),
  from the in-flight Windows chain. Untracked => identical at merge-base and HEAD, so path
  attribution is trivial. `packages/mcp typecheck: Done`.
- `task.verification` recorded only the two package legs, not the repo-wide one (500-char cap);
  re-running the full DoD chain yourself is what settles it. See `mem:moe-verification-field-can-be-narrowed`.

## Drills I ran (both restored, md5-matched)
1. Delete the `createHttpMcpAdapter` export -> RED with "expected [13] to deeply equal [14]" plus
   the bound-value check and the Node probe. Proves the name list is hand-written, not Object.keys-derived.
2. Delete the `HttpSessionPort` type export -> `pnpm --filter @moe/mcp typecheck` RED with
   `TS2305: Module '"@moe/mcp"' has no exported member 'HttpSessionPort'` while vitest stayed 5/5 GREEN.
   This is the clean demonstration of `mem:type-only-export-invisible-to-count-test`.
