# task-159be643 — Compose production Streamable HTTP MCP host — DONE, commit 9aa4711

11 files, +1249/-2. Gate at HEAD: `@moe/mcp test` 8/136, `@moe/daemon typecheck` 0,
`@moe/daemon test` 71 files / 1526 tests. Baseline was 69/1504 and CLEAN, so the delta is all mine.

## What landed
`apps/daemon/src/mcp-http/` — session-port (114), host (222), node-bridge (97), main (72),
plus `.js` bridges for the three imported modules. Entry has NO bridge (matches `mcp-main.ts`).
`apps/daemon/package.json` bin gains `moe-mcp-http`.

Consumer gap CLOSED: `createHttpMcpAdapter` had 0 production callers, now 2 (import + call site).
Unblocks `task-22cfca91` and `task-49ed1e6d` (the latter reported BLOCKED on exactly this gap).

## Four findings worth carrying forward

**1. `@moe/mcp` root does NOT publish `HTTP_AUTH_REFUSAL_CODES` or `MCP_SESSION_ID_HEADER`.**
Root exports are `createHttpMcpAdapter` + 5 TYPES only (`packages/mcp/src/index.ts:28-35`);
exports map is exactly `{".": "./src/index.ts"}`. Any plan saying "consume HTTP_AUTH_REFUSAL_CODES"
is impossible without a deep import. Recover the shapes structurally instead:
```ts
type Verdict   = Awaited<ReturnType<HttpSessionPort["validateBearer"]>>;
type Accepted  = Parameters<HttpSessionPort["bindSession"]>[1];
type RefusalCode = Extract<Verdict, { ok: false }>["code"];
```
Then hand-write the 4-code set and prove exactness with a mutual-assignability check — stronger
than importing, because an imported list cannot notice its producer changing.
Supersedes `mem:gotcha-mcp-http-implementation-not-root-reachable`, which is now STALE
(task-8ce8b35c published the HTTP surface 2026-08-11).

**2. `closeAllConnections` folklore is WRONG on this Node.** See
`mem:gotcha-server-close-reaps-idle-but-waits-on-active`. Drilling its deletion survived twice.

**3. `new Request()` derives no `host` header,** and the adapter screens Host/Origin itself
(`http-server.ts:110` → CAPABILITY_DENIED 403). Streamable HTTP also needs
`accept: application/json, text/event-stream` or answers 406. In-process tests must set BOTH;
socket tests get `host` free. The producer's own helper does exactly this
(`http-server-test-helpers.ts:37`).

**4. The runtime QUERY envelope is EXACT-KEYED** (`hasExactKeys`, `runtime-envelope.ts:190`):
`correlationId, queryKind, schemaVersion, sessionCredential, payload`. Omitting `correlationId`
is refused INPUT_INVALID *before* the dispatch port is consulted — looks like a wiring bug, isn't.

## Bug the adversarial pass caught (no test would have)
`start()` checked `server !== null` but assigned `server` only AFTER `await listen`. Three
concurrent `start()` calls ALL bound — two listeners orphaned, unclosable. Sequential `await`
never sees it. Fixed by serialising lifecycle transitions through a promise chain.
Drilled: unserialised → all 3 succeed.

## Authority mapping (the one new decision)
Daemon 3 arms → MCP 2 arms. AUTHENTICATED → ok:true with `principalRef` copied from
`principal.principalId` (for a session credential that IS `match.sessionId`,
`session-authenticator.ts:139`). REFUSED → forwarded verbatim only if in the 4-code MCP set,
else fails closed. UNAUTHENTICATED → AUTHENTICATION_FAILED.
**SESSION_EXPIRED and CAPABILITY_DENIED are deliberately never selected**: expiry would hand a
caller an oracle separating "expired" from "unknown" that the authenticator refuses to give;
capability is authorization decided behind the dispatch port, not at a credential screen.

## Forced out-of-scope edit
`daemon-startup.test.ts:105` pins the bin map with `toEqual` — a CLOSED set. Adding the bin entry
forces a one-line update there. Proved forced: removing only the bin entry made that suite 5/5
green again. See `mem:gotcha-closed-verdict-map-forbids-adding-a-test-file` — same shape.

## Focused-run form
`pnpm --filter @moe/daemon exec vitest run --root . --config package.json <path>`.
Without `--root . --config package.json` you get "No test files found" (root config excludes
apps/**) — a vacuous red that looks like a broken test file.
