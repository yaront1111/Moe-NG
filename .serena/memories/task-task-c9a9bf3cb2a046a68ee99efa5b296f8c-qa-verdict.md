# task-c9a9bf3cb2a046a68ee99efa5b296f8c QA verdict — APPROVED (reopen 1 closed)

Official MCP stdio adapter. Original impl `55ecf7e`; reopen fix `0734ea7`
(`test(mcp): lock adapter-owned fields`), test-only, +43/-4, exactly one path:
`packages/mcp/src/stdio/stdio-server.test.ts`. Production stdio bytes unchanged
since 55ecf7e (`git diff --stat 55ecf7e..HEAD -- packages/mcp/` = that one test file).

## The reopen gap and how it was closed

Reopen 1 rejected on ONE mutation-proven gap: object-literal field ordering in
`buildCommandEnvelopeBytes` / `buildQueryEnvelopeBytes` was the only thing binding the
kind the adapter AUTHENTICATES (from the tool label) to the kind the daemon EXECUTES
(from the envelope). Hoisting only `commandKind` above `...args` survived 48/48 green.

Fix: `overwrites every adapter-supplied command field` + `overwrites every adapter-supplied
query field`, asserting on the DECODED dispatched envelope via
`selectFields(decoded.envelope, ADAPTER_SUPPLIED_*_FIELDS)` + `toEqual`, driven off the
exported registries so a field added later is covered automatically. Hostile input is a
*different valid* kind (`RUNTIME_*_KINDS.find(k => k !== CONFORMANCE_*_KIND)`) plus
`schemaVersion: 0` and an attacker credential/digest, so the decoder's vocabulary check
cannot mask a missing override. Registries themselves pinned at
`stdio-schemas.test.ts:111-121` (4 command fields, 3 query fields).

## Mutation matrix I ran myself (9/9 KILLED — do not re-derive)

Per-field hoist above `...args`, one field at a time, `npx vitest run packages/mcp/src/stdio`,
`git checkout --` between each:

    cmd.commandKind cmd.requestDigest cmd.schemaVersion cmd.sessionCredential
    qry.queryKind   qry.schemaVersion qry.sessionCredential
    cmd.ALL         qry.ALL                                  -> all KILLED, 1 failed/48 passed

`cmd.commandKind` (the survivor last round) dies for the RIGHT reason, not a decoder
side-effect: `expected commandKind 'goal.create', received 'approval.decide'` inside
`overwrites every adapter-supplied command field`. Escalation path is closed on both
surfaces. Working tree verified clean after every restore.

## Gates re-run

- `npx vitest run packages/mcp/src/stdio` -> 2 files / 49 tests, run twice, identical.
- Declared verification `pnpm --filter @moe/mcp typecheck && pnpm --filter @moe/mcp test`
  -> both exit 0; 4 files / 96 tests (49 stdio + 47 foreign http).
- Repo `pnpm test` -> 92 files / 1313 passed + 1 skipped, exit 0.
- Sizes: production max 272 (`dispatch-conformance.ts`), stdio-server 215,
  stdio-tool-schemas 210, port 30, index 26 — all under the 400 rail. Test file 364.

## Foreign-work trap hit mid-review (see `mem:gotcha-dependency-gate-uncommitted-siblings`)

`packages/mcp/src/http/` is 100% untracked foreign work (`git ls-files` -> 0) from the
Streamable HTTP sibling, landing live DURING this review. First
`pnpm --filter @moe/mcp typecheck` was RED with 5 TS errors, all in
`src/http/http-server.test.ts` (missing `./http-server.js`, `exactOptionalPropertyTypes`,
implicit any, stale `DeferredPort` shape) — zero in stdio/. Isolated the owned surface with
a throwaway tsconfig in `%TEMP%` (extends the repo base, `include` limited to index +
dispatch-conformance + stdio/**, and **explicit `typeRoots` pointing at the repo
node_modules/@types** — without it tsc emits `TS2688 Cannot find type definition file for
'node'` because it resolves typeRoots relative to the tsconfig's own directory) -> exit 0.
Minutes later the sibling committed `http-server.ts` and the package gate went green on its
own. Never stash or move a sibling's untracked files to get a gate green.

## Carried non-blocking items (unchanged, still not gating)

1. `requestDigest = sha256(JSON.stringify(payload ?? null))` — contracts constrain only
   hex64 (`runtime-envelope.ts:147`) and `@moe/contracts` has no canonical-JSON helper, so
   this adapter is the de facto definition. A daemon that later canonicalises rejects every
   command. Architect owns a shared helper; the HTTP sibling must use the same one.
2. `dispatch-conformance.ts` 272 lines — over the 250 soft target, under the 400 rail.
3. SDK `ErrorCode.RequestTimeout` -32001 collides with the frozen registry's UNAUTHENTICATED
   binding; clients must read `error.data.code`. Architect's call.
4. Envelope-shaped tool schemas are an explicit interim until M3's one-source-schema pipeline.

See `mem:gotcha-adapter-supplied-field-ordering` for the reusable pattern — the HTTP sibling
reproduces this exact structure and needs the same per-field mutation proof.
