import { decodeBoundedJsonBytes } from "@moe/contracts";
import { previewGraphSnapshot } from "@moe/scheduler";
import type { BoundedJsonDecodeError, JsonObject, JsonValue } from "@moe/contracts";
import type { GraphPreviewOptions, GraphPreviewResult } from "@moe/scheduler";

const SCHEMA_VERSION = "moe-graph-preview-request/1";
const REQUEST_KEYS = Object.freeze(["options", "schemaVersion", "snapshot"]);

export interface GraphPreviewRequestError {
  readonly code: "GRAPH_PREVIEW_REQUEST_INVALID";
  readonly message: "Graph preview request must match moe-graph-preview-request/1 exactly.";
}

interface AdvisoryEnvelope {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
}

export interface GraphPreviewInputRejected extends AdvisoryEnvelope {
  readonly ok: false;
  readonly outcome: "INPUT_REJECTED";
  readonly error: BoundedJsonDecodeError;
}

export interface GraphPreviewRequestInvalid extends AdvisoryEnvelope {
  readonly ok: false;
  readonly outcome: "REQUEST_INVALID";
  readonly error: GraphPreviewRequestError;
}

export interface GraphPreviewRequestEvaluated extends AdvisoryEnvelope {
  readonly ok: true;
  readonly outcome: "REQUEST_EVALUATED";
  readonly preview: GraphPreviewResult;
}

export type GraphPreviewRequestResult =
  | GraphPreviewInputRejected
  | GraphPreviewRequestInvalid
  | GraphPreviewRequestEvaluated;

const REQUEST_INVALID_ERROR: GraphPreviewRequestError = Object.freeze({
  code: "GRAPH_PREVIEW_REQUEST_INVALID",
  message: "Graph preview request must match moe-graph-preview-request/1 exactly.",
});

const REQUEST_INVALID_RESULT: GraphPreviewRequestInvalid = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  error: REQUEST_INVALID_ERROR,
  ok: false,
  outcome: "REQUEST_INVALID",
});

function isExactRequest(
  value: JsonValue,
): value is JsonObject & {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly snapshot: JsonValue;
} {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  if (Object.getPrototypeOf(value) !== null) return false;

  const request = value as JsonObject;
  const keys = Object.keys(request);
  if (keys.length < 2 || keys.length > REQUEST_KEYS.length) return false;
  if (keys.some((key) => !REQUEST_KEYS.includes(key))) return false;

  return (
    Object.hasOwn(request, "schemaVersion") &&
    request.schemaVersion === SCHEMA_VERSION &&
    Object.hasOwn(request, "snapshot")
  );
}

/**
 * Composes bounded JSON decoding with a zero-authority graph preview.
 * This advisory operation is not a command or admission boundary.
 */
export function evaluateGraphPreviewRequestBytes(
  input: unknown,
): GraphPreviewRequestResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) {
    return Object.freeze({
      advisoryOnly: true,
      authority: "NONE",
      error: decoded,
      ok: false,
      outcome: "INPUT_REJECTED",
    });
  }
  if (!isExactRequest(decoded.value)) return REQUEST_INVALID_RESULT;

  const options: unknown = Object.hasOwn(decoded.value, "options")
    ? decoded.value.options
    : undefined;
  const preview = previewGraphSnapshot(
    decoded.value.snapshot,
    options as GraphPreviewOptions | undefined,
  );
  return Object.freeze({
    advisoryOnly: true,
    authority: "NONE",
    ok: true,
    outcome: "REQUEST_EVALUATED",
    preview,
  });
}
