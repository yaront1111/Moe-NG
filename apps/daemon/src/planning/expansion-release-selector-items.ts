/**
 * THE DIGEST-BOUND CANONICAL ITEMS of one sealed Foundation context manifest, and the
 * server-derived facts they must agree with (task-671cdd10).
 *
 * SEPARATE FROM THE SCAN BY CONSTRUCTION. The scan owns the WALK — paging, ordering,
 * completeness — and this module owns the JUDGEMENT of a single row's payload. Keeping
 * them apart is what lets the walk stay readable at a glance and holds both files under
 * the repository's per-file size target.
 *
 * EXACTLY ONE of each mandatory item, and a `null` answer for anything else. A missing
 * item leaves the join unprovable and a duplicate leaves it ambiguous; neither is a
 * statement about which parent the row belongs to, so both refuse UNREADABLE upstream
 * rather than being reported as a binding mismatch.
 *
 * TWO `planHash` FACTS, NEVER COMPARED TO EACH OTHER. The graph revision's hash and the
 * approved plan's hash are rendered from independent authorities (context matrix
 * :214-218); each is checked against its OWN server-derived expectation.
 */

import type { FoundationContextManifestRecord }
  from "../work/foundation-context-manifest-codec.js";

/** The server-derived facts a row must agree with to be about THIS parent. Every member
 *  is read from a durable authority upstream; none comes from the caller's payload. */
export interface ExpansionReleaseLocatorExpectation {
  /** The APPROVED PLAN's own hash, which is NOT the graph revision's `planHash`. */
  readonly approvedPlanHash: string;
  readonly goalRef: string;
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly graphRevisionRef: string;
  readonly parentNodeRef: string;
  readonly parentRunRef: string;
  readonly planHash: string;
  readonly projectId: string;
}

export type ExpansionReleaseLocatorItems =
  ReadonlyMap<string, Readonly<Record<string, unknown>>>;

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The four canonical items this join reads, with the section each is rendered under.
 *  Both halves are compared: an item id under the wrong section is a different item. */
const MANDATORY_ITEMS = Object.freeze([
  ["foundation.graph", "graph"], ["foundation.approved-plan", "plan"],
  ["foundation.objective", "objective"], ["foundation.activation", "authority"],
] as const);

const objectOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;

const textOf = (record: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * The digest-bound canonical items, keyed by id, or `null` when the bytes are not the
 * newline-delimited canonical rendering this join requires.
 *
 * EXACTLY ONE of each mandatory item. A missing one leaves the join unprovable and a
 * duplicate leaves it ambiguous; both are `null` here and refuse UNREADABLE upstream,
 * because neither is a statement about which parent the row belongs to.
 */
export function canonicalItems(
  exactBytes: readonly number[],
): ExpansionReleaseLocatorItems | null {
  if (exactBytes.length === 0 || exactBytes.includes(0)) return null;
  let text: string;
  try { text = decoder.decode(Uint8Array.from(exactBytes)); } catch { return null; }
  const seen = new Map<string, Readonly<Record<string, unknown>>>();
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return null; }
    const item = objectOf(parsed);
    if (item === null) return null;
    const id = textOf(item, "id");
    const section = textOf(item, "section");
    const content = item["content"];
    if (id === null || section === null || typeof content !== "string") return null;
    const wanted = MANDATORY_ITEMS.find(([name]) => name === id);
    if (wanted === undefined) continue;
    if (item["kind"] !== "MANDATORY" || section !== wanted[1]) return null;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    let body: unknown;
    try { body = JSON.parse(content); } catch { return null; }
    const record = objectOf(body);
    if (record === null) return null;
    seen.set(id, record);
  }
  return MANDATORY_ITEMS.every(([id]) => counts.get(id) === 1) ? seen : null;
}

/** Whether the OUTER record names this parent's project, node and current graph. Only a
 *  row that does is judged against the expectation; anything else is a legitimately
 *  unrelated seal, and it is skipped only after the verification above has passed. */
export function namesThisParent(
  record: FoundationContextManifestRecord, expected: ExpansionReleaseLocatorExpectation,
): boolean {
  return record.projectId === expected.projectId && record.nodeKey === expected.parentNodeRef
    && record.graphRevisionRef === expected.graphRevisionRef
    && record.graphContentHash === expected.graphContentHash
    && record.graphEpoch === expected.graphEpoch;
}

/**
 * The four items against the outer record and the server's own facts. A row that names
 * this parent must agree on EVERY edge; one disagreement is a cross-splice, never a
 * reason to look at the next row.
 */
export function itemsAgree(
  items: ExpansionReleaseLocatorItems, record: FoundationContextManifestRecord,
  expected: ExpansionReleaseLocatorExpectation,
): boolean {
  const graph = items.get("foundation.graph");
  const plan = items.get("foundation.approved-plan");
  const objective = items.get("foundation.objective");
  const activation = items.get("foundation.activation");
  if (graph === undefined || plan === undefined) return false;
  if (objective === undefined || activation === undefined) return false;
  return graph["goalRef"] === expected.goalRef
    && graph["revisionId"] === record.graphRevisionRef
    && graph["graphContentHash"] === record.graphContentHash
    && graph["graphEpoch"] === record.graphEpoch
    && graph["planHash"] === expected.planHash
    && plan["runId"] === expected.parentRunRef
    && plan["graphRevisionRef"] === record.graphRevisionRef
    && plan["planHash"] === expected.approvedPlanHash
    && objective["nodeKey"] === record.nodeKey
    && activation["attemptRef"] === record.attemptRef
    && activation["ownerSessionRef"] === record.sessionId;
}

