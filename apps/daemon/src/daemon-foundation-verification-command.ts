import type { SqliteEventStore } from "@moe/store";

import { DomainRefusal } from "./daemon-command-dispatch.js";
import { createFoundationVerificationService }
  from "./evidence/foundation-verification-service.js";
import { createRecipeSealComposition } from "./evidence/recipe-seal-composition.js";
import { createVerificationCatalogReader } from "./evidence/verification-catalog-reader.js";
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
 * string -- four identities and the candidate root -- so nothing is materialized here: the
 * five values cross the wire as they are and `service.verify` -- which takes `unknown` --
 * stays the single authority on what a valid request is, including the proof that the root
 * holds the record's sealed input tree. This module names no code of its own for a
 * malformed request.
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
  /** The host-scoped verification catalog source. OPTIONAL, and its absence is a
   *  REFUSING state rather than a skipped one: with no catalog nothing is sealed
   *  here, so a verification naming an unsealed recipe still refuses below. */
  readonly verificationCatalogSource?: () => unknown;
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

    // MATERIALIZE THE NAMED RECIPE FROM SERVER-SIDE AUTHORITY, and this is the
    // production call site that makes `sealRecipe` reachable from a served kind.
    // `foundation.verification` NAMES an already-sealed recipe and never created
    // one, while `sealRecipe` had no production caller at all -- so the durable
    // executable body it seals was unreachable from anything the daemon serves.
    //
    // The identity is matched against the ids this project's CONFIGURED pairs
    // derive to, so the caller selects which server-derived recipe to
    // materialize and contributes not one byte of it. A re-seal of the same
    // identity replays from durable bytes; a drifted command refuses CONFLICT.
    //
    // Its refusal is deliberately NOT thrown. Sealing is materialization, not
    // the verification's verdict: a recipe sealed by some other route must still
    // verify, and a recipe that exists nowhere makes `service.verify` refuse
    // under its own code below -- which is the answer that names the right
    // layer. Throwing here would replace that answer with the catalog's.
    const recipeAggregateId = payload["recipeAggregateId"];
    if (options.verificationCatalogSource !== undefined
      && typeof recipeAggregateId === "string") {
      createRecipeSealComposition({
        catalog: createVerificationCatalogReader({
          catalogSource: options.verificationCatalogSource,
        }),
        principalId: principal.principalId,
        projectId: options.projectId,
        store: options.store,
      }).sealNamed(recipeAggregateId);
    }

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
