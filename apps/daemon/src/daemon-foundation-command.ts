import type { SqliteEventStore } from "@moe/store";

import { DomainRefusal } from "./daemon-command-dispatch.js";
import { decodeBase64PayloadBytes } from "./http/command-payload-bytes.js";
import {
  ASYNC_ENTRY_REQUIRED_CODE, DAEMON_COMMAND_SEAM,
} from "./http/http-async-contract.js";
import type { AsyncCommandHandler } from "./http/http-async-contract.js";
import type { CommandHandler, DurableDecision } from "./http/http-contract.js";
import { FOUNDATION_ATTEMPT_MAX_REQUEST_BYTES } from "./work/foundation-attempt-codec.js";
import { refuseLocal } from "./work/foundation-attempt-contracts.js";
import { createFoundationAttemptService } from "./work/foundation-attempt-service.js";

/**
 * `foundation.dispatch` as a command entry: the one place the durable attempt service is
 * composed into the seam. It lives beside the registry rather than inside it because
 * `daemon-command-registry.ts`'s export list is pinned by a child-process probe in
 * `daemon-store-dependencies.test.ts`, so a new export may not be added there.
 *
 * THE TRANSPORT SHAPE. `RuntimeCommandEnvelope.payload` is a `JsonObject` and
 * `FoundationAttemptDispatchRequest.activationRequestBytes` is a `Uint8Array`, so the
 * activation blob crosses as base64 under its own explicitly named key and is
 * materialized HERE, before the service is called. The request codec's byte guard is
 * untouched and stays the single authority on what a valid request is.
 */

/** Named in the seam's allow-list, so a smuggled key is refused rather than trimmed. */
export const FOUNDATION_DISPATCH_BYTES_KEY = "activationRequestBytesBase64";

export const FOUNDATION_DISPATCH_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  FOUNDATION_DISPATCH_BYTES_KEY, "binding", "graphSnapshot", "inputManifest", "launchTemplate",
]);

/** The result code a recorded attempt answers with. The attempt's own truth lives in the
 *  durable advisory record; this names WHICH durable fact the decision points at. */
export const FOUNDATION_DISPATCH_RESULT_CODE = "FOUNDATION_ATTEMPT_RECORDED";

export interface FoundationCommandOptions {
  readonly store: SqliteEventStore;
}

/**
 * Registered as the entry's required synchronous handler, and unreachable in production:
 * the seam refuses an async-only entry before it can be called. It refuses rather than
 * returning anything, because a handler that answered here would be inventing a decision
 * for a launch that has not happened.
 */
export const foundationSyncHandler: CommandHandler = () => {
  throw new DomainRefusal(
    ASYNC_ENTRY_REQUIRED_CODE,
    DAEMON_COMMAND_SEAM,
    "this command kind is served only on the asynchronous entry",
    422,
  );
};

/**
 * NO PRODUCTION CAPTURE PRODUCER EXISTS YET — `FoundationAttemptDeps.captureResult` has
 * no producer anywhere outside tests, and task-31ea82e750 owns building one. Answering
 * nothing is the honest report: the store builds no result manifest from it and the
 * attempt's truth stays UNKNOWN. A fabricated answer here would forge exactly the
 * workspace evidence this epic exists to prove.
 */
const captureResult = (): null => null;

/**
 * THE FIFTH BLOCKER, measured here rather than assumed: `decodeRuntimeCommandEnvelopeBytes`
 * hands the seam a FROZEN, NULL-PROTOTYPE view of the payload (bounded JSON's own
 * hardening), and the attempt codec's copier treats any object whose prototype is not
 * `Object.prototype` as hostile. Without this re-materialization every well-formed
 * dispatch dies as FOUNDATION_ATTEMPT_REQUEST_MALFORMED on the prototype alone.
 *
 * It restores ONLY the prototype. Every content rule — exact keys, text bounds, array
 * shapes, depth — is still decided by the codec on the far side, and the value being
 * copied is already plain bounded data: the envelope decoder admits no accessor, no
 * function and no proxy, so there is nothing here for a copy to launder.
 */
function plainValue(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return HOSTILE_PAYLOAD;
  }
}

/** Returned instead of a value the transport could not re-materialize, so the codec
 *  refuses it exactly as it refuses any other malformed section. */
const HOSTILE_PAYLOAD = Object.freeze({ hostile: true });

export function createFoundationDispatchHandler(
  options: FoundationCommandOptions,
): AsyncCommandHandler {
  const service = createFoundationAttemptService({ captureResult, store: options.store });

  return async ({ envelope }): Promise<DurableDecision> => {
    const { payload } = envelope;
    const materialized = decodeBase64PayloadBytes(
      payload[FOUNDATION_DISPATCH_BYTES_KEY], FOUNDATION_ATTEMPT_MAX_REQUEST_BYTES);
    if (!materialized.ok) {
      // The codec's OWN refusal for bytes it cannot accept, so a corrupted transport and
      // a corrupted byte payload are indistinguishable to the caller.
      const refusal = refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
      throw new DomainRefusal(refusal.code, refusal.refusedBy, refusal.code);
    }

    // The payload names WHICH attempt; every authority the service reads is server-side.
    const outcome = await service.dispatch({
      activationRequestBytes: materialized.bytes,
      binding: plainValue(payload["binding"]),
      graphSnapshot: plainValue(payload["graphSnapshot"]),
      inputManifest: plainValue(payload["inputManifest"]),
      launchTemplate: plainValue(payload["launchTemplate"]),
    });

    // The service's own code and layer, verbatim: flattening them would erase which
    // authority refused the dispatch.
    if (!outcome.ok) throw new DomainRefusal(outcome.code, outcome.refusedBy, outcome.code);

    return Object.freeze({
      commandId: envelope.commandId,
      // The COMMAND decision was made now. Launch-level replay is the reservation's own
      // durable fact, recorded in the attempt aggregate rather than restated here.
      disposition: "DECIDED" as const,
      effectId: outcome.digest,
      resultCode: FOUNDATION_DISPATCH_RESULT_CODE,
    });
  };
}
