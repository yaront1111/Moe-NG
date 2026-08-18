import type { SqliteEventStore } from "@moe/store";

import { DomainRefusal } from "./daemon-command-dispatch.js";
import { createFoundationVerificationService }
  from "./evidence/foundation-verification-service.js";
import type { AsyncCommandHandler } from "./http/http-async-contract.js";
import type { DurableDecision } from "./http/http-contract.js";

/**
 * `foundation.verification` as a command entry: the one place the durable verification
 * service is composed into the seam. It lives beside the registry rather than inside it
 * for the same reason `./daemon-foundation-command.js` does — `daemon-command-registry.ts`'s
 * export list is pinned by a child-process probe in `daemon-store-dependencies.test.ts`, so
 * a new export may not be added there.
 *
 * THE TRANSPORT SHAPE. Unlike `foundation.dispatch`, every field of the request is a plain
 * string identity, so nothing is materialized here: the five values cross the wire as they
 * are and `service.verify` -- which takes `unknown` -- stays the single authority on what a
 * valid request is. This module names no code of its own for a malformed request.
 *
 * NO SYNCHRONOUS HANDLER LIVES HERE. The registry registers the kind-agnostic
 * `foundationSyncHandler`, which already refuses an async-only entry under the seam's own
 * code; a second copy would be a second refusal path for one condition.
 */

/** The result code a recorded verification answers with. The VERDICT is not restated here:
 *  PASSED/FAILED is the durable receipt's own fact, and this names WHICH fact the decision
 *  points at -- the same division `FOUNDATION_DISPATCH_RESULT_CODE` makes. */
export const FOUNDATION_VERIFICATION_RESULT_CODE = "FOUNDATION_VERIFICATION_RECORDED";

export interface FoundationVerificationCommandOptions {
  /** The server's project identity. Never read from the payload. */
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export function createFoundationVerificationHandler(
  options: FoundationVerificationCommandOptions,
): AsyncCommandHandler {
  return async ({ envelope, principal }): Promise<DurableDecision> => {
    // PER CALL, never hoisted out of this closure: the service writes every durable phase
    // under the identity it was constructed with, so a service built once at startup would
    // attribute one caller's verification to whoever happened to boot the daemon.
    const service = createFoundationVerificationService({
      principalId: principal.principalId,
      projectId: options.projectId,
      store: options.store,
    });

    // The payload names WHICH verification; every authority the service reads -- the
    // sealed recipe, the activation, the attempt record -- is server-side durable state.
    const { payload } = envelope;
    const outcome = await service.verify({
      attemptAggregateId: payload["attemptAggregateId"],
      candidateRoot: payload["candidateRoot"],
      expectedRecordDigest: payload["expectedRecordDigest"],
      recipeAggregateId: payload["recipeAggregateId"],
      verificationId: payload["verificationId"],
    });

    // The refusing authority's own code and layer, verbatim: the service already carries
    // the attempt store's, the wrapper's and the evidence builder's refusals unflattened,
    // and re-coding them here would erase which authority actually refused.
    if (!outcome.ok) throw new DomainRefusal(outcome.code, outcome.layer, outcome.code);

    return Object.freeze({
      commandId: envelope.commandId,
      // The COMMAND decision was made now. A replayed VERIFICATION is answered from the
      // durable receipt row inside the service, which is where that fact belongs.
      disposition: "DECIDED" as const,
      effectId: outcome.digest,
      resultCode: FOUNDATION_VERIFICATION_RESULT_CODE,
    });
  };
}
