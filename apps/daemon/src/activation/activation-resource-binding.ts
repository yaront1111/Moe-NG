/**
 * (J) The activation ingress's durable resource-set bind, kept in its own module
 * so `activation-ingress.ts` does not grow past its line target.
 *
 * THE ORDER IS FORCED, not a preference. `bindAttemptResources` re-reads the
 * COMMITTED activation to obtain attemptRef, the effect intent and the project
 * fence, so it cannot run before that commit exists. Binding first and making the
 * activation conditional on it would leave an orphan resource row every time the
 * activation commit failed, and the binder would have no durable activation to
 * read. Landing the resource event INSIDE the activation aggregate is likewise
 * impossible: `readFoundationActivationHistory` is a strict
 * exactly-one-plus-ordered-tail reader, so a foreign event type on that stream
 * makes the ACTIVATION itself unreadable.
 *
 * A BIND REFUSAL IS NOT AN ACTIVATION REFUSAL, and it is not reported as an
 * accepted binding either. The activation is already durable by the time this
 * runs; answering "refused" would be a false claim about a decision the store has
 * committed. The observable of a failed bind is the resource reader answering
 * ATTEMPT_RESOURCE_RECORD_ABSENT — which grants no terminal authority, so it
 * BLOCKS a consumer's release rather than permitting one. That is the fail-closed
 * direction, and it is exactly why the outcome is discarded here rather than
 * folded into the ingress result.
 *
 * THE ROWS ARE READ ONCE into a local. `decodeBoundedJsonBytes` produced this
 * payload, so it holds no accessors and a second read could not return a
 * different array; there is no claim-versus-bind TOCTOU to defend against on this
 * ingress. That is why the claim is not re-run to obtain the rows and why
 * `ClaimSuccessors` is not widened to carry them.
 *
 * A REPLAYED activation binds too: the bind commits at expectedVersion 0 under a
 * command key derived from the same commandId, so a second identical activation
 * replays at the store and the event count stays 1.
 */

import type { SqliteEventStore } from "@moe/store";

import { bindAttemptResources } from "../work/attempt-resource-authority.js";
import { deriveActivationAggregateId } from "./activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "./activation-ledger-contracts.js";
import type { ActivationIngressRequest } from "./activation-ingress-contracts.js";

export function bindActivationResources(
  store: SqliteEventStore,
  request: ActivationIngressRequest,
  record: ActivationLedgerRecord,
): void {
  const slot = request.payload["slot"];
  const rows = slot === null || typeof slot !== "object" || Array.isArray(slot)
    ? null
    : (slot as Record<string, unknown>)["rows"];
  bindAttemptResources(store, {
    activationAggregateId: deriveActivationAggregateId(
      record.effectIntent.aggregateId,
      record.effectIntent.idempotencyKey,
    ),
    commandId: request.commandId,
    correlationId: request.correlationId,
    principalId: request.principalId,
    projectId: request.projectId,
  }, rows);
}
