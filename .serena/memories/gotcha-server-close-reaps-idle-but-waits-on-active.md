# `server.close()` reaps IDLE keep-alive sockets — the "hangs on second teardown" folklore is wrong

Widely repeated in this repo (plan text, and the comment at
`apps/daemon/src/http/http-listener.ts:246`): *"a node:http server without
`closeAllConnections` passes a single teardown and hangs on the second."*

**Measured false on this Node version.** Standalone probe:

```js
const res = await fetch(`http://127.0.0.1:${port}/`);   // connection: keep-alive
await res.text();
server.getConnections(...)                               // -> 1 open connection
await server.close(cb)                                   // -> cb FIRES. Not a hang.
```

Since Node 19, `close()` closes idle keep-alive connections itself.

## Why this matters for mutation drills

Deleting `closeAllConnections()` is an **equivalent mutant** against any test that
only does request → response → stop, no matter how many start/stop cycles it runs.
On task-159be643 that drill survived TWICE: once with no request at all, and again
with a real keep-alive fetch added.

## The distinction that actually kills it

`close()` **waits on ACTIVE connections** — it only reaps idle ones. So the drill is
killable only by a connection that is still streaming:

- Open an SSE stream (`GET` on an initialized MCP session) and **do not drain the body**.
- Then `stop()`. Without `closeAllConnections` it never resolves.
- Bound the await, so the hang reports as a named failure rather than stalling the suite
  (`TIMED OUT waiting for: stop with SSE stream open`). See `mem:mutation-drill-can-hang-instead-of-failing`.

This matters wherever the transport is SSE by default — which is exactly MCP Streamable HTTP.

## Second bug the SSE case exposed

A node bridge that streams a Web `Response` back must call `target.flushHeaders()`
**before** the first chunk. node otherwise buffers headers until something is written,
and an event stream that has not yet emitted writes nothing — so the client blocks
forever waiting for headers, on fully correct-looking code. Only an SSE test finds this.

Related: `mem:gotcha-server-teardown-passes-on-single-run` (the original, narrower note),
`mem:gotcha-mutation-drill-blind-to-broken-syntax`,
`mem:pattern-qa-verify-a-mutation-drill-instead-of-reading-it`.
