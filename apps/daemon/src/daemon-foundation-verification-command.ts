import type { SqliteEventStore } from "@moe/store";

import { DomainRefusal, domainRefusalOf } from "./daemon-command-dispatch.js";
import { createFoundationVerificationService }
  from "./evidence/foundation-verification-service.js";
import { createRecipeSealComposition } from "./evidence/recipe-seal-composition.js";
import { createVerificationCatalogReader } from "./evidence/verification-catalog-reader.js";
import type { AsyncCommandHandler } from "./http/http-async-contract.js";
import type { DurableDecision } from "./http/http-contract.js";
import type { AttemptFinalizationOutcomeName }
  from "./work/attempt-finalization-contracts.js";
import { finalizeVerifiedAttempt } from "./work/attempt-finalization-service.js";

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

/** The PREFIX every recorded-verification result code carries. The VERDICT is not restated
 *  here: PASSED/FAILED is the durable receipt's own fact, and this names WHICH fact the
 *  decision points at -- the same division `FOUNDATION_DISPATCH_RESULT_CODE` makes. */
export const FOUNDATION_VERIFICATION_RESULT_CODE = "FOUNDATION_VERIFICATION_RECORDED";

/**
 * ONE CODE PER FINALIZATION OUTCOME, so an operator can tell a released attempt from one
 * whose binding was written and whose release refused WITHOUT a second query. A bare
 * `FOUNDATION_VERIFICATION_RECORDED` cannot say which of the four happened, and
 * `readAttemptRelease` answering ABSENT would then be indistinguishable from a fault.
 *
 * EXHAUSTIVE BY TYPE, not by a runtime list: the mapped type over
 * `AttemptFinalizationOutcomeName` means a fifth outcome fails `tsc` here rather than
 * silently answering `undefined` at run time.
 */
export const FOUNDATION_VERIFICATION_RESULT_CODES: Readonly<
  Record<AttemptFinalizationOutcomeName, string>
> = Object.freeze({
  BINDING_WRITTEN_RELEASE_REFUSED:
    `${FOUNDATION_VERIFICATION_RESULT_CODE}_BINDING_WRITTEN_RELEASE_REFUSED`,
  DRAINING: `${FOUNDATION_VERIFICATION_RESULT_CODE}_DRAINING`,
  NO_OP: `${FOUNDATION_VERIFICATION_RESULT_CODE}_NO_OP`,
  RELEASED: `${FOUNDATION_VERIFICATION_RESULT_CODE}_RELEASED`,
});

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
    //
    // Read ONCE per command, into a const. Two reads of `principal.principalId`
    // are two chances for a getter to answer differently, which would let the
    // recipe seal below and the verification commit under DIFFERENT identities
    // for one command -- and the seam's own arm pins the read count for exactly
    // that reason.
    const principalId = principal.principalId;
    const service = createFoundationVerificationService({
      principalId,
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
    //
    // ONE CARVE-OUT: FOUNDATION_VERIFICATION_RECIPE_CONFLICT. The identity is a
    // pure function of (projectId, capability) -- argv is NOT an input -- so an
    // operator-edited catalog argv for an already-sealed pair conflicts here and
    // nowhere below: the durable seal still resolves and still re-derives, so
    // `service.verify` would execute the OLD argv and mint a receipt, and drift
    // would read as success. That is the one refusal verify cannot catch, so it
    // surfaces here -- the seal's own code and layer, carried verbatim like the
    // verify refusals below. Every other seal refusal keeps the fall-through.
    const recipeAggregateId = payload["recipeAggregateId"];
    if (options.verificationCatalogSource !== undefined
      && typeof recipeAggregateId === "string") {
      const sealed = createRecipeSealComposition({
        catalog: createVerificationCatalogReader({
          catalogSource: options.verificationCatalogSource,
        }),
        principalId,
        projectId: options.projectId,
        store: options.store,
      }).sealNamed(recipeAggregateId);
      if (!sealed.ok && sealed.code === "FOUNDATION_VERIFICATION_RECIPE_CONFLICT") {
        throw domainRefusalOf(sealed);
      }
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
    if (!outcome.ok) throw domainRefusalOf(outcome);

    // THE POST-VERIFICATION FINALIZATION, and this is the ONLY moment it can run.
    // A durable receipt now exists for this attempt, so `finalizeVerifiedAttempt`
    // can leave a RELEASED row and a receipt-BEARING core handoff binding
    // CO-OCCURRING — the pair the pre-verification ordering could never produce,
    // because it released before any receipt existed and its binding therefore
    // carried `receipt: null`.
    //
    // IT SELECTS IDENTITIES ONLY. The two strings handed over are the ones the
    // caller already named to say WHICH verification this is; every release,
    // truth, terminal, receipt, observation, digest and handoff fact is re-read
    // from durable state inside, and the decision identity below is the SERVER's.
    //
    // THE ANSWER REPORTS THE FINALIZATION THIS COMMAND RAN. The receipt is already
    // durable and it STANDS: a refused finalization does not retract it, and the
    // refusal is fail-closed, leaving no release authority behind. What it may not do
    // is answer DECIDED over a release that was never written — expansion then
    // requires a release record this command told the caller it had. A later replay
    // finalizes idempotently once the missing fact lands.
    const finalized = finalizeVerifiedAttempt(options.store, {
      commandId: envelope.commandId, correlationId: envelope.correlationId,
      principalId, projectId: options.projectId,
    }, {
      attemptAggregateId: payload["attemptAggregateId"],
      verificationId: payload["verificationId"],
    });
    // CODE AND LAYER VERBATIM from the refusing wrapper, and the SOURCE pair verbatim in
    // `detail` — the only slot the transport refusal carries (refusalFor,
    // daemon-command-dispatch.ts:78-81). `source` is null when this module's own
    // admission declined and no upstream was consulted, and then the code is its own
    // detail, exactly as `decisionOf` does at :49-53.
    if (!finalized.ok) {
      throw new DomainRefusal(finalized.code, finalized.layer, finalized.source === null
        ? finalized.code
        : `${finalized.source.code}@${finalized.source.layer}`);
    }

    return Object.freeze({
      commandId: envelope.commandId,
      // The COMMAND decision was made now. A replayed VERIFICATION is answered from the
      // durable receipt row inside the service, which is where that fact belongs.
      disposition: "DECIDED" as const,
      effectId: outcome.digest,
      resultCode: FOUNDATION_VERIFICATION_RESULT_CODES[finalized.outcome],
    });
  };
}
