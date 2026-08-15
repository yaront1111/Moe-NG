# An adapter that constructs its collaborators privately makes them untestable

Measured on `task-70b6361d` (2026-08-15), `packages/mcp/src/http/http-server.ts`.

`createHttpMcpAdapter` builds its SDK `Server` and
`WebStandardStreamableHTTPServerTransport` inside `openSessionTransport` and hands them to
nobody. A DoD clause asking to assert "the session's transport was closed and its server was
closed" is therefore **not satisfiable from an adapter-level test**, and the ways it looks
satisfiable are all dead ends:

- `Protocol` exposes `get transport()` (shared/protocol.js:494) and `Protocol.close()` just
  awaits `this._transport?.close()` (:500) — both public, both reachable only from an instance
  the test cannot obtain.
- The transport's `sessionId` is a public field, same problem.
- `Protocol.connect()` (:220) OVERWRITES `transport.onclose` with its own chained closure, so
  that callback is not a free seam either.
- After `close()` the registry entry is gone, so no request routes to the pair — there is no
  behavioural probe left.

Only prototype monkey-patching would reach them, and `Server` has no own `close` (it inherits
Protocol's), so you would be shadowing a base-class method on a shared prototype.

## The fix that keeps the assertion honest

Extract the orchestration into a function that takes the closables as **structural**
collaborators:

```ts
export interface ClosableSession {
  readonly server: { close(): Promise<void> | void };
  readonly transport: { close(): Promise<void> | void };
}
```

The real SDK pair satisfies it by structure (no SDK import needed in the new module), and a
test supplies recorders. Test the orchestration there; keep an end-to-end test at the adapter
for the *composition* direction, and prove that direction with a mutation drill on the
extracted function that must redden the ADAPTER-level test
(`mem:qa-prove-composition-by-mutating-the-real-primitive`).

This is not a scripted double hiding a kernel defect: the function's whole job IS the
orchestration, and the registry and the release helper it calls stay production.

Related: `mem:gotcha-fake-port-makes-host-drill-vacuous`,
`mem:gotcha-real-process-ports-are-invisible-to-injected-port-suites`.
