# A server-teardown assertion run only once has not been tested

Area: `tests/e2e/control-room/**` (static browser journey harness, task-5529a248),
any Node `http.Server` used as a test fixture.

## The trap

Tearing down a Node HTTP server with `server.close()` alone **passes a single
green run** and is still wrong.

`close()` stops the server accepting *new* connections, then waits for existing
ones to drain. A browser page that has just loaded is holding a **keep-alive
socket**, so `close()`'s callback does not fire until that socket times out. On
a single run the process exits on its own timing anyway and the teardown *looks*
correct.

The leak only surfaces **under repetition** — run the same teardown spec twice
back-to-back in one shell and the second run inherits the socket.

## Why it costs so much when it does surface

On Windows it arrives as **EBUSY on the artifact directory**
(`test-results/`, `playwright-report/`), not as a socket or server error. That
reads as a filesystem/permissions problem and sends you to the wrong file
entirely. The real cause is a server that never released its handle.

## The fix

Pair them — `closeAllConnections()` forcibly destroys the held sockets so
`close()` can actually complete:

```ts
server.closeAllConnections()
server.close()
```

## The transferable rule (worth more than the API name)

**Do not believe a teardown assertion that has only ever been run once.** Run it
twice in the same shell before trusting it. This generalises past HTTP servers to
any fixture holding an OS handle: file watchers, child processes, listeners.

Related: cleanup must not overwrite the body's failure — keep the
`&& primary.ok` precedence guard so a failing run reports *why the run failed*,
not why its teardown was untidy. Removing that guard reddens exactly one test
and no gate announces it.
