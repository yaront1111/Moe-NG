import type { SqliteEventStore } from "@moe/store";

import { DomainRefusal } from "./daemon-command-dispatch.js";
import type { DurableDecision } from "./http/http-contract.js";
import { designRefusal } from "./design/design-contracts.js";
import type { DesignRefusal } from "./design/design-contracts.js";
import { submitDesignRevision } from "./design/design-store.js";
import type { DesignSubmitResult } from "./design/design-store.js";

/**
 * The command edge for `design.submit` -- the ONE SEAT KIND this epic's batch adds.
 *
 * WHY THIS EDGE EXISTS rather than the registry's shared `requestOf` path, and it is the same
 * reason `preview.decide` and the five graph mutations are disjoint from it: the design slice
 * owns a CLOSED refusal vocabulary (`DESIGN_CODE_LAYERS`) whose layer is derived from the code,
 * and `requestOf` would answer a malformed submit with the assembler's own generic INPUT_INVALID
 * long before `decodeDesignRevision` ever saw the bytes. A seat told "INPUT_INVALID" cannot tell
 * a dropped section from an unapproved contract; DESIGN_SHAPE_INVALID @ REQUEST and
 * DESIGN_CONTRACT_NOT_APPROVED @ CONTRACT_AUTHORITY are different problems with different fixes.
 *
 * WHAT THIS EDGE MAY DO. Translate, and nothing else. It does NOT decode the revision, prove the
 * Gate 1 approval, choose the version or decide what a conflict is -- `design-store.ts` owns all
 * four and their fixed order, so a second opinion here would give a doubly-invalid request a
 * whichever-ran-first answer. It does NOT restamp the store's refusals: each already carries the
 * code AND the layer of whichever surface answered, plus the delegated surface's own
 * `sourceCode`/`sourceLayer`, and re-wrapping would report a CONTRACT_AUTHORITY verdict as a
 * REQUEST fault. The single thing it adds is reading `goalRef` off the wire as a string.
 *
 * NO LAYER LITERAL APPEARS AT ANY THROW SITE HERE. `designRefusal` takes a CODE and reads the
 * layer out of `DESIGN_CODE_LAYERS`, so this module cannot mint a pair that disagrees, and it
 * introduces no new `*_LAYER` constant -- every layer it can emit is already on the slice's
 * roster.
 *
 * THE AUTHORITY FIELDS ARE SERVER FACTS, NEVER WIRE FIELDS. `projectId` and `principalId` come
 * from the AUTHENTICATED principal, `commandId`/`correlationId`/`expectedVersion` from the
 * envelope and `decidedAt` from the daemon clock. The payload allow-list in
 * `daemon-command-payload-keys.ts` admits `{contractRef, goalRef, revision}` and nothing else, so
 * a caller naming one of the six is refused INPUT_INVALID at PAYLOAD_SHAPE before this runs.
 */

/** Exactly the envelope fields this edge reads. Narrower than `RuntimeCommandEnvelope` on
 *  purpose: a field this module cannot see is a field it cannot let a caller forge. */
export interface DesignEdgeEnvelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly expectedVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DesignEdgeContext {
  readonly envelope: DesignEdgeEnvelope;
  readonly now: () => string;
  /** The AUTHENTICATED principal's id. Never read from the payload. */
  readonly principalId: string;
  /** The AUTHENTICATED principal's project. Never read from the payload. */
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/** An accepted submit IS the state it names: one more revision on the goal's design aggregate. */
export const DESIGN_SUBMIT_RESULT_CODE = "DESIGN_REVISION_SUBMITTED" as const;

function refuse(refusal: DesignRefusal): never {
  // The slice's own code and layer, forwarded unrestamped. The detail names the CODE and the
  // delegated source only -- never the submitted revision, which is caller-authored prose.
  throw new DomainRefusal(
    refusal.code,
    refusal.layer,
    refusal.sourceCode === null
      ? `design.submit refused: ${refusal.code}`
      : `design.submit refused: ${refusal.code} (${refusal.sourceLayer}/${refusal.sourceCode})`,
  );
}

/**
 * Serve one `design.submit`.
 *
 * A FENCED SUBMIT IS RETURNED, NOT THROWN, by the store -- two seats observing version N both
 * submit and the loser comes back DESIGN_REVISION_CONFLICT with `ok: false`. So "it did not
 * throw" is not success here, and `answer` branches on `ok` rather than on the absence of an
 * exception. That is why the store's result is inspected instead of being assumed committed.
 */
export function runDesignSubmitEdge(context: DesignEdgeContext): DurableDecision {
  const { envelope } = context;
  const goalRef = envelope.payload["goalRef"];
  // The wire is JSON, so a field the type calls a string can arrive as null, a number or an
  // object. A non-string goalRef is a SHAPE fault and takes the slice's REQUEST-layer code --
  // the same one `decodeDesignRevision` answers with -- rather than a fifth code minted here.
  if (typeof goalRef !== "string" || goalRef.length === 0) {
    refuse(designRefusal("DESIGN_SHAPE_INVALID"));
  }
  const result: DesignSubmitResult = submitDesignRevision(context.store, {
    commandId: envelope.commandId,
    contractRef: envelope.payload["contractRef"],
    correlationId: envelope.correlationId,
    decidedAt: context.now(),
    expectedVersion: envelope.expectedVersion,
    goalRef,
    principalId: context.principalId,
    projectId: context.projectId,
    revision: envelope.payload["revision"],
  });
  if (!result.ok) refuse(result);
  return Object.freeze({
    commandId: envelope.commandId,
    // Always DECIDED. A replay this edge could report would have to be minted here, and an edge
    // that decides for itself that a submit "already happened" is an idempotency authority
    // reimplemented outside the store that owns one: the store answers a repeated command id
    // with DESIGN_REVISION_CONFLICT through `storeFailure`, which is a refusal, not a replay.
    disposition: "DECIDED" as const,
    // A design revision is not an effect: the append IS the decision, and there is no downstream
    // activation for a caller to bind to.
    effectId: null,
    resultCode: DESIGN_SUBMIT_RESULT_CODE,
  });
}
