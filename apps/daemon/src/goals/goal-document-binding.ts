import type { JsonValue } from "@moe/contracts";
import type { ExpectedVersionDecisionLeg } from "@moe/store";

import {
  DOCUMENT_SOURCE_EVENT_TYPE,
  DOCUMENT_SOURCE_SCHEMA_VERSION,
  MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES,
} from "../documents/document-source-contract.js";
import type {
  DocumentIngestMediaType,
  DocumentSourceRecord,
} from "../documents/document-source-contract.js";
import {
  encodeDocumentSourceRecord,
  isCanonicalText,
  isIngestMediaType,
  sha256Hex,
  utf8ByteLength,
} from "../documents/document-source-codec.js";
import { exactDataRecord } from "../documents/document-work-safe-value.js";
import {
  goalDocumentSourceAggregateId,
  goalDocumentSourceEventId,
} from "./goal-document-identifiers.js";

const PRD_KEYS = Object.freeze(["displayPath", "mediaType", "text"] as const);
const MAX_DISPLAY_PATH_CODE_UNITS = 256;

export const GOAL_PRD_REFUSAL_CODES = Object.freeze([
  "GOAL_PRD_INPUT_INVALID",
  "GOAL_PRD_MEDIA_TYPE_UNSUPPORTED",
  "GOAL_PRD_TEXT_TOO_LARGE",
] as const);

export type GoalPrdRefusalCode = (typeof GOAL_PRD_REFUSAL_CODES)[number];

export interface GoalPrdBinding {
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly displayPath: string;
  readonly mediaType: DocumentIngestMediaType;
  readonly sourceRef: string;
}

export type PreparedGoalPrd =
  | Readonly<{ readonly binding: GoalPrdBinding | null; readonly leg: ExpectedVersionDecisionLeg | null; readonly ok: true }>
  | Readonly<{ readonly code: GoalPrdRefusalCode; readonly ok: false }>;

function refused(code: GoalPrdRefusalCode): PreparedGoalPrd {
  return Object.freeze({ code, ok: false as const });
}

/**
 * Admits the optional operator PRD and prepares its goal-bound storage leg. The
 * returned leg is inert until the caller commits it beside GoalCreated in the
 * same expected-version decision.
 */
export function prepareGoalPrd(
  projectId: string,
  goalId: string,
  input: JsonValue | undefined,
): PreparedGoalPrd {
  if (input === null) return Object.freeze({ binding: null, leg: null, ok: true as const });
  const record = exactDataRecord(input, PRD_KEYS);
  if (record === null) return refused("GOAL_PRD_INPUT_INVALID");
  const { displayPath, mediaType, text } = record;
  if (!isCanonicalText(displayPath, true)
    || displayPath.length > MAX_DISPLAY_PATH_CODE_UNITS
    || typeof text !== "string") {
    return refused("GOAL_PRD_INPUT_INVALID");
  }
  if (typeof mediaType !== "string") return refused("GOAL_PRD_INPUT_INVALID");
  if (!isIngestMediaType(mediaType)) return refused("GOAL_PRD_MEDIA_TYPE_UNSUPPORTED");
  if (utf8ByteLength(text) > MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES) {
    return refused("GOAL_PRD_TEXT_TOO_LARGE");
  }
  if (!isCanonicalText(text, false)) return refused("GOAL_PRD_INPUT_INVALID");

  const byteLength = utf8ByteLength(text);
  const contentSha256 = sha256Hex(text);
  const sourceRef = goalDocumentSourceAggregateId(projectId, goalId, contentSha256);
  const source: DocumentSourceRecord = Object.freeze({
    byteLength,
    contentSha256,
    displayPath,
    mediaType,
    schemaVersion: DOCUMENT_SOURCE_SCHEMA_VERSION,
    text,
  });
  const binding: GoalPrdBinding = Object.freeze({
    byteLength, contentSha256, displayPath, mediaType, sourceRef,
  });
  const leg: ExpectedVersionDecisionLeg = Object.freeze({
    aggregateId: sourceRef,
    events: Object.freeze([Object.freeze({
      domainSchemaVersion: DOCUMENT_SOURCE_SCHEMA_VERSION,
      eventId: goalDocumentSourceEventId(projectId, goalId, contentSha256),
      eventType: DOCUMENT_SOURCE_EVENT_TYPE,
      outbox: Object.freeze([]),
      payload: encodeDocumentSourceRecord(source),
    })]),
    expectedVersion: 0,
  });
  return Object.freeze({ binding, leg, ok: true as const });
}
