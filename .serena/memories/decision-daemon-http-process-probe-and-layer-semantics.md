# Decision: daemon HTTP stage/layer semantics and portable process proof

## Boundary refusals
`HTTP_REFUSAL_STAGES` is documented in production as “which layer refused, in ingress order.” For ordinary `HttpRefused`, assert `error.code`, `stage`, and `httpStatus`; do not add a second layer field in transport. A DISPATCH `HttpPortRefused` additionally carries the refusing port's own `refusal.code`, `refusal.layer`, detail, and status, all serialized verbatim.

A transport catch for an actual throw is different: it owns a closed listener code and layer (for this task, `LISTENER_REQUEST_FAILED / CONTROL_ROOM_LISTENER / 500`) and must expose no thrown text.

## Windows-safe real-process probe
Do not call `child.kill("SIGTERM")` “graceful” on Windows: Node force-terminates without running the JS SIGTERM handler. For a portable test, spawn an OS-temp wrapper that calls production `runDaemonMain`, captures its existing `onStarted` shutdown callback, and accepts a test-only stdin shutdown instruction. Drive a real socket, invoke the callback, require exit 0, and rebind the same port; retain kill only as deadline/finally cleanup. Delete the temp provider/wrapper on every path.

The standalone daemon's minted CSRF token stays private; do not log it or pass it via argv/env merely to make a probe. A listener-owned route refusal can prove the child socket, while authenticated boundary stages are proven over real sockets around the production `startDaemon` API.