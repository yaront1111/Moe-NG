/**
 * `graph.preview` behind the SAME gate as `graph.get`, and nothing more.
 *
 * WHY A SEPARATE FILE. This is a line-budget split, not a second security
 * posture: the gate is imported from `graph-query.ts` rather than restated, so
 * the two entries cannot drift into different orders while both stay green —
 * which is the whole hazard `graph-query.ts`'s own header warns about. Adding
 * this entry inline put that file at 286 physical lines, past the 250 target.
 *
 * ZERO AUTHORITY. The preview analyses a snapshot the CALLER supplied and reads
 * nothing durable, so it takes no `GraphQueryPort` and cannot reach this
 * daemon's store at all. It is authenticated anyway because it sits beside
 * `graph.get` on one advertised surface: an advisory endpoint answering
 * unauthenticated would be a free probe of which daemons are up and what they
 * accept, and the two siblings' refusal shapes would stop matching.
 *
 * WHY THE BODY IS RE-ENCODED. `evaluateGraphPreviewRequestBytes` owns decoding,
 * bounds AND prototype hardening — its admission check requires a null-prototype
 * object, which is what bounded JSON decoding produces and what a transport's
 * own `JSON.parse` never does. Handing it an already-parsed value would be
 * refused on the prototype alone, so the bytes are reconstituted here and the
 * evaluator stays the single authority on what a preview request is.
 *
 * ITS VERDICT IS RETURNED UNRESTAMPED. Two layers can refuse here and a caller
 * tells them apart by shape: the gate answers with a GRAPH_QUERY code and that
 * layer, the evaluator with its own advisory envelope carrying
 * `authority: "NONE"` and no layer at all. Flattening one into the other would
 * erase which of them said no.
 */

import { evaluateGraphPreviewRequestBytes } from "../graph-preview-request.js";
import type { GraphPreviewRequestResult } from "../graph-preview-request.js";
import type { HttpAccessResult } from "../http/http-adapter.js";
import type { Authenticator } from "../http/http-contract.js";
import { gateGraphQuery } from "./graph-query.js";
import type { GraphQueryRefusal } from "./graph-query.js";

const ENCODER = new TextEncoder();

/** Three possible answers, and each keeps the shape of whoever refused. */
export type GraphPreviewQueryResult =
  | GraphPreviewRequestResult
  | GraphQueryRefusal
  | Exclude<HttpAccessResult, { readonly ok: true }>;

export interface GraphPreviewQueryRequest {
  readonly authenticator: Authenticator;
  readonly body: unknown;
  readonly credential: string | null;
  readonly protocolVersion: unknown;
}

export function answerGraphPreviewQuery(
  request: GraphPreviewQueryRequest,
): GraphPreviewQueryResult {
  const gated = gateGraphQuery(
    request.authenticator,
    request.credential,
    request.protocolVersion,
  );
  if (!gated.ok) return gated;
  return evaluateGraphPreviewRequestBytes(
    ENCODER.encode(JSON.stringify(request.body ?? null)),
  );
}
