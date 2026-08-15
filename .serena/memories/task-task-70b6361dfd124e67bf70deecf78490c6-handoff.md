# task-70b6361d — MCP adapter close releases daemon-side session bindings

Landed as commit **181e0e9** on `moe/work-2026-08-08`. Working tree for `packages/mcp/` is
clean; the gate is `pnpm --filter @moe/mcp typecheck && pnpm --filter @moe/mcp test` →
exit 0, `Test Files 9 passed (9)` / `Tests 139 passed (139)` (baseline was 8 / 136).

## What was wrong

`createHttpMcpAdapter().close()` did `registry.delete` + `transport.close()` +
`server.close()` per entry and **never** `options.sessionPort.closeSession`. The registry is
the adapter's in-process routing table; releasing an entry from it is not the act that
releases the binding `bindDaemonSession` made with `port.bindSession`.

`transport.close()` does not cover for it — verified in
`@modelcontextprotocol/sdk@1.30.0` `dist/esm/server/webStandardStreamableHttp.js`: `close()`
(:771-787) clears the stream maps and calls `onclose`; `_onsessionclosed` has exactly two
hits, the assignment at :76 and the call at :714 inside `handleDeleteRequest`. **Only a
client DELETE released a binding.**

Second defect on the same loop: unguarded awaits, so one throwing session abandoned every
session after it — a partial shutdown reporting as a complete one.

## What landed

New `packages/mcp/src/http/http-shutdown.ts` (114 lines) + its LF `.js` bridge.
`closeAllDaemonSessions(registry, port, entries)` runs three acts per entry **independently**
through an `attempt()` helper that returns the cause instead of unwinding, releases via the
existing `closeDaemonSession` (so shutdown and DELETE cannot drift and unroute-then-notify is
inherited), and throws one `HttpShutdownError` after the sweep carrying
`code: "HTTP_SHUTDOWN_SESSION_RELEASE_FAILED"`, `layer: "mcpHttpAdapterShutdown"` and
`failedSessionIds`. `http-server.ts` close() is now a one-line delegation; the file SHRANK
312 → 311. DELETE path byte-identical (proved by sha256 of the assertion hunk).

Root publishes `HTTP_SHUTDOWN_LAYER`, `HTTP_SHUTDOWN_REFUSAL_CODES`, `HttpShutdownError` and
type `HttpShutdownRefusalCode` — three runtime values, so `PUBLISHED_HTTP_VALUES` in
`mcp-root-surface.test.ts` moved to 4 with its count pin. `instanceof` alone is not
realm-safe; the code list + layer give a value comparison that is.

## Traps this task hit — check them before touching this package

1. **`mcp-runtime-entrypoint.test.ts` has a CLOSED hand-written verdict map.** Any new
   `*.test.ts` under `src/` reddens `"excludes every test module for a named reason"`. The
   one-line entry is FORCED — proved by deleting just it (1 failed / 138 passed).
   See `mem:closed-verdict-map-forbids-a-new-test-file`.
2. Same file demands a `.js` bridge whose bytes are exactly
   `export * from "./<basename>.ts";\n` — LF, compared as utf8 bytes.
3. **A `layer:` assertion written as `layer: HTTP_SHUTDOWN_LAYER` compares the constant with
   itself and survives any rename of its value.** Mine did; drill D6 caught it. Use the
   literal. See `mem:gotcha-layer-constant-assertion-survives-its-own-mutation`.
4. The adapter's SDK `Server`/transport are unreachable from an adapter-level test —
   `mem:gotcha-adapter-internal-sdk-objects-are-unobservable` records why and the fix.
5. `http-shutdown.ts` was UNTRACKED during drills, so `git checkout` could not restore it and
   would have destroyed it. All six drills restored by Edit + `sha256sum -c`.

## Drills run (all reddened the assertion they targeted)

D1 remove the daemon release → adapter TEST 1 red with the exact `- "close:<id>"` diff of the
original runtime probe. D2 propagate first failure → TEST 3 trace. D3 swallow → TEST 3
`expected undefined to be an instance of HttpShutdownError` (trace assertion stayed green, so
the drill isolated the right property). D4a duplicate release in the sweep → exactly-once.
D4b drop `registry.delete` from `closeDaemonSession` (http-session.ts:222) → the DELETEd
session released twice, which is the only way to reproduce the plan's literal wording since a
DELETEd session is not in `entries()`. D5 rename the code. D6 rename the layer.

## Left open, deliberately, and filed

`task-6f58ca42f8c2497898a9ed2ea02c9632` — `apps/daemon/src/mcp-http/mcp-http-session-port.ts`
`boundSessionIds()` has FOUR grep hits and zero production callers. After this commit the
host's `doStop()` already gets its sessions released by `adapter.close()`, so that task is a
decision (remove vs wire), not a gap. **Do not add a host-side sweep on top** — that is a
double release.

Residual risks disclosed in step 6: `entries()` is a snapshot, so a DELETE interleaving
mid-sweep could double-release and an `initialize` completing after the snapshot goes
unswept. Both shapes predate this change.

Register item 5 reconciliation answered on `task-963cf1d1` (comment-2f6930f6): 10 created +
0 declined + 1 already-closed. **A compound audit finding needs a verdict per clause** —
one verdict on "A and B" cannot express "true of A, false of B", which is how half two was
silently retired.
