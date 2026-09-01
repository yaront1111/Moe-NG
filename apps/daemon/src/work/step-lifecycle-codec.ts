import { decodeBoundedJsonBytes } from "@moe/contracts";

import { exactKeys } from "./foundation-attempt-codec.js";
import {
  STEP_CHECKPOINT_COMMAND_KIND, STEP_FINISH_COMMAND_KIND, STEP_LIFECYCLE_PAYLOAD_KEYS,
  STEP_LIFECYCLE_SCHEMA_VERSION, STEP_START_COMMAND_KIND, stepRefusal,
} from "./step-lifecycle-contracts.js";
import type {
  StepLifecycleCommandKind, StepLifecycleRefused,
} from "./step-lifecycle-contracts.js";

/**
 * The request decoder for the step lifecycle, split out of
 * `./step-lifecycle-command.js` the way journal split `journal-entry-codec.ts`: the
 * writer alone is at the per-file cap once all three handlers live in it.
 *
 * `projectId`, `principalId` and `decidedAt` are SERVER facts the registry's
 * `requestOf` stamped. They are read from the ENVELOPE and never from the payload,
 * which has no key for any of them — so a caller cannot name a project, impersonate
 * a principal or choose a decision time even before authorization runs.
 *
 * EVERY OMISSION IS A REFUSAL, NOT A TRIM. `exactKeys` compares cardinality first, so
 * a payload carrying `ordinal`, `truthClass`, `completedSteps` or a whole replacement
 * roster is refused STRUCTURALLY here — and, one layer above, by the seam's own
 * `checkPayload` allow-list at stage PAYLOAD_SHAPE.
 */

const REQUEST_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "expectedVersion", "kind", "payload",
  "principalId", "projectId", "schemaVersion",
] as const);

/** The SERVER's half: everything `requestOf` stamped, and nothing the payload said. */
interface StepEnvelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly principalId: string;
  readonly projectId: string;
}

/** The envelope plus the two identity keys every payload in the family carries. */
interface StepRequestIdentity extends StepEnvelope {
  readonly attemptAggregateId: string;
  readonly effectId: string;
}

export type StepLifecycleRequest =
  | (StepRequestIdentity & { readonly kind: typeof STEP_START_COMMAND_KIND;
    readonly label: string })
  | (StepRequestIdentity & { readonly kind: typeof STEP_FINISH_COMMAND_KIND;
    readonly stepRef: string })
  | (StepRequestIdentity & { readonly kind: typeof STEP_CHECKPOINT_COMMAND_KIND;
    readonly nextSafeActionRef: string });

const isStepKind = (value: unknown): value is StepLifecycleCommandKind =>
  value === STEP_START_COMMAND_KIND || value === STEP_FINISH_COMMAND_KIND
  || value === STEP_CHECKPOINT_COMMAND_KIND;

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** The envelope half, identical for every kind in the family. */
function envelopeOf(record: Record<string, unknown>): StepEnvelope | null {
  if (record["schemaVersion"] !== STEP_LIFECYCLE_SCHEMA_VERSION
    || !nonEmpty(record["commandId"]) || !nonEmpty(record["correlationId"])
    || !nonEmpty(record["principalId"]) || !nonEmpty(record["projectId"])
    || !nonEmpty(record["decidedAt"]) || Number.isNaN(Date.parse(record["decidedAt"]))) {
    return null;
  }
  return {
    commandId: record["commandId"], correlationId: record["correlationId"],
    decidedAt: record["decidedAt"], principalId: record["principalId"],
    projectId: record["projectId"],
  };
}

export function decodeStepRequest(
  input: unknown,
): StepLifecycleRequest | StepLifecycleRefused {
  const malformed = stepRefusal("STEP_REQUEST_MALFORMED");
  if (!(input instanceof Uint8Array)) return malformed;
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) return malformed;
  const record = exactKeys(decoded.value, REQUEST_KEYS);
  if (record === null) return malformed;
  const envelope = envelopeOf(record);
  if (envelope === null) return malformed;
  const kind = record["kind"];
  if (!isStepKind(kind)) return malformed;
  const payload = exactKeys(record["payload"], STEP_LIFECYCLE_PAYLOAD_KEYS[kind]);
  if (payload === null || !nonEmpty(payload["attemptAggregateId"])
    || !nonEmpty(payload["effectId"])) {
    return malformed;
  }
  const identity: StepRequestIdentity = {
    ...envelope, attemptAggregateId: payload["attemptAggregateId"],
    effectId: payload["effectId"],
  };
  if (kind === STEP_START_COMMAND_KIND) {
    return nonEmpty(payload["label"])
      ? Object.freeze({ ...identity, kind, label: payload["label"] }) : malformed;
  }
  if (kind === STEP_FINISH_COMMAND_KIND) {
    return nonEmpty(payload["stepRef"])
      ? Object.freeze({ ...identity, kind, stepRef: payload["stepRef"] }) : malformed;
  }
  return nonEmpty(payload["nextSafeActionRef"])
    ? Object.freeze({ ...identity, kind, nextSafeActionRef: payload["nextSafeActionRef"] })
    : malformed;
}
