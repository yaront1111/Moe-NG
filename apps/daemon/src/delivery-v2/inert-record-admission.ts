import {
  DELIVERY_V2_READER_LAYER,
  type DeliveryV2AppendContext,
  type DeliveryV2Refusal,
} from "./contracts.js";
import { admitDeliveryV2MaterialPublisherPrincipalId }
  from "./material-publisher-admission.js";

/**
 * The admission shared by the three inert content-addressed records that live outside the generic
 * material topology — source snapshots, planner admission profile revisions and node planning
 * sources. Their persistence modules append once per content address and their readers refuse
 * under one layer, so both rules are stated here once rather than three times.
 */

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * A first append only: `expectedVersion` is exactly positive zero, every identifier is an
 * admitted publisher-sized id that is well-formed and free of NUL, and `decidedAt` is the
 * canonical millisecond ISO instant of a real moment (a rolled-over date does not round-trip).
 */
export function validDeliveryV2InertAppendContext(value: DeliveryV2AppendContext): boolean {
  const identifiers = [value.commandId, value.correlationId, value.principalId, value.projectId];
  return value.expectedVersion === 0 && !Object.is(value.expectedVersion, -0)
    && identifiers.every((identifier) =>
      admitDeliveryV2MaterialPublisherPrincipalId(identifier) !== undefined
      && identifier.isWellFormed() && !identifier.includes("\0"))
    && CANONICAL_TIMESTAMP.test(value.decidedAt)
    && !Number.isNaN(Date.parse(value.decidedAt))
    && new Date(value.decidedAt).toISOString() === value.decidedAt;
}

/** A frozen reader refusal; the layer defaults to the reader's own. */
export const refuseDeliveryV2InertRead = (
  code: DeliveryV2Refusal["code"],
  layer: DeliveryV2Refusal["layer"] = DELIVERY_V2_READER_LAYER,
): DeliveryV2Refusal => Object.freeze({ code, layer, ok: false as const });
