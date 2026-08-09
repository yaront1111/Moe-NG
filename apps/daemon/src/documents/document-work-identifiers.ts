import { createHash } from "node:crypto";

const encoder = new TextEncoder();
const AGGREGATE_PREFIX = "document-work/";
const EVENT_PREFIX = "document-work-proposal/";
const AGGREGATE_ID_DOMAIN = "moe.document-work.aggregate-id.v1";
const EVENT_ID_DOMAIN = "moe.document-work.event-id.v1";

function framedDigest(domain: string, values: readonly string[]): string {
  const hash = createHash("sha256").update(`${domain}\u0000`, "utf8");
  for (const value of values) {
    const valueBytes = encoder.encode(value);
    hash.update(`${String(valueBytes.byteLength)}:`, "ascii").update(valueBytes);
  }
  return hash.digest("hex");
}

export function documentWorkAggregateId(projectId: string): string {
  return `${AGGREGATE_PREFIX}${framedDigest(AGGREGATE_ID_DOMAIN, [projectId])}`;
}

export function documentWorkEventId(
  projectId: string,
  principalId: string,
  commandId: string,
): string {
  return `${EVENT_PREFIX}${framedDigest(
    EVENT_ID_DOMAIN,
    [projectId, principalId, commandId],
  )}`;
}
