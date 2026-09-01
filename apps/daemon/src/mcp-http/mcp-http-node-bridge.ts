import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { readBoundedNodeBody } from "./mcp-http-body-bound.js";

/**
 * The node:http <-> Web bridge for the MCP host.
 *
 * `@moe/mcp`'s adapter is built on the web-standard transport (`Request -> Promise<Response>`)
 * and owns no socket, so a listener is a thin outermost shell over exactly that call. This
 * module is that shell and nothing else: it makes no authority decision, reads no credential,
 * and knows no route.
 *
 * HEADERS TRAVEL VERBATIM IN BOTH DIRECTIONS. The MCP session id is carried in a header and is
 * protocol state, not decoration — a bridge that drops, renames or lower-cases away a header
 * breaks session resume in a way a status-code assertion never notices. Multi-value headers are
 * preserved as repeated entries rather than being joined, because joining is lossy for
 * set-cookie and for any future repeated protocol header.
 *
 * A DROPPED CLIENT IS OBSERVED, NOT DISCOVERED BY A FAILED WRITE. SSE is the adapter's default
 * transport mode, and between events its pump is parked in `reader.read()` writing nothing — a
 * client that vanishes there is invisible to every write-side check because no write happens.
 * The one signal node gives is `'close'` on the ServerResponse, so the pump registers it BEFORE
 * the first read and answers it by cancelling the reader. Cancellation is what propagates to
 * the source stream's own `cancel()` — the SDK transport frees its stream slot and keepalive
 * timer there, and a pump that never cancels leaks that session state for the daemon's life.
 *
 * Split from `mcp-http-host.ts` so both stay small; the host owns lifecycle, this owns framing.
 */

/** Node lower-cases incoming header names already; undefined entries are simply absent. */
export function webHeadersFrom(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
      continue;
    }
    headers.set(name, value);
  }
  return headers;
}

// The body is read under the committed cap: see mcp-http-body-bound. Buffering
// the whole node stream first would spend the memory the bound is meant to deny.

/**
 * Builds the Web Request the adapter screens. `origin` is the host's own bound origin, so the
 * URL the adapter sees is the one it actually served — the loopback screen in `@moe/mcp` reads
 * this, and handing it a fabricated origin would either bypass or falsely trip that screen.
 *
 * `signal` is the caller's per-connection disconnect lifeline and rides into the Request
 * verbatim: the body is buffered here, so nothing downstream ever touches the socket, and a
 * Request built without a signal reports a dropped client to nobody. The bridge only threads
 * it — deciding WHEN the client is gone is lifecycle, and lifecycle belongs to the host.
 */
export async function webRequestFrom(
  message: IncomingMessage,
  origin: string,
  signal?: AbortSignal,
): Promise<Request> {
  const body = await readBoundedNodeBody(message);
  const url = new URL(message.url ?? "/", origin);
  return new Request(url, {
    ...(body === undefined || body.byteLength === 0 ? {} : { body }),
    headers: webHeadersFrom(message),
    method: message.method ?? "GET",
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Writes a Web Response back onto the node socket, preserving status and every header. */
export async function writeWebResponse(
  response: Response,
  target: ServerResponse,
): Promise<void> {
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => { headers.push([name, value]); });
  target.statusCode = response.status;
  for (const [name, value] of headers) target.appendHeader(name, value);

  if (response.body === null) {
    target.end();
    return;
  }
  // FLUSH HEADERS BEFORE THE FIRST CHUNK. node otherwise holds them until something is written,
  // and an SSE stream that has not yet emitted an event writes nothing — so the client blocks
  // waiting for headers that are sitting in a buffer. Measured: without this, a GET opening the
  // event stream never resolves at the client at all.
  target.flushHeaders();
  // Streamed rather than buffered: SSE is the adapter's default transport mode and a buffered
  // read would never resolve for a long-lived event stream.
  const reader = response.body.getReader();
  let sourceDone = false;
  let disconnected = false;
  let onDisconnect: () => void = () => undefined;
  const disconnect = new Promise<void>((resolve) => { onDisconnect = resolve; });
  const handleClose = (): void => {
    if (disconnected) return;
    disconnected = true;
    // Cancelling is what unparks a pending read ({ done: true }) and what runs the source
    // stream's own cancel() — the SDK transport frees its stream slot there. Guarded on
    // `sourceDone` because 'close' also follows a NORMAL end, where the source already
    // finished and a second teardown is not this pump's to issue.
    if (!sourceDone) void reader.cancel().catch(() => undefined);
    onDisconnect();
  };
  // REGISTERED BEFORE THE FIRST READ, or the window between them silently swallows the only
  // disconnect notification node ever sends; the `destroyed` check covers a client that was
  // already gone when the response arrived, for which 'close' has fired and will not refire.
  target.on("close", handleClose);
  if (target.destroyed) handleClose();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        sourceDone = true;
        break;
      }
      if (disconnected) break;
      // BACKPRESSURE IS HONOURED. A false return parks the pump until node drains the socket
      // buffer — ignoring it buffers an unbounded SSE backlog in process memory for a slow
      // reader. Raced against disconnect because a vanished client never emits 'drain'.
      if (!target.write(chunk.value)) {
        await Promise.race([once(target, "drain"), disconnect]);
      }
    }
  } finally {
    target.off("close", handleClose);
    target.end();
  }
}
