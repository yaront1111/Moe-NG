import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

import {
  WORK_COMMANDS,
  WORK_SCHEMA_VERSION,
  inputRejected,
  refused,
  workFailure,
} from "./work-kernel.js";
import type { WorkCommand, WorkResult } from "./work-kernel.js";

/**
 * The byte boundary for the work command family.
 *
 * Exactly two ordered phases run here: bounded JSON decoding, then exact
 * own-key envelope validation. Composition is deliberately NOT this module's
 * job — it is a boundary, not a router. There is no HTTP, auth, transport,
 * persistence, approval, provider execution, or next-command affordance in
 * this file, and none may be added (graph-preview boundary precedent).
 */

/** The complete key set; an envelope with any other key is refused. */
const REQUEST_KEYS = Object.freeze(["command", "payload", "schemaVersion"]);

const REQUEST_INVALID_MESSAGE =
  `Work request must match ${WORK_SCHEMA_VERSION} exactly.` as const;

export interface WorkRequestEnvelope {
  readonly schemaVersion: typeof WORK_SCHEMA_VERSION;
  readonly command: WorkCommand;
  readonly payload: JsonValue;
}

export type WorkRequestParse =
  | { readonly ok: true; readonly envelope: WorkRequestEnvelope }
  | { readonly ok: false; readonly result: WorkResult };

function isWorkCommand(value: unknown): value is WorkCommand {
  return typeof value === "string" && (WORK_COMMANDS as readonly string[]).includes(value);
}

/**
 * Exact own-key validation against a decoder-produced value.
 *
 * The null-prototype requirement is inherited from the decoder, which only
 * ever emits null-prototype objects; enforcing it here means a value that
 * reached this function by any other route is refused rather than trusted.
 */
export function isExactWorkRequest(value: JsonValue): value is JsonObject & {
  readonly schemaVersion: typeof WORK_SCHEMA_VERSION;
  readonly command: WorkCommand;
  readonly payload: JsonValue;
} {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  if (Object.getPrototypeOf(value) !== null) return false;

  const request = value as JsonObject;
  const keys = Object.keys(request);
  if (keys.length !== REQUEST_KEYS.length) return false;
  if (keys.some((key) => !REQUEST_KEYS.includes(key))) return false;

  return (
    Object.hasOwn(request, "schemaVersion") &&
    request["schemaVersion"] === WORK_SCHEMA_VERSION &&
    Object.hasOwn(request, "payload") &&
    Object.hasOwn(request, "command") &&
    isWorkCommand(request["command"])
  );
}

function requestInvalid(): WorkResult {
  return refused(
    workFailure("WORK_REQUEST_INVALID", null, "INGRESS", REQUEST_INVALID_MESSAGE),
    "REQUEST_INVALID",
  );
}

/**
 * Decodes bytes and validates the envelope. Returns the validated envelope for
 * a caller to compose, or a frozen refusal that no authority path has touched.
 */
export function parseWorkRequest(input: unknown): WorkRequestParse {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) {
    return { ok: false, result: inputRejected(decoded) };
  }
  if (!isExactWorkRequest(decoded.value)) {
    return { ok: false, result: requestInvalid() };
  }
  return {
    ok: true,
    envelope: Object.freeze({
      command: decoded.value["command"],
      payload: decoded.value["payload"],
      schemaVersion: WORK_SCHEMA_VERSION,
    }),
  };
}
