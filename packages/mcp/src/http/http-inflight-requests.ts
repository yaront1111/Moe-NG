import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isJSONRPCErrorResponse, isJSONRPCResultResponse } from "@modelcontextprotocol/sdk/types.js";

type RequestId = number | string;

export interface HttpInflightRequests {
  readonly ids: ReadonlySet<RequestId>;
  /** Called only after the whole body passed the duplicate-ID screen. */
  reserve(ids: readonly RequestId[]): () => void;
}

interface Reservation {
  readonly pending: Set<RequestId>;
  release(): void;
}

/**
 * SSE headers precede handler completion. Observe the owned transport's public send boundary
 * to retain IDs through actual response completion, even when the caller cancels its body.
 * The SDK retains every batch correlation until its LAST response, so reservations release
 * as a group. Releasing one completed ID early would let reuse steal the unfinished batch.
 * Protocol cancellation suppresses a response without clearing those SDK correlations;
 * the affected IDs therefore remain reserved until the session closes.
 */
export function trackHttpInflightRequests(
  transport: WebStandardStreamableHTTPServerTransport,
): HttpInflightRequests {
  const ids = new Set<RequestId>();
  const reservations = new Map<RequestId, Reservation>();
  const send = transport.send.bind(transport);
  transport.send = async (message, options): Promise<void> => {
    const id = isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)
      ? message.id : undefined;
    const reservation = id === undefined ? undefined : reservations.get(id);
    try {
      await send(message, options);
    } finally {
      // A disconnected SSE stream can make send reject AFTER it releases the SDK mappings.
      // The completed handler still counts; disconnect must not reserve its ID forever.
      if (reservation !== undefined && id !== undefined) {
        reservation.pending.delete(id);
        if (reservation.pending.size === 0) reservation.release();
      }
    }
  };
  return {
    ids,
    reserve(accepted): () => void {
      const reservation: Reservation = {
        pending: new Set(accepted),
        release(): void {
          for (const id of accepted) {
            // JSON completion and late send settlement can both release the same group.
            // Neither may remove an ID that a subsequent POST has already reserved.
            if (reservations.get(id) !== reservation) continue;
            reservations.delete(id);
            ids.delete(id);
          }
        },
      };
      for (const id of accepted) {
        ids.add(id);
        reservations.set(id, reservation);
      }
      return reservation.release;
    },
  };
}
