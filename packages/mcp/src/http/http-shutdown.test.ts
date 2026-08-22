/**
 * Containment of the adapter's shutdown sweep.
 *
 * WHY THIS TEST LIVES AT THE SWEEP AND NOT AT THE ADAPTER. DoD 4 asks for an assertion that the
 * surviving session had its TRANSPORT closed, its SERVER closed and its BINDING released. The
 * adapter constructs its SDK transport and server privately inside `openSessionTransport`, so an
 * adapter-level test can reach neither object without monkey-patching SDK prototypes; "transport
 * closed" is simply not observable from outside `createHttpMcpAdapter`. The sweep takes those two
 * closables as collaborators, so here they are recordable for real. The complementary direction —
 * that the adapter genuinely delegates to this sweep with its own registry, port and attachments —
 * is asserted end-to-end in `http-server-lifecycle.test.ts` and is what mutation drill D1 kills.
 *
 * The registry below is the PRODUCTION `createHttpSessionRegistry`, and the release runs through
 * the production `closeDaemonSession` inside the sweep. Only the two closables and the port are
 * doubles, and each is a recorder rather than a reimplementation.
 */
import { expect, it } from "vitest";

import { createHttpSessionRegistry } from "./http-session.js";
import type { HttpAuthAccepted, HttpAuthVerdict, HttpSessionPort } from "./http-session.js";
import {
  HTTP_SHUTDOWN_LAYER,
  HTTP_SHUTDOWN_REFUSAL_CODES,
  HttpShutdownError,
  closeAllDaemonSessions,
} from "./http-shutdown.js";
import type { ClosableSession } from "./http-shutdown.js";

const VERDICT: HttpAuthAccepted = Object.freeze({
  ok: true,
  principalRef: "principal-http",
  sessionRef: "session-http",
});

const FAILING_SESSION = "session-a";
const SURVIVING_SESSION = "session-b";
/** Stands in for whatever a real daemon boundary would name. Must never reach a message. */
const DAEMON_DETAIL = "10.0.0.1:5432";

function attachmentFor(sessionId: string, observed: string[]): ClosableSession {
  return {
    latch: {
      release(): void {
        observed.push(`latch:${sessionId}`);
      },
    },
    server: {
      close(): void {
        observed.push(`server:${sessionId}`);
      },
    },
    transport: {
      close(): void {
        observed.push(`transport:${sessionId}`);
      },
    },
  };
}

function throwingPortFor(failingId: string, observed: string[]): HttpSessionPort {
  return {
    bindSession(): void {},
    closeSession(id: string): void {
      observed.push(`close:${id}`);
      if (id === failingId) throw new Error(`daemon refused the release at ${DAEMON_DETAIL}`);
    },
    validateBearer(): HttpAuthVerdict {
      return VERDICT;
    },
  };
}

it("tears every session down and names the failure when one session's release throws", async () => {
  const observed: string[] = [];
  const registry = createHttpSessionRegistry<ClosableSession>();
  registry.bind(FAILING_SESSION, VERDICT, attachmentFor(FAILING_SESSION, observed));
  registry.bind(SURVIVING_SESSION, VERDICT, attachmentFor(SURVIVING_SESSION, observed));

  const failure: unknown = await closeAllDaemonSessions(
    registry,
    throwingPortFor(FAILING_SESSION, observed),
    registry.entries(),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );

  // The whole ordered trace, not a membership check. It pins three separate things at once:
  // the surviving session got ALL of its teardown steps; the FAILING session still got its
  // transport closed, its latch released, and its server closed after its release threw; and
  // the failing session did not push the survivor's work ahead of its own, which a per-entry
  // `catch` around the whole entry would have done. The latch sits right after the transport
  // close, because that close is what strands a JSON-mode response the latch must settle.
  expect(observed).toEqual([
    `close:${FAILING_SESSION}`,
    `transport:${FAILING_SESSION}`,
    `latch:${FAILING_SESSION}`,
    `server:${FAILING_SESSION}`,
    `close:${SURVIVING_SESSION}`,
    `transport:${SURVIVING_SESSION}`,
    `latch:${SURVIVING_SESSION}`,
    `server:${SURVIVING_SESSION}`,
  ]);
  // Unroute-then-notify: both entries left the registry even though one notification failed.
  expect(registry.entries()).toEqual([]);

  // A partial shutdown must never report as a complete one. The stable code, the layer and the
  // failing session id are all pinned — "it rejected" alone would stay green if the code were
  // swapped for another, and the id is what tells an operator WHICH binding is now unaccounted.
  expect(failure).toBeInstanceOf(HttpShutdownError);
  const shutdownError = failure as HttpShutdownError;
  expect({
    code: shutdownError.code,
    failedSessionIds: shutdownError.failedSessionIds,
    layer: shutdownError.layer,
  }).toEqual({
    // Both pinned as LITERALS. `layer: HTTP_SHUTDOWN_LAYER` would compare the constant against
    // itself — rename the constant's VALUE and that assertion moves with it and stays green,
    // pinning nothing. The literal is what makes a renamed layer a failing test.
    code: "HTTP_SHUTDOWN_SESSION_RELEASE_FAILED",
    failedSessionIds: [FAILING_SESSION],
    layer: "mcpHttpAdapterShutdown",
  });
  expect(HTTP_SHUTDOWN_LAYER).toBe("mcpHttpAdapterShutdown");
  expect(HTTP_SHUTDOWN_REFUSAL_CODES).toContain(shutdownError.code);
  // The cause is kept for diagnosis but the message is built from the closed vocabulary, so
  // whatever the daemon boundary said cannot ride out on it.
  expect(shutdownError.message).not.toContain(DAEMON_DETAIL);
  expect((shutdownError.cause as Error | undefined)?.message).toContain(DAEMON_DETAIL);
});
