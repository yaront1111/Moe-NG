# @moe/mcp

The two MCP transports an agent drives the daemon through when there is no browser: a stdio
server and an official Streamable HTTP adapter over the SAME generated tool surface. Each
turns a tool call into a runtime envelope and hands the daemon's answer back BYTE-FOR-BYTE
while holding no authority: refusals come from the `@moe/contracts` registry (its only import
besides the MCP SDK, pinned `1.30.0`), and whether a command may run is decided behind the
injected dispatch port.

## Seams

- The export map is `"." -> "./src/index.ts"` and NO subpath. `mcp-root-surface.test.ts`
  pins the published names by hand: 16 stdio values, 4 HTTP values, and 3 `http-server.ts`
  values the root deliberately WITHHOLDS (`HTTP_LISTED_TOOLS`, `LOOPBACK_HOSTNAMES`,
  `MCP_PROTOCOL_VERSION_HEADER`) as a negative control against an `export *`.
- `createStdioMcpServer`, `connectStdioTransport`, `readBootstrapCredential`,
  `decodeAndDispatch` → `apps/daemon/src/mcp-main.ts` (the `moe-mcp-stdio` bin).
- `createHttpMcpAdapter` / `HttpAdapterOptions` / `HttpMcpAdapter` →
  `apps/daemon/src/mcp-http/mcp-http-host.ts`; `mcp-http-node-bridge.ts` is the thin
  `node:http` ⇄ `Request`/`Response` shell around it (the `moe-mcp-http` bin).
- `StdioDispatchPort` / `HttpDispatchPort` / `HttpDispatchContext` are implemented ONCE by
  `apps/daemon/src/mcp-dispatch-port.ts`; one value serves both, the HTTP shape (extra
  context argument, async result) being a superset of the stdio one.
- `HttpSessionPort` → `apps/daemon/src/mcp-http/mcp-http-session-port.ts`.
- `toolAllowlist` on both option bags takes runtime KINDS, never tool labels; the roster
  comes from `apps/daemon/src/mcp-tool-allowlist.ts` (`wiredMcpToolKinds()`).
- `onDispatchFault` on both option bags (`McpDispatchFaultObserver`, `dispatch-fault.ts`) →
  `apps/daemon/src/mcp-dispatch-fault-report.ts`, composed by `mcp-main.ts`,
  `mcp-http/mcp-http-main.ts` and `orchestrator/agent-wrapper-main.ts` (through
  `McpHttpHostOptions.onDispatchFault`) as `MCP_DISPATCH_THREW` on the diagnostics plane.
- `STDIO_TOOL_INDEX` / `toolLabelForKind` are also read by
  `tests/integration/portability/portability-cases.ts`.

## The model

- **Tools are generated, not written.** `generateStdioToolEntries()` emits one tool per
  entry of `RUNTIME_COMMAND_KINDS` and `RUNTIME_QUERY_KINDS`
  (`packages/contracts/src/runtime/runtime-vocabulary.ts`), in vocabulary order, frozen.
  There is no HTTP-only tool: `HTTP_LISTED_TOOLS` is `STDIO_TOOL_ENTRIES` mapped.
- **Labels replace `.` with `_`** (`toolLabelForKind`), because dots break common client
  tool-name grammars. The mapping is not injective in general; `stdio-schemas.test.ts`
  proves injectivity over the current closed vocabularies and reds when a new kind collides.
- **`payload` is an opaque `additionalProperties: true` object** — the daemon decoder is the
  only payload authority. `leaseAuthority`'s inner shape is described in prose inside the
  schema description rather than as properties, deliberately: MCP clients LOG tool
  arguments, so naming the bearer field would put it in the log.
- **Envelope field ordering is the security control.** `buildCommandEnvelopeBytes`
  (`stdio-server.ts`) and `buildEnvelopeBytes` (`http-tool-bridge.ts`) spread `...args`
  FIRST and write `commandKind`, `requestDigest`, `schemaVersion`, `sessionCredential`
  (`ADAPTER_SUPPLIED_COMMAND_FIELDS`) LAST, so a client cannot override them; any other
  stray key survives into the envelope and dies at the exact-key decoder. Swap two lines and
  the client wins, with no type error. `requestDigest` is sha-256 over the payload bytes as
  this adapter serialises them, so nothing downstream may re-serialise.
- **One call sequence, both transports** (`stdio-dispatch-port.ts` states it,
  `dispatch-conformance.ts` asserts it): bounded decode → `authenticate(credential, kind)`
  with the VERBATIM dotted kind, never the label → exactly one `dispatchCommandBytes` or
  `dispatchQueryBytes` on the matching surface. A decode refusal makes zero port calls; an
  auth refusal makes zero dispatches.
- **Raw bytes in both directions.** Re-stringifying would renormalise numbers, escapes and
  key order and corrupt `requestDigest` and opaque cursors, so a response leaves as one text
  block with no `outputSchema`/`structuredContent` — and why both files use the low-level
  SDK `Server`, not `McpServer` (which takes only zod).
- **Refusal vocabulary is the registry**: `refuse()` throws
  `new McpError(error.transport.mcpCode, error.code, error)`. Unknown tool label →
  `INPUT_INVALID`; known but outside the allowlist → `CAPABILITY_DENIED`, before envelope
  construction; a port that THROWS → `UNKNOWN_ERROR`, so a store's message never reaches
  client logs, while a refusal the port RETURNS passes through intact. The throw itself goes
  HOST-SIDE: `containDispatchThrow` (`dispatch-fault.ts`) hands `onDispatchFault` the verbatim
  kind, the stage (`authenticate` / `dispatch` / `response-decode`) and the described throw;
  a returned refusal is never reported, and an observer that throws is swallowed so the
  refusal stands. `adapter-refusals.ts` holds the `refuse*` / `serialize` helpers both
  transports share.
- **An allowlist refuses rather than drops**: `allowlistedToolEntries` throws
  `MCP_TOOL_ALLOWLIST_UNKNOWN_KIND` / `MCP_TOOL_ALLOWLIST_EMPTY` at CONSTRUCTION, so a
  drifted roster is a startup failure, not a tool that quietly vanished.
- **HTTP refusal order is the property** (`http-server.ts` `handleRequest`): loopback
  screen → `screenRequest` → `refuseResumption` → bounded body (`MAX_JSON_BODY_BYTES`,
  stream cut once the cap is passed) → request-id screen → SDK transport.
- `screenRequest` (`http-session.ts`) refuses ANY query string outright (credentials must
  never reach URLs), accepts exactly one `Bearer <token>`, re-validates on EVERY request
  (callers must not memoise), and compares an existing session against `principalRef` /
  `sessionRef`, not the credential — rotation keeps the session, a foreign credential gets
  `SESSION_REPLAYED`. The port is VALIDATE-ONLY and a port that THROWS becomes
  `UNKNOWN_ERROR`, never `AUTHENTICATION_FAILED`.
- `refuseResumption` turns `Last-Event-ID` into `CAPABILITY_DENIED` with
  `data.reason = MCP_RESUME_UNSUPPORTED`. Not configuring an SDK `EventStore` is NOT
  fail-closed: the header would be ignored and the client handed a fresh stream.
- `screenRequestIds` refuses a repeated JSON-RPC id across in-flight POSTs AND within one
  batch: the SDK maps pending requests by bare `message.id`, so a duplicate cross-wires two
  responses. `trackHttpInflightRequests` wraps `transport.send` to release a batch's
  reservation only on its LAST response.
- The `SessionCloseLatch` exists because in JSON-response mode the SDK parks each POST's
  resolver and `close()` deletes the mapping without settling it; subscribers deregister on
  completion, since a shared promise would retain a dead `Response` per call served.
- Idle sessions are reaped LAZILY at the next initialize (`HTTP_SESSION_IDLE_TTL_MS`,
  30 min), never by a timer. Shutdown, DELETE and reap run one sweep in `http-shutdown.ts`,
  which gives every act of every entry an independent attempt and then throws a single
  `HttpShutdownError` naming the ids the daemon may still hold. `HTTP_SHUTDOWN_REFUSAL_CODES`
  stays a CLOSED LOCAL vocabulary: a registry entry carries an HTTP status and MCP code for
  rendering, and a shutdown fault has no request to answer.

## Gotchas

- **`dispatch-conformance.ts` has no `.js` bridge and must not get one** — it imports
  vitest, so it is test tier by CONTENT, not by suffix. `mcp-runtime-entrypoint.test.ts`
  pins every excluded module by name AND reason (`imports-vitest`, `helpers-suffix`,
  `test-file`), so adding any test or helper file under `src/` means editing that map.
  It also compares bridge bytes exactly against `export * from "./<name>.ts";` plus one LF,
  so a CRLF bridge lands in `wrongContent` where `git diff --stat` never showed it.
- **`src/index.js` is NOT on the resolution path** — the export map points at
  `src/index.ts`, so renaming the entry bridge proves nothing; the bridges that matter are
  the RELATIVE ones it follows, e.g. `src/http/http-server.js`.
- `EXPECTED_MCP_CODE_BY_ERROR_CODE` in `dispatch-conformance.ts` re-types the whole
  `RUNTIME_ERROR_CODES` → `mcpCode` table by hand; a new contracts code reds both transports.
- `tests/security/boundary-roster.security.ts` pins `"packages/mcp": 1` —
  `HTTP_SHUTDOWN_LAYER`. A second `export const *_LAYER` here reds the security lane.
- `distribution-inventory.ts` ships `mcp-bridge` as exactly `["packages/mcp/src/index.ts"]`
  (mirrored in `distribution-packaging.test.ts`); `release-version-surfaces.test.ts` pins
  this `package.json`.
- `http-server.ts` is 382 lines against the repo's split-before-400 rail;
  `http-request-screen.ts`, `http-resume.ts`, `http-adapter-lifecycle.ts` and
  `http-inflight-requests.ts` were carved out of it. New behaviour goes in a sibling.
- `tsconfig.json` pins `types: ["node"]` with `skipLibCheck` because the SDK's types drag
  DOM lib in; `connectStdioTransport` dynamic-imports it so roots never import the SDK.
- `readBootstrapCredential` is the ONE `process.env` read site (`MOE_SESSION_CREDENTIAL`).
- The loopback Host/Origin screen is owned here, not delegated: the SDK's DNS-rebinding
  protection defaults OFF and cannot express "any loopback port". The transport is ALSO
  pinned to the Host/Origin it was initialised with.

## Testing

- Whole package: `pnpm --filter @moe/mcp test` — its script is
  `vitest run --root ../.. packages/mcp/src`, so it runs under the ROOT vitest config.
- One file: `pnpm vitest run packages/mcp/src/http/http-parity.test.ts`. Root `pnpm test`
  includes `packages/**/*.test.ts`, so the folder runs in the root gate too.
- `pnpm --filter @moe/mcp typecheck` is itself an assertion: the six type-only root exports
  are proved reachable in `mcp-root-surface.test.ts` by annotating values through the BARE
  specifier, and tsc going red is the failure signal, not the runtime `expect` beside it.
- `mcp-runtime-entrypoint.test.ts` and one arm of `mcp-root-surface.test.ts` spawn a REAL
  child Node with `--experimental-strip-types`, cwd at the package root so `@moe/mcp`
  resolves through the export map. Vitest rewrites `./x.js` back to `.ts`, so no other suite
  in the repo can see a missing bridge.
- `http/http-parity.test.ts` is the drift gate: it registers the shared conformance suite
  against HTTP and byte-compares the envelopes BOTH ports received from identical arguments.
- Outside coverage: `pnpm --filter @moe/daemon test` (`mcp-dispatch-port`,
  `mcp-tool-allowlist`, `mcp-main`, `mcp-http/*`), `pnpm test:security`
  (`transport-hostile-fixtures.ts` deep-imports `http-shutdown.js` / `http-session.js`, plus
  the boundary roster), and `tests/integration/portability/transport-host-matrix.test.ts`,
  driving the installed `moe-mcp-stdio` and `moe-mcp-http` executables.
