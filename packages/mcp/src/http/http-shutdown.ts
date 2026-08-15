import { closeDaemonSession } from "./http-session.js";
import type { HttpSessionEntry, HttpSessionPort, HttpSessionRegistry } from "./http-session.js";

/**
 * Shutdown sweep for the Streamable HTTP adapter.
 *
 * WHY IT IS NOT INLINE IN THE ADAPTER. Releasing a session at shutdown is three acts on three
 * different owners — the daemon binding, the transport, the server — and each can fail without
 * the others being in doubt. Written as a bare loop inside `close()` the first throw abandons
 * every session after it, so a partial shutdown reports as a completed one. The containment
 * that prevents this needs a per-step and per-entry structure that does not belong in a file
 * already at the top of its size budget.
 *
 * THE DAEMON RELEASE GOES THROUGH `closeDaemonSession` AND NOT AROUND IT. That helper is the
 * DELETE path's release too, and it encodes the order this adapter has already decided on:
 * the entry is removed FIRST so a session stops being routable even if the daemon notification
 * fails. Open-coding a second release here would let shutdown and DELETE drift apart silently.
 *
 * A FAILURE IS REPORTED, NEVER TRADED AWAY. Swallowing a release failure to make the loop look
 * total would replace a wrong outcome with a missing one: a daemon-side binding nobody is told
 * about is exactly the defect this module exists to close.
 */

/** Names this layer on every failure, so a shutdown fault is never read as a daemon refusal. */
export const HTTP_SHUTDOWN_LAYER = "mcpHttpAdapterShutdown" as const;

/**
 * Refusals this sweep raises on its own behalf. Kept CLOSED and local rather than added to
 * `@moe/contracts`' runtime registry: every entry there carries an HTTP status and an MCP code
 * because it renders into a client response, and a shutdown fault never does — there is no
 * request in flight to answer. This is the same shape `HTTP_AUTH_REFUSAL_CODES` uses one file
 * over, so the two vocabularies read alike without pretending to be the same list.
 */
export const HTTP_SHUTDOWN_REFUSAL_CODES = Object.freeze([
  "HTTP_SHUTDOWN_SESSION_RELEASE_FAILED",
] as const);

export type HttpShutdownRefusalCode = (typeof HTTP_SHUTDOWN_REFUSAL_CODES)[number];

/**
 * The two closables a session owns, named structurally rather than by SDK type. The adapter's
 * real attachment carries an SDK `Server` and transport, which satisfy this; a test can supply
 * recorders. Nothing here needs to know what either one is.
 */
export interface ClosableSession {
  readonly server: { close(): Promise<void> | void };
  readonly transport: { close(): Promise<void> | void };
}

/**
 * Raised once, after the sweep has finished, when any session failed to release. Carrying the
 * ids rather than the raw causes is what makes it actionable: those are the bindings the daemon
 * may still be holding. The message is built from the closed vocabulary and the ids alone, so
 * whatever a boundary said cannot ride out on it; the first cause is kept on `cause` for a log.
 */
export class HttpShutdownError extends Error {
  public readonly code: HttpShutdownRefusalCode;

  public readonly failedSessionIds: readonly string[];

  public readonly layer: typeof HTTP_SHUTDOWN_LAYER;

  public constructor(failedSessionIds: readonly string[], cause: unknown) {
    super(`HTTP_SHUTDOWN_SESSION_RELEASE_FAILED: ${failedSessionIds.join(", ")}`, { cause });
    this.name = "HttpShutdownError";
    this.code = "HTTP_SHUTDOWN_SESSION_RELEASE_FAILED";
    this.failedSessionIds = Object.freeze([...failedSessionIds]);
    this.layer = HTTP_SHUTDOWN_LAYER;
  }
}

/**
 * Runs one teardown act and reports whether it failed, so the caller can continue rather than
 * unwind. `await` covers a synchronous throw and a rejected promise alike.
 */
async function attempt(act: () => Promise<void> | void): Promise<unknown> {
  try {
    await act();
    return undefined;
  } catch (error) {
    return error === undefined ? new Error("teardown threw undefined") : error;
  }
}

/**
 * Releases and closes every session the adapter still holds.
 *
 * Each entry gets all three acts INDEPENDENTLY: a failed daemon release does not skip closing
 * the transport and server, and a failed close does not skip the entries after it. `entries` is
 * a snapshot — `HttpSessionRegistry.entries()` returns a copy — so removing entries as the
 * sweep runs is safe and is not the mutate-while-iterating bug it resembles.
 */
export async function closeAllDaemonSessions<TAttachment extends ClosableSession>(
  registry: HttpSessionRegistry<TAttachment>,
  port: HttpSessionPort,
  entries: readonly HttpSessionEntry<TAttachment>[],
): Promise<void> {
  const failedSessionIds: string[] = [];
  let firstCause: unknown;

  for (const entry of entries) {
    const { server, transport } = entry.attachment;
    const causes = [
      await attempt(() => closeDaemonSession(registry, port, entry.sessionId)),
      await attempt(() => transport.close()),
      await attempt(() => server.close()),
    ].filter((cause) => cause !== undefined);
    if (causes.length === 0) continue;
    failedSessionIds.push(entry.sessionId);
    firstCause ??= causes[0];
  }

  if (failedSessionIds.length > 0) throw new HttpShutdownError(failedSessionIds, firstCause);
}
