/**
 * The refusal vocabulary of the graph-content codec: which layer answered, which
 * stable code it answered with, and the two shapes that build a refusal.
 *
 * Separate from `graph-content.ts` so the codec boundary, the field contract and
 * the reason vocabulary each stay inside the per-file line cap without any guard
 * being trimmed to fit. A structural graph failure never acquires a code from
 * here: {@link passthrough} carries the graph kernel's own {@link GraphIssueCode}
 * out unchanged and only adds the layer.
 */
import type { GraphIssue, GraphIssueCode, GraphKey } from "./graph-model.js";
import type {
  NodeAuthorityRecursionIssue,
  NodeAuthorityRecursionLayer,
} from "./node-authority/node-authority-recursion.js";

/** Which layer THIS codec answers under. Closed and frozen. */
export const GRAPH_CONTENT_LAYERS = Object.freeze([
  "GRAPH_CONTENT_CODEC", "GRAPH_CONTENT_IDENTITY", "GRAPH_VALIDATION",
] as const);
/** The only layers {@link refuse} may file: the ones this codec owns. */
export type GraphContentOwnLayer = (typeof GRAPH_CONTENT_LAYERS)[number];
/**
 * What a READER may observe, which since v3 is strictly wider than what this codec
 * OWNS: a foreign authority's layer travels out unrestamped, so a consumer that
 * switched exhaustively over the three-member roster would silently mishandle a
 * real refusal. The constant stays the closed set this codec answers under — the
 * type is what the seam can hand back.
 */
export type GraphContentLayer = GraphContentOwnLayer | NodeAuthorityRecursionLayer;

/**
 * Framing, field and identity codes owned by THIS codec. A structural graph
 * failure never appears here — it keeps its own {@link GraphIssueCode}.
 *
 * `GRAPH_CONTENT_FIELD_INVALID` covers a caller-stated content field that is
 * absent, out of bounds, or not a plain data property.
 * `GRAPH_CONTENT_COMPLETION_DRIFT` covers the one fact stated twice — the
 * author's declared completion node against the accepted graph's — disagreeing.
 * `GRAPH_CONTENT_AUTHORITY_DISAGREEMENT` covers the v3 equivalent: a stated
 * `nodeAuthority` set that is not the set the production composer derives from
 * the very definitions beside it. It is a codec verdict because no single foreign
 * authority can see both halves; every reason a body or an edge is inadmissible
 * keeps the composer's own code through {@link authorityPassthrough}.
 */
export const GRAPH_CONTENT_ISSUE_CODES = Object.freeze([
  "GRAPH_CONTENT_AUTHORITY_DISAGREEMENT", "GRAPH_CONTENT_COMPLETION_DRIFT",
  "GRAPH_CONTENT_DIGEST_MISMATCH",
  "GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_MALFORMED",
  "GRAPH_CONTENT_NONCANONICAL", "GRAPH_CONTENT_NOT_BYTES",
  "GRAPH_CONTENT_TOO_LARGE", "GRAPH_CONTENT_UNREADABLE",
  "GRAPH_CONTENT_UNSUPPORTED_SCHEMA",
] as const);
export type GraphContentIssueCode = (typeof GRAPH_CONTENT_ISSUE_CODES)[number];

/**
 * Both halves widen for one reason: a foreign authority's verdict travels out
 * unrestamped, which is the only way a reader can tell WHICH of the authorities on
 * this seam refused. `code` is named by provenance rather than as a bare `string`
 * because the composer's own code type is already open — IT passes the node codec's
 * codes through — so spelling it this way records where the openness comes from.
 */
export interface GraphContentIssue {
  readonly code: GraphContentIssueCode | GraphIssueCode | NodeAuthorityRecursionIssue["code"];
  readonly layer: GraphContentLayer;
  readonly message: string;
  readonly nodeKeys: readonly GraphKey[];
  readonly edgeKeys: readonly GraphKey[];
}

/** The refusal half of a codec result; never carries content authority. */
export interface GraphContentRefusal {
  readonly ok: false;
  readonly issues: readonly GraphContentIssue[];
}

/**
 * Each code this codec owns is answered by exactly ONE layer, so the binding lives
 * here beside the vocabulary rather than being restated at every call site, where
 * one typo could file a framing failure under the identity layer and mislead every
 * reader downstream. {@link refuse} reads this table; nothing else picks a layer.
 */
export const GRAPH_CONTENT_ISSUE_LAYER: Readonly<
  Record<GraphContentIssueCode, GraphContentOwnLayer>
> = Object.freeze({
  GRAPH_CONTENT_AUTHORITY_DISAGREEMENT: "GRAPH_CONTENT_IDENTITY",
  GRAPH_CONTENT_COMPLETION_DRIFT: "GRAPH_CONTENT_IDENTITY",
  GRAPH_CONTENT_DIGEST_MISMATCH: "GRAPH_CONTENT_IDENTITY",
  GRAPH_CONTENT_FIELD_INVALID: "GRAPH_CONTENT_CODEC",
  GRAPH_CONTENT_MALFORMED: "GRAPH_CONTENT_CODEC",
  GRAPH_CONTENT_NONCANONICAL: "GRAPH_CONTENT_IDENTITY",
  GRAPH_CONTENT_NOT_BYTES: "GRAPH_CONTENT_CODEC",
  GRAPH_CONTENT_TOO_LARGE: "GRAPH_CONTENT_CODEC",
  GRAPH_CONTENT_UNREADABLE: "GRAPH_CONTENT_CODEC",
  GRAPH_CONTENT_UNSUPPORTED_SCHEMA: "GRAPH_CONTENT_CODEC",
});

export function refuse(code: GraphContentIssueCode, message: string): GraphContentRefusal {
  return Object.freeze({
    ok: false as const,
    issues: Object.freeze([Object.freeze({
      code, layer: GRAPH_CONTENT_ISSUE_LAYER[code], message,
      nodeKeys: Object.freeze([]), edgeKeys: Object.freeze([]),
    })]),
  });
}

/**
 * Surface the NodeAuthority composer's verdict unchanged — code AND layer, so a
 * graph-structure refusal, a body-admission refusal and a closure refusal stay
 * distinguishable after they cross into this codec. The key sets are empty
 * because the composer names its subjects in the message, not as graph keys.
 */
export function authorityPassthrough(
  issues: readonly NodeAuthorityRecursionIssue[],
): GraphContentRefusal {
  return Object.freeze({
    ok: false as const,
    issues: Object.freeze(issues.map((issue) => Object.freeze({
      code: issue.code,
      layer: issue.layer,
      message: issue.message,
      nodeKeys: Object.freeze([]),
      edgeKeys: Object.freeze([]),
    }))),
  });
}

/** Surface the validator's verdict unchanged; only the layer is added. */
export function passthrough(issues: readonly GraphIssue[]): GraphContentRefusal {
  return Object.freeze({
    ok: false as const,
    issues: Object.freeze(issues.map((issue) => Object.freeze({
      code: issue.code,
      layer: "GRAPH_VALIDATION" as const,
      message: issue.message,
      nodeKeys: issue.nodeKeys,
      edgeKeys: issue.edgeKeys,
    }))),
  });
}
