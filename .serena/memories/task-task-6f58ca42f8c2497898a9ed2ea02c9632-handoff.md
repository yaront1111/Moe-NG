# task-6f58ca42 — Daemon MCP host: boundSessionIds() REMOVED (outcome a)

Landed as commit **5ee89be** on `moe/work-2026-08-08`, exactly two files, 12 insertions /
24 deletions. Committed bytes == gated bytes (`git hash-object` == `git rev-parse HEAD:<path>`
for both). Gate fresh at 5ee89be: `pnpm --filter @moe/daemon typecheck` -> 0 and
`pnpm --filter @moe/daemon test` -> 0, `Test Files 77 passed (77)` / `Tests 1661 passed (1661)`.

## The decision, and the fact that settled it

The task was a genuine either/or: WIRE `McpHttpSessionPort.boundSessionIds()` or REMOVE it.
Chose **REMOVE**. Deciding fact, measured not reasoned:

**The host holds NO reference to the session port.** Its only production construction is
`apps/daemon/src/mcp-http/mcp-http-host.ts:137`, INLINE inside `adapterOf()` as
`sessionPort: createMcpHttpSessionPort(options.deps.authenticator),` passed straight into
`createHttpMcpAdapter`. No variable holds it. So the docstring — "the host closes outstanding
sessions on shutdown and cannot do that without asking" — was false in BOTH clauses: the
ADAPTER closes them (`closeAllDaemonSessions` -> `closeDaemonSession` -> `port.closeSession`,
http-shutdown.ts:104, landed by task-70b6361d), and the host has nothing to ask.

Wiring would have required hoisting the port into a host-level variable FIRST — i.e. creating
the coupling the docstring asserts already exists, in order to justify the accessor asserting
it. Circular. See `mem:gotcha-wiring-an-unused-accessor-can-be-circular`.

The other two (b) candidates were refuted by measurement, not taste: `adapter ??=` plus
doStop()'s capture-then-null-then-`await open.close()` means no live adapter is ever replaced
unclosed; and the bindDaemonSession orphan window is a throw strictly between two Map.set
calls whose remedy would live in packages/mcp (out of scope).

## What landed

`apps/daemon/src/mcp-http/mcp-http-session-port.ts` 114 -> 105 lines:
- accessor removed from interface AND implementation, together with the 4-line docstring;
- the `bound` Map removed too — the accessor was its ONLY reader, so it was unread BY
  CONSTRUCTION (static proof, not a coverage claim). `bindSession`/`closeSession` are now
  documented no-ops with `_`-prefixed params (noUnusedParameters is on).
- Observable behaviour is IDENTICAL: the replaced bodies were `Map.set`/`Map.delete`, neither
  of which can throw, so "returns normally" was already the accept `bindDaemonSession` relies on.
- KEPT the `McpHttpSessionPort` interface: it narrows `validateBearer` to the SYNC `Verdict`
  where the base declares `HttpAuthVerdict | Promise<HttpAuthVerdict>`, and every test calls it
  synchronously. KEPT `type Accepted` (still bindSession's param type).

Test file: the two accessor assertions deleted; case RENAMED
`"binds and closes transport sessions idempotently without touching the store"` ->
`"binding and closing a transport session mints no durable session"`, because nothing observes
the map any more and a title promising an unenforced property is this task's own defect
restated in the test file. 12 `it(` cases, unchanged in count.

## DoD 4 answered vacuously and honestly

Outcome (a) adds NO refusal or failure path, so there is no reason code to pin and no layer to
name. I did not invent one. The existing `isForwardable` fail-closed path was left byte-identical
and proved still load-bearing by drill D2.

## Drills (literal DoD-5 target set was EMPTY — these are the substitutes)

- **D1** removal completeness WITH POSITIVE CONTROL: `grep -rn boundSessionIds` -> 0 hits
  (exit 1); identical grep shape for `bindSession` -> 17 hits. An empty grep alone cannot
  distinguish "removed" from "my grep is broken".
- **D2** `return FORWARDABLE_CODES.has(code);` -> `return true;` reddened the NAMED test
  `"fails CLOSED to AUTHENTICATION_FAILED on a REFUSED code outside the MCP vocabulary"` ON THE
  CODE ASSERTION (`- AUTHENTICATION_FAILED / + PROJECT_QUARANTINED` at :210), not a crash.
  Whole mutate/test/restore cycle in ONE tool call; restore verified by sha256 equality, never
  `git diff`, never `git checkout`.
- **D3** the real bind path still works: mcp-http-host.test.ts 10/10, including
  `"mints a session on initialize and answers tools/call from the PRODUCTION pipeline"`, which
  drives a real initialize through the real adapter onto the no-op `bindSession`.

## Notes for whoever is next here

- The plan cited host test lines :238/:241/:270; at HEAD the real `it(` lines were :216/:245/:168.
  Select cases by TITLE, not by the plan's line numbers — they drift.
- Focused daemon runs need `pnpm --filter @moe/daemon exec vitest run --root . --config package.json <paths>`;
  the naive form finds zero tests (`mem:daemon-focused-vitest-finds-zero-tests`).
- No foreign red anywhere this session; packages/mcp working tree was clean throughout, despite
  the plan's warning about a live peer drill there.
