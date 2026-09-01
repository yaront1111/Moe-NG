/**
 * The proposed graph BODY, admitted at `plan.propose` and carried on the same decision.
 *
 * A plan revision states a `graphContentHash`; until this seam existed, nothing on the production
 * path ever held the bytes that hash names, and `putGraphBody`'s only callers were tests. The
 * body arrives as a SIBLING of `authority` on the propose terminal — core's authority member is
 * exact-keyed to two names and refuses a third, so the body could not travel inside it.
 *
 * MANDATORY SINCE task-c96ef2d1, and the ordering was a safety constraint rather than tidiness.
 * cd1784ce landed this seam TOLERANT — an absent member meant "no body row, carry on" — because
 * every shipped sender still sealed a placeholder hash naming a graph nothing could produce, so
 * the ACCEPTED path had no production producer and only tests ever exercised it. Now that
 * `journeyAuthority` mints a real graph and all three senders carry its bytes, an absent member
 * is a caller bug rather than a legacy shape, and it is refused with this module's own
 * `PLANNING_GRAPH_CONTENT_REQUIRED` before any leg is composed. Flipping this before the senders
 * carried bytes would have stranded production, which is why it is the LAST change of the row.
 *
 * THE CALLER STATES NOTHING THIS MODULE TRUSTS. `decodeGraphContent` re-derives the node-authority
 * set and re-checks the digest, so the hash a body is stored under is the codec's verdict, never
 * the caller's claim; a body whose recompute disagrees with the revision's stated hash is refused.
 * That is what keeps "propose may carry bytes" compatible with "content bytes are never caller
 * authority": the bytes gain no authority by arriving.
 *
 * TWO OWN CODES ONLY. Everything the codec refuses travels out with the CODEC's code and the
 * CODEC's layer, unrestamped — a reader has to be able to tell which authority spoke, and a
 * daemon restatement would erase exactly that.
 *
 * THE LAYER CONSTANT IS MODULE-PRIVATE. The security roster counts every exported column-zero
 * `*_LAYER(S)` and would demand a BEFORE/AFTER/RACE trio for one; the closed TYPE is exported
 * instead and `bootstrap-ledger.ts` spells the literal, the convention this folder already uses.
 */

import { decodeGraphContent } from "@moe/scheduler";
import type { GraphContentIssue } from "@moe/scheduler";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import { GRAPH_BODY_EVENT_TYPE, graphBodyAggregateId } from "./graph-body-record.js";
import { ownValue } from "./planning-authority-finalize-ingress.js";

const LAYER = "PLANNING_GRAPH_CONTENT_INGRESS" as const;
const CONTENT_MEMBER = "graphContentBytesBase64";

export type PlanningGraphContentLayer = typeof LAYER;

export const PLANNING_GRAPH_CONTENT_CODES = Object.freeze([
  "PLANNING_GRAPH_CONTENT_HASH_MISMATCH",
  "PLANNING_GRAPH_CONTENT_MALFORMED",
  "PLANNING_GRAPH_CONTENT_REQUIRED",
] as const);
export type PlanningGraphContentCode = (typeof PLANNING_GRAPH_CONTENT_CODES)[number];

/** A codec refusal keeps its own layer, so the union is wider than this module's own. */
export type PlanningGraphContentRefusalLayer =
  | GraphContentIssue["layer"] | PlanningGraphContentLayer;

export type ProposedGraphContent =
  | { readonly kind: "PRESENT" }
  | { readonly kind: "LEG"; readonly leg: ExpectedVersionDecisionLeg }
  | {
    readonly code: PlanningGraphContentCode | GraphContentIssue["code"];
    readonly kind: "REFUSED";
    readonly layer: PlanningGraphContentRefusalLayer;
  };

export interface ProposedGraphContentInput {
  readonly lastCommand: unknown;
  readonly projectId: string;
  readonly statedGraphContentHash: string;
  readonly store: SqliteEventStore;
}

const refused = (
  code: PlanningGraphContentCode | GraphContentIssue["code"],
  layer: PlanningGraphContentRefusalLayer,
): ProposedGraphContent => Object.freeze({ code, kind: "REFUSED" as const, layer });

const malformed = (): ProposedGraphContent => refused("PLANNING_GRAPH_CONTENT_MALFORMED", LAYER);

/**
 * `Buffer.from(s, "base64")` NEVER throws: whitespace, url-safe alphabet and missing padding are
 * all decoded on a best-effort basis. Re-encoding and comparing is what makes the malformed arm
 * mean anything — and it is not only tidiness. The request bytes are folded into the decision's
 * identity, so admitting two spellings of the same body would turn a byte-identical retry into an
 * IDEMPOTENCY_CONFLICT instead of a replay.
 */
function canonicalBytes(member: unknown): Uint8Array | null {
  if (typeof member !== "string" || member.length === 0) return null;
  const bytes = Uint8Array.from(Buffer.from(member, "base64"));
  if (bytes.length === 0) return null;
  return Buffer.from(bytes).toString("base64") === member ? bytes : null;
}

/** The codec's first issue names both the code and the layer that actually refused. */
function passthrough(issues: readonly GraphContentIssue[]): ProposedGraphContent {
  const issue = issues[0];
  return issue === undefined
    ? malformed()
    : refused(issue.code, issue.layer);
}

/**
 * Admits the proposed body, or reports that the terminal carried none.
 *
 * The pre-read is load-bearing rather than an optimisation. Event ids are GLOBALLY unique in this
 * store, so emitting `graph-body-<hash>` a second time THROWS `DurableIdConflictError` instead of
 * refusing — the failure that blocked task-16a6a2b1. Two runs sharing one graph is the reachable
 * shape of that collision, since the body aggregate is keyed by (project, content) and not by run.
 */
export function admitProposedGraphContent(
  input: ProposedGraphContentInput,
): ProposedGraphContent {
  const member = ownValue(input.lastCommand, CONTENT_MEMBER);
  if (member === undefined) return refused("PLANNING_GRAPH_CONTENT_REQUIRED", LAYER);
  const bytes = canonicalBytes(member);
  if (bytes === null) return malformed();
  const decoded = decodeGraphContent(bytes);
  if (!decoded.ok) return passthrough(decoded.issues);
  const hash = decoded.value.graphContentHash;
  if (hash !== input.statedGraphContentHash) {
    return refused("PLANNING_GRAPH_CONTENT_HASH_MISMATCH", LAYER);
  }
  const aggregateId = graphBodyAggregateId(input.projectId, hash);
  if (input.store.readEvents(aggregateId).length > 0) {
    return Object.freeze({ kind: "PRESENT" as const });
  }
  return Object.freeze({
    kind: "LEG" as const,
    leg: Object.freeze({
      aggregateId,
      events: Object.freeze([Object.freeze({
        eventId: `graph-body-${hash}`,
        eventType: GRAPH_BODY_EVENT_TYPE,
        payload: decoded.value.bytes,
      })]),
      expectedVersion: input.store.getAggregateVersion(aggregateId),
    }),
  });
}
