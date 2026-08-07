import { createRuntimeError } from "@moe/contracts";

/**
 * Stream resumption over MCP is TYPED UNSUPPORTED in this adapter, and this module is what
 * makes that honest rather than silent.
 *
 * WHY UNSUPPORTED. The resumable cursor stream belongs to the control room surface, not to the
 * MCP transport. Command-layer catch-up already exists and is the supported path: a client that
 * missed events replays them with the `events.read` / `events.wait` queries and their cursors.
 *
 * WHY A REFUSAL IS REQUIRED. Simply not configuring an SDK `EventStore` is NOT fail-closed. The
 * transport only reads `Last-Event-ID` when an event store is present; with none configured the
 * header is ignored entirely and the client is handed a FRESH stream. A client that believes it
 * resumed would then silently miss every event in the gap — fabricated continuity, and the
 * worst possible failure for a system whose whole point is that unverified facts stay UNKNOWN.
 * So the header is detected before the transport ever sees the request and refused with a
 * stable, registry-bound error that names the reason.
 *
 * In practice only a broken or hostile client can send the header at all: with no event store
 * configured, no SSE event this adapter emits ever carries an `id:` field, so there is no valid
 * cursor for a well-behaved client to have.
 *
 * LIFTING THIS LATER. Implement the SDK's `EventStore` interface — `storeEvent(streamId,
 * message)` returning an event id, and `replayEventsAfter(lastEventId, { send })` returning the
 * stream id — pass the instance as the transport's `eventStore` option, and delete this screen.
 * The SDK ships a reference `InMemoryEventStore` under its examples; a durable implementation
 * must survive process restart, or resume would fabricate continuity in exactly the way this
 * screen exists to prevent.
 */

/** Standard SSE resumption header, lower-cased for the web-standard `Headers` lookup. */
export const LAST_EVENT_ID_HEADER = "last-event-id";

/** Named in `error.data.reason` so a client can distinguish this from any other refusal. */
export const MCP_RESUME_UNSUPPORTED = "MCP_RESUME_UNSUPPORTED";

/**
 * Returns a refusal when the request attempts to resume a stream, or `undefined` when it does
 * not. Callers must invoke this before every `transport.handleRequest`, which is the property
 * that makes "no silent gap" hold for GET and POST alike.
 *
 * The refusal carries the frozen registry error under `data` plus the reason discriminator. It
 * names no header value and no credential.
 */
export function refuseResumption(request: Request): Response | undefined {
  if (request.headers.get(LAST_EVENT_ID_HEADER) === null) return undefined;
  const error = createRuntimeError({ code: "CAPABILITY_DENIED" });
  return new Response(
    JSON.stringify({
      error: {
        code: error.transport.mcpCode,
        data: { ...error, reason: MCP_RESUME_UNSUPPORTED },
        message: error.code,
      },
      id: null,
      jsonrpc: "2.0",
    }),
    { headers: { "content-type": "application/json" }, status: error.transport.httpStatus },
  );
}
