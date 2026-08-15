# Gotcha: @modelcontextprotocol/sdk 1.30.0 WebStandardStreamableHTTPServerTransport

Empirically verified against the 1.30.0 dist sources plus 125 passing tests in
`packages/mcp/src/http/`. Companion to `mem:gotcha-mcp-sdk-1.30-repo-toolchain`.

## 1. Thrown errors leak their message to the client (WORST ONE)

`handlePostRequest` ends with:

```js
catch (error) {
  return this.createJsonErrorResponse(400, -32700, 'Parse error', { data: String(error) });
}
```

`String(error)` puts your raw `Error.message` in the HTTP response body. The scope of that
try includes the AWAITED `onsessioninitialized` callback, so anything your daemon-bind path
throws — host, port, connection string, stack text — is echoed to the caller as a 400.

Do NOT rely on wrapping `transport.handleRequest(...)` in try/catch: the SDK swallows the
throw and returns 400, so your catch never runs. Catch INSIDE the callback, record a flag,
and after `handleRequest` returns, discard the SDK's response and emit your own stable one:

```ts
onsessioninitialized: async (id) => { try { await bind(id) } catch { failed = true } }
// ...
const response = await transport.handleRequest(req, opts)
if (failed) { await response.body?.cancel(); await transport.close(); await server.close(); return stableRefusal() }
```
The tool-call path is safe: `Protocol._onrequest` catches handler errors itself and never
rethrows into this scope.

## 2. DNS-rebinding protection is off, deprecated, and cannot express "any loopback port"

`enableDnsRebindingProtection` defaults FALSE; `allowedHosts`/`allowedOrigins` are marked
`@deprecated Use external middleware`. The check is `allowedHosts.includes(hostHeader)` —
EXACT string match against a `Host` that includes the port, so a static loopback list
breaks on any other port. Own the screen yourself before `handleRequest` (parse the host,
strip the port, compare the hostname) and keep the SDK's as defence in depth. A good use of
the SDK layer: PIN each session's transport to the exact Host/Origin it initialised with.

## 3. No body size bound at all

`await req.json()` is unguarded. Read the body yourself and pass `parsedBody` (the SDK then
never re-reads). Buffering via `request.arrayBuffer()` and measuring afterwards is NOT a
bound — a chunked request with no `Content-Length` is fully buffered first. Read
`request.body.getReader()` in a loop, accumulate, and `reader.cancel()` the moment the cap
is passed. Note a stream pulls ahead of the reader by its high-water mark, so an assertion
on bytes produced must allow ~2 chunks of slack, not 1.

## 4. One transport instance = one session

`validateSession` is strict equality against a single instance field (400 when the header is
missing, 404 on mismatch). Serving more than one client needs your own
`Mcp-Session-Id -> {server, transport, verdict}` registry that routes BEFORE the transport
is consulted.

## 5. No authentication hook

Wrapping before `handleRequest` is the only mechanism, which is also what makes "zero
dispatch on an auth failure" trivially true. Validated identity flows in as
`HandleRequestOptions.authInfo` and arrives as `extra.authInfo` in request handlers.
`AuthInfo.token` is the only per-request channel for a credential.

## 6. Cancellation vs disconnect are NOT the same

- `notifications/cancelled` DOES abort `extra.signal` (Protocol keeps an abort controller
  per in-flight request id and deletes it on completion — so the handler must still be in
  flight, which needs an ASYNC port to test).
- Cancelling the SSE response body does NOT abort the signal and does NOT stop dispatch:
  the stream unmaps, the handler runs to completion, `send()` throws into `onerror`. Assert
  "result lost, nothing fabricated", never "dispatch aborted", or the test is red forever.

## 7. Last-Event-ID is silently ignored without an EventStore

Not fail-closed. With no `eventStore` the header is never read and the client gets a FRESH
stream, so a client that believes it resumed has an invisible gap. If you do not implement
resumability, REFUSE the header before `handleRequest`.

## 8. Misc

- `sessionIdGenerator` is SYNC; `onsessioninitialized`/`onsessionclosed` are AWAITED.
- `enableJsonResponse: true` + `keepAliveMs: 0` give deterministic bytes for fixtures. SSE
  frames are `event: message\ndata: <json>\n\n` — a single `data:` line, since
  `JSON.stringify` never emits raw newlines.
- POST requires `Accept: application/json, text/event-stream` (both) and
  `Content-Type: application/json`.
- `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` resolves fine under
  NodeNext. `express` is not required; only the Node wrapper pulls `@hono/node-server`.
- Tests need no socket: build `new Request(...)` and call `handleRequest` directly. For a
  streaming body, undici requires `duplex: "half"`.
