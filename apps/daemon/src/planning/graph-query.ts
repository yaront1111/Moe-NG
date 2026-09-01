/**
 * "What is the current active graph?" — the one authenticated answer, shared by
 * both transports.
 *
 * ONE GUARD SEQUENCE, TWO ENTRIES. MCP calls `answerGraphQuery`; HTTP calls
 * `gateGraphQuery` before it decodes a byte and `answerGatedGraphQuery` after.
 * Both paths run the SAME `authenticateHttpRequest` the command path uses, so
 * the committed order (authenticate -> compatibility -> capability) is shared
 * rather than copied. A second copy in a transport is exactly how one seam's
 * guard order drifts from the other's while both stay green.
 *
 * THE PROJECT IS A SERVER FACT, NEVER A REQUEST FIELD. It comes from
 * `principal.projectId` and is cross-checked against the port's `boundProjectId`.
 * A body MAY name a project, but only its own: naming any other is refused
 * BEFORE the reader is called, so a refusal cannot leak whether another
 * project's graph exists. Both halves matter — the principal check stops a
 * caller reading a project it is not authenticated for, and the bound check
 * stops a principal from a different project being served by this daemon at all.
 *
 * CAPABILITY: `planning.write` (`CAPABILITIES.PLANNING`), an EXISTING constant,
 * not a new one. The vocabulary has no read-only capability; graph revisions are
 * planning authority — `plan.propose` and `approval.decide` both map to PLANNING
 * — so the authority that proposes and approves a graph is the authority that
 * may read the active one.
 *
 * THE READER'S REFUSAL IS PASSED THROUGH WHOLE. `code`, `layer`, `sourceCode`
 * and `sourceLayer` travel verbatim. That quadruple exists precisely so a caller
 * can tell which layer answered; flattening it would make ACTIVE_GRAPH_ABSENT
 * indistinguishable from a body record that is missing versus corrupt.
 *
 * NAMES ARE LOAD-BEARING (dec-64b2391c). `graphContentHash` is the
 * domain-separated digest over all seven content fields; `snapshotIdentity`
 * covers the STRUCTURE alone. Both are 64-char hex and they are carried side by
 * side, so assigning either from the other typechecks and reads as tidy while
 * binding a durable revision to an identity that omits six fields. They are
 * copied field-for-field from the reader's answer and never cross-assigned.
 */

import { PROJECT_CONFIGURATION_MAX_REF_CHARS, createRuntimeError } from "@moe/contracts";
import type { GraphSnapshot } from "@moe/scheduler";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { authenticateHttpRequest } from "../http/http-adapter.js";
import type { HttpAccessResult } from "../http/http-adapter.js";
import type { AuthenticatedPrincipal, Authenticator } from "../http/http-contract.js";
import type { ActiveGraphProvenance, ActiveGraphResult } from "./active-graph-projection.js";

/** Names this module as the layer that answered. */
const GRAPH_QUERY_LAYER = "GRAPH_QUERY" as const;

/**
 * Refusals this module ORIGINATES. The reader's own codes are passed through
 * unchanged and are deliberately not merged in here: a caller tells the two
 * apart by layer, and merging would let a projection change silently widen this
 * module's contract.
 */
export const GRAPH_QUERY_CODES = Object.freeze([
  "GRAPH_QUERY_CAPABILITY_DENIED",
  "GRAPH_QUERY_PROJECT_MISMATCH",
  "GRAPH_QUERY_READ_FAILED",
  "GRAPH_QUERY_REQUEST_INVALID",
  "GRAPH_QUERY_UNAVAILABLE",
] as const);

export type GraphQueryCode = (typeof GRAPH_QUERY_CODES)[number];

/**
 * ONE READER AND THE BOUND PROJECT. No commit, no store handle, no writer:
 * "this query writes nothing" is a property of the type rather than a rule
 * someone has to remember while editing a transport.
 */
export interface GraphQueryPort {
  readonly boundProjectId: string;
  readCurrentActiveGraph(projectId: string): ActiveGraphResult;
}

export interface GraphQueryRefusal {
  readonly code: GraphQueryCode;
  readonly httpStatus: number;
  readonly layer: typeof GRAPH_QUERY_LAYER;
  readonly ok: false;
}

export interface GraphQueryAccepted {
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly ok: true;
  readonly planHash: string;
  readonly provenance: ActiveGraphProvenance;
  readonly revisionId: string;
  readonly snapshot: GraphSnapshot;
  readonly snapshotIdentity: string;
}

/** Four possible answers, and each keeps the shape of whoever refused. */
export type GraphQueryResult =
  | GraphQueryAccepted
  | GraphQueryRefusal
  | Exclude<HttpAccessResult, { readonly ok: true }>
  | Extract<ActiveGraphResult, { readonly ok: false }>;

export interface GraphQueryRequest {
  readonly authenticator: Authenticator;
  readonly body: unknown;
  readonly credential: string | null;
  /**
   * Absent when the daemon was composed without graph support. It is checked
   * INSIDE this sequence, after authentication, rather than in each transport:
   * an unauthenticated or unauthorized caller must not learn how this daemon
   * is composed, and two transports each checking it would be two orders.
   */
  readonly port: GraphQueryPort | undefined;
  readonly protocolVersion: unknown;
}

/** A body this route cannot admit, kept distinct from "named no project". */
const INVALID = Symbol("graph-query-request-invalid");

/** The one field a body may carry, and only when it names its own project. */
const ALLOWED_BODY_KEYS: readonly string[] = Object.freeze(["projectId"]);

/** Each refusal borrows the status of the runtime error that already means it. */
const HTTP_STATUS_SOURCE: Readonly<Record<GraphQueryCode, "CAPABILITY_DENIED" | "INPUT_INVALID"
  | "STORAGE_DEGRADED">> = Object.freeze({
    GRAPH_QUERY_CAPABILITY_DENIED: "CAPABILITY_DENIED",
    GRAPH_QUERY_PROJECT_MISMATCH: "CAPABILITY_DENIED",
    GRAPH_QUERY_READ_FAILED: "STORAGE_DEGRADED",
    GRAPH_QUERY_REQUEST_INVALID: "INPUT_INVALID",
    GRAPH_QUERY_UNAVAILABLE: "STORAGE_DEGRADED",
  });

function refuse(code: GraphQueryCode): GraphQueryRefusal {
  return Object.freeze({
    code,
    httpStatus: createRuntimeError({
      code: HTTP_STATUS_SOURCE[code],
    }).transport.httpStatus,
    layer: GRAPH_QUERY_LAYER,
    ok: false as const,
  });
}

/**
 * Reads the ONLY field a body may carry. Own data properties only, so an
 * inherited or accessor-bearing `projectId` cannot answer for the caller, and an
 * unlisted key is refused rather than ignored — an ignored field reads to a
 * caller as an accepted one.
 */
function readRequestedProject(body: unknown): string | null | typeof INVALID {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) return INVALID;
  const keys = Object.keys(body);
  if (keys.some((key) => !ALLOWED_BODY_KEYS.includes(key))) return INVALID;
  if (!Object.hasOwn(body, "projectId")) return null;
  const descriptor = Object.getOwnPropertyDescriptor(body, "projectId");
  if (descriptor === undefined || !("value" in descriptor)) return INVALID;
  const projectId: unknown = descriptor.value;
  if (typeof projectId !== "string" || projectId.length === 0
    || projectId.length > PROJECT_CONFIGURATION_MAX_REF_CHARS) return INVALID;
  // A decomposed string and its composed twin name the same project to a human
  // and different projects to a comparison, so a non-NFC name is refused here
  // rather than silently matching or silently failing to.
  if (projectId.normalize("NFC") !== projectId) return INVALID;
  return projectId;
}

/** Cleared by both graph entries before either looks at a body. */
export type GraphQueryGateResult =
  | { readonly ok: true; readonly principal: AuthenticatedPrincipal }
  | GraphQueryRefusal
  | Exclude<HttpAccessResult, { readonly ok: true }>;

/**
 * Authenticate, compatibility, then capability — FIRST, and shared, because
 * parsing ahead of it would decode attacker-controlled bytes on behalf of a
 * caller the daemon has not identified. Both graph queries clear exactly this
 * much; only what follows differs, and keeping the order in one place is what
 * stops the two entries drifting into two different security postures. Exported
 * for the preview sibling and for the HTTP listener, which must clear it before
 * its own decode; neither export is a second security posture.
 */
export function gateGraphQuery(
  authenticator: Authenticator, credential: string | null, protocolVersion: unknown,
): GraphQueryGateResult {
  const access: HttpAccessResult = authenticateHttpRequest(
    authenticator,
    credential,
    protocolVersion,
  );
  if (!access.ok) return access;
  if (!access.principal.capabilities.includes(CAPABILITIES.PLANNING)) {
    return refuse("GRAPH_QUERY_CAPABILITY_DENIED");
  }
  return { ok: true, principal: access.principal };
}

export function answerGraphQuery(request: GraphQueryRequest): GraphQueryResult {
  const gated = gateGraphQuery(request.authenticator, request.credential, request.protocolVersion);
  if (!gated.ok) return gated;
  return answerGatedGraphQuery(gated.principal, request.port, request.body);
}

/**
 * Everything AFTER the gate: availability, project, body, read. Takes the
 * PRINCIPAL the gate minted, never a credential, so no transport reaches the
 * port or the body without clearing `gateGraphQuery`, exactly once.
 */
export function answerGatedGraphQuery(
  principal: AuthenticatedPrincipal, port: GraphQueryPort | undefined, body: unknown,
): GraphQueryResult {
  if (port === undefined) return refuse("GRAPH_QUERY_UNAVAILABLE");
  // The principal must belong to the project this daemon serves. Without this,
  // a principal authenticated for another project would be answered from THIS
  // daemon's store.
  if (principal.projectId !== port.boundProjectId) {
    return refuse("GRAPH_QUERY_PROJECT_MISMATCH");
  }
  const requested = readRequestedProject(body);
  if (requested === INVALID) return refuse("GRAPH_QUERY_REQUEST_INVALID");
  if (requested !== null && requested !== principal.projectId) {
    return refuse("GRAPH_QUERY_PROJECT_MISMATCH");
  }
  // The principal's project, never the body's — the body has by now been proven
  // to either name this same project or name none.
  //
  // A THROWN reader is not a refusal and must not become one silently, but it
  // must not cross the transport either: `dispatchQueryBytes` has no error
  // channel, so an escaping DurableStoreError would surface to an agent as a
  // dead connection rather than as an answer. The reader owns every DURABLE
  // state and its codes pass through untouched below; this arm covers only the
  // case where it could not answer at all, under this module's own layer so
  // nobody mistakes it for a projection verdict.
  let read: ActiveGraphResult;
  try {
    read = port.readCurrentActiveGraph(principal.projectId);
  } catch {
    return refuse("GRAPH_QUERY_READ_FAILED");
  }
  if (!read.ok) return read;
  return Object.freeze({
    graphContentHash: read.graphContentHash,
    graphEpoch: read.graphEpoch,
    ok: true as const,
    planHash: read.planHash,
    provenance: read.provenance,
    revisionId: read.revisionId,
    snapshot: read.snapshot,
    snapshotIdentity: read.snapshotIdentity,
  });
}
