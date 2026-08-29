import { createHash } from "node:crypto";

const encoder = new TextEncoder();
const SOURCE_AGGREGATE_PREFIX = "document-source/";
const SOURCE_EVENT_PREFIX = "document-source-text/";
const GOAL_SOURCE_AGGREGATE_ID_DOMAIN = "moe.goal-document-source.aggregate-id.v1";
const GOAL_SOURCE_EVENT_ID_DOMAIN = "moe.goal-document-source.event-id.v1";

function framedDigest(domain: string, values: readonly string[]): string {
  const hash = createHash("sha256").update(`${domain}\0`, "utf8");
  for (const value of values) {
    const bytes = encoder.encode(value);
    hash.update(`${String(bytes.byteLength)}:`, "ascii").update(bytes);
  }
  return hash.digest("hex");
}

export function goalDocumentSourceAggregateId(
  projectId: string,
  goalId: string,
  contentSha256: string,
): string {
  return `${SOURCE_AGGREGATE_PREFIX}${framedDigest(
    GOAL_SOURCE_AGGREGATE_ID_DOMAIN, [projectId, goalId, contentSha256],
  )}`;
}

export function goalDocumentSourceEventId(
  projectId: string,
  goalId: string,
  contentSha256: string,
): string {
  return `${SOURCE_EVENT_PREFIX}${framedDigest(
    GOAL_SOURCE_EVENT_ID_DOMAIN, [projectId, goalId, contentSha256],
  )}`;
}
