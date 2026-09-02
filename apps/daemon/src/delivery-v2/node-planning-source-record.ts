import {
  createNodePlanningSourceContent,
  decodeNodePlanningSourceContentBytes,
  encodeNodePlanningSourceContent,
  type NodePlanningSourceContent,
  type NodePlanningSourceIssue,
} from "@moe/scheduler";

import { deliveryV2Digest } from "./addresses.js";
import { admitDeliveryV2MaterialPublisherPrincipalId }
  from "./material-publisher-admission.js";
import { snapshotDeliveryV2PlainData } from "./snapshot.js";

export const DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION =
  "moe-planner-authored-node-planning-source/1" as const;
export const DELIVERY_V2_NODE_PLANNING_SOURCE_REVISION_DIGEST_DOMAIN =
  "moe-delivery-v2-node-planning-source-revision/1" as const;

export interface DeliveryV2NodePlanningSourceRecord {
  readonly authorRef: string;
  readonly nodeKey: string;
  readonly revisionDigest: string;
  readonly source: NodePlanningSourceContent;
  readonly sourceDigest: string;
  readonly version: typeof DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION;
}
const RECORD_CODES = Object.freeze([
  "DELIVERY_V2_NODE_PLANNING_SOURCE_AUTHOR_INVALID",
  "DELIVERY_V2_NODE_PLANNING_SOURCE_NODE_INVALID",
  "DELIVERY_V2_NODE_PLANNING_SOURCE_RECORD_DIGEST_MISMATCH",
  "DELIVERY_V2_NODE_PLANNING_SOURCE_RECORD_MALFORMED",
] as const);
type DeliveryV2NodePlanningSourceRecordCode = (typeof RECORD_CODES)[number];
interface DeliveryV2NodePlanningSourceRecordIssue {
  readonly code: DeliveryV2NodePlanningSourceRecordCode;
  readonly layer: "DELIVERY_V2_NODE_PLANNING_SOURCE_RECORD";
  readonly message: string;
}
export type DeliveryV2NodePlanningSourceRecordResult = Readonly<{
  readonly ok: true; readonly record: DeliveryV2NodePlanningSourceRecord;
}> | Readonly<{
  readonly issues: readonly (DeliveryV2NodePlanningSourceRecordIssue | NodePlanningSourceIssue)[];
  readonly ok: false;
}>;
export type DeliveryV2NodePlanningSourceRecordBytesResult = Readonly<{
  readonly bytes: Uint8Array; readonly ok: true;
}> | Exclude<DeliveryV2NodePlanningSourceRecordResult, { readonly ok: true }>;

const RECORD_KEYS = Object.freeze([
  "authorRef", "nodeKey", "revisionDigest", "source", "sourceDigest", "version",
]);

function issue(
  code: DeliveryV2NodePlanningSourceRecordCode,
  message: string,
): DeliveryV2NodePlanningSourceRecordResult {
  return Object.freeze({ issues: Object.freeze([Object.freeze({
    code, layer: "DELIVERY_V2_NODE_PLANNING_SOURCE_RECORD", message,
  })]), ok: false as const });
}

function author(value: unknown): string | undefined {
  const admitted = admitDeliveryV2MaterialPublisherPrincipalId(value);
  return admitted !== undefined && admitted.isWellFormed() && !admitted.includes("\0")
    ? admitted : undefined;
}

function revisionDigestOf(authorRef: string, nodeKey: string, sourceDigest: string): string {
  return deliveryV2Digest(
    DELIVERY_V2_NODE_PLANNING_SOURCE_REVISION_DIGEST_DOMAIN,
    DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION,
    authorRef,
    nodeKey,
    sourceDigest,
  );
}

export function createDeliveryV2NodePlanningSourceRecord(
  authorValue: unknown,
  sourceValue: unknown,
): DeliveryV2NodePlanningSourceRecordResult {
  const authorRef = author(authorValue);
  if (authorRef === undefined) return issue(
    "DELIVERY_V2_NODE_PLANNING_SOURCE_AUTHOR_INVALID", "author is not admissible",
  );
  const created = createNodePlanningSourceContent(sourceValue);
  if (!created.ok) return created;
  const nodeKey = created.content.planExecutionContent.affectedNodeIds[0];
  if (nodeKey === undefined) return issue(
    "DELIVERY_V2_NODE_PLANNING_SOURCE_NODE_INVALID", "source has no intrinsic node",
  );
  const record = Object.freeze({
    authorRef,
    nodeKey,
    revisionDigest: revisionDigestOf(authorRef, nodeKey, created.sourceDigest),
    source: created.content,
    sourceDigest: created.sourceDigest,
    version: DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION,
  });
  return Object.freeze({ ok: true as const, record });
}

function readRecord(value: unknown): DeliveryV2NodePlanningSourceRecord | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  if (safe === undefined || safe === null || typeof safe !== "object" || Array.isArray(safe)
    || Object.keys(safe).length !== RECORD_KEYS.length
    || !RECORD_KEYS.every((key) => Object.hasOwn(safe, key))) return undefined;
  return safe as unknown as DeliveryV2NodePlanningSourceRecord;
}

function admitRecord(value: unknown): DeliveryV2NodePlanningSourceRecordResult {
  const candidate = readRecord(value);
  if (candidate === undefined) return issue(
    "DELIVERY_V2_NODE_PLANNING_SOURCE_RECORD_MALFORMED", "record shape is malformed",
  );
  const created = createDeliveryV2NodePlanningSourceRecord(
    candidate.authorRef, candidate.source,
  );
  if (!created.ok) return created;
  const expected = created.record;
  return candidate.nodeKey === expected.nodeKey
    && candidate.revisionDigest === expected.revisionDigest
    && candidate.sourceDigest === expected.sourceDigest
    && candidate.version === expected.version
    ? created
    : issue("DELIVERY_V2_NODE_PLANNING_SOURCE_RECORD_DIGEST_MISMATCH",
      "record identities do not match its admitted source");
}

/** Record bytes are the Scheduler codec bytes verbatim; authorship lives in event provenance. */
export function encodeDeliveryV2NodePlanningSourceRecord(
  value: unknown,
): DeliveryV2NodePlanningSourceRecordBytesResult {
  const admitted = admitRecord(value);
  if (!admitted.ok) return admitted;
  const encoded = encodeNodePlanningSourceContent(admitted.record.source);
  return encoded.ok ? Object.freeze({ bytes: new Uint8Array(encoded.bytes), ok: true as const })
    : encoded;
}

export function decodeDeliveryV2NodePlanningSourceRecord(
  bytes: unknown,
  authorRef: unknown,
): DeliveryV2NodePlanningSourceRecordResult {
  const decoded = decodeNodePlanningSourceContentBytes(bytes);
  return decoded.ok
    ? createDeliveryV2NodePlanningSourceRecord(authorRef, decoded.content)
    : decoded;
}
