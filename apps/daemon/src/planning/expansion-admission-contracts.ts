/**
 * The exact external contract and the closed refusal vocabulary for the daemon's expansion
 * ADMISSION path — the slice that composes scheduler `admitExpansion`, core `prepareExpansion`
 * and core `approveExpansionManually` over the daemon-current durable hold and its sealed
 * EXPANSION PlanningRun.
 *
 * WHAT A CALLER MAY SAY. Three SUBJECT references naming which goal, parent node and parent
 * planning run the expansion is about, plus the proposal and decision EVIDENCE the three kernels
 * validate hostilely for themselves. Nothing else. Every fact that carries authority — the
 * project, the principal, the goal's version/generation/graph epoch, the hold id, the hold
 * version, the planning-run ref, the admitted projection, the truth marking, the funding facts,
 * the fence facts, the graph lifecycle, the deadline and the approval claim — is read or derived
 * by daemon production code. `EXPANSION_ADMISSION_SERVER_OWNED_KEYS` names those explicitly so
 * the sweep proving a caller cannot present one is generated from a production roster rather
 * than from a list a test author remembered.
 *
 * WHY THE LAYER IS DERIVED FROM THE CODE. `expansionAdmissionRefusal` takes no layer argument:
 * the closed `EXPANSION_ADMISSION_CODE_LAYERS` map is the single source, so a call site cannot
 * mint a refusal whose code and layer disagree, and the code roster cannot drift from the map.
 *
 * WHY AN UPSTREAM FACE IS CARRIED RATHER THAN RESTAMPED. Six surfaces can refuse one request —
 * the durable hold reader, this slice's own contract check, the scheduler admission, the
 * scheduler admission-to-core bridge, the core preparation and the core approval. Flattening them would make an admission refusal
 * indistinguishable from an approval refusal at every call site downstream, which is the whole
 * diagnostic value of the roster. So the upstream code AND the upstream layer travel VERBATIM in
 * `upstream`, beside this slice's own code and layer, and neither is ever rewritten as the other.
 *
 * This module reads nothing, writes nothing and mints no authority.
 */

import type { ExpansionAdmissionUnwind } from "@moe/scheduler";

/**
 * The scheduler publishes the unwind TYPE but not its `NO_UNWIND` value, so the "nothing was
 * ever taken" constant is restated here under that exact type. It is the only shape a refusal
 * outside the reserve-then-fail path may carry, and `tsc` fails the day the type gains a member.
 */
export const EXPANSION_ADMISSION_NO_UNWIND: ExpansionAdmissionUnwind =
  Object.freeze({ budgetReservationCancelled: false, restoredMeters: null });

/** The complete external payload. Sorted, and compared by exact arity. */
export const EXPANSION_ADMISSION_PAYLOAD_KEYS = Object.freeze([
  "approval", "approvalCommand", "criteria", "goalRef", "opportunity", "parentNodeRef",
  "parentRunRef", "policy", "proposal", "supersession",
] as const);

/** The SERVER-assembled envelope. Never decoded from caller bytes; `payload` alone is. */
export const EXPANSION_ADMISSION_ENVELOPE_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "payload", "principalId", "projectId",
] as const);

/**
 * Members a caller must never be able to present, each one a fact this slice derives from
 * durable bytes or from a validated production result. The decoder refuses ANY extra key; this
 * roster exists so the refusal is proved member by member rather than in bulk.
 */
export const EXPANSION_ADMISSION_SERVER_OWNED_KEYS = Object.freeze([
  "admitted", "commandId", "deadlineEpochMs", "fence", "funding", "generation", "graphEpoch",
  "graphLifecycle", "holdId", "holdVersion", "identity", "nowEpochMs", "planningRunRef",
  "preparation", "principalId", "projectId", "truthClass",
] as const);

/** Which surface answered a refusal. Closed: a refusal outside this roster is a bug. */
export const EXPANSION_ADMISSION_LAYERS = Object.freeze([
  "ADMISSION", "APPROVAL", "AUTHORITY", "CONTRACT", "LEDGER", "PREPARATION", "PROJECTION",
  "RECORD", "REQUEST",
] as const);

export type ExpansionAdmissionLayer = (typeof EXPANSION_ADMISSION_LAYERS)[number];

/**
 * Every refusal this slice can mint, mapped to the layer that mints it. The code roster is
 * DERIVED from these keys below, so the two can never disagree.
 */
export const EXPANSION_ADMISSION_CODE_LAYERS = Object.freeze({
  /** The core approval kernel refused; its own code and layer travel in `upstream`. */
  EXPANSION_ADMISSION_APPROVAL_REFUSED: "APPROVAL",
  /** The daemon-current authority for the named subject could not be resolved. */
  EXPANSION_ADMISSION_AUTHORITY_UNAVAILABLE: "AUTHORITY",
  /** The durable world the hold froze is not the one the project currently holds. */
  EXPANSION_ADMISSION_CONTRACT_MISMATCH: "CONTRACT",
  EXPANSION_ADMISSION_ENVELOPE_MALFORMED: "REQUEST",
  /** The accepted reservation's lines span meters no single funding fact can describe. */
  EXPANSION_ADMISSION_FUNDING_UNDERIVABLE: "CONTRACT",
  /** The durable hold/run pair reader refused; its own code and layer travel in `upstream`. */
  EXPANSION_ADMISSION_HOLD_UNAVAILABLE: "LEDGER",
  EXPANSION_ADMISSION_PAYLOAD_MALFORMED: "REQUEST",
  /** The core preparation kernel refused; its own code and layer travel in `upstream`. */
  EXPANSION_ADMISSION_PREPARATION_REFUSED: "PREPARATION",
  /** The scheduler admission-to-core bridge refused; its own code and layer travel verbatim. */
  EXPANSION_ADMISSION_PROJECTION_REFUSED: "PROJECTION",
  /** The scheduler admission kernel refused; its own code and layer travel in `upstream`. */
  EXPANSION_ADMISSION_PROPOSAL_REFUSED: "ADMISSION",
  /** WRITE side: the store fenced the record on its expected version. */
  EXPANSION_ADMISSION_RECORD_CONFLICT: "RECORD",
  EXPANSION_ADMISSION_RECORD_UNAVAILABLE: "RECORD",
} as const satisfies Readonly<Record<string, ExpansionAdmissionLayer>>);

export type ExpansionAdmissionCode = keyof typeof EXPANSION_ADMISSION_CODE_LAYERS;

/** Derived, never restated: the roster IS the layer map's key set. */
export const EXPANSION_ADMISSION_CODES: readonly ExpansionAdmissionCode[] = Object.freeze(
  (Object.keys(EXPANSION_ADMISSION_CODE_LAYERS) as ExpansionAdmissionCode[]).sort(),
);

/**
 * The refusing surface's own identity, copied verbatim. `code` and `layer` are ALWAYS the
 * upstream's, never this slice's. `component`, `origin` and `target` carry whichever attribution
 * members the refusing surface actually names and are `null` where it names none:
 *
 *   scheduler admission  origin = the composed surface the issue entered through,
 *                        target = the issue's `missingInput`;
 *   core preparation     component = the surface that answered (`SUPERSESSION_ENGINE`,
 *   core approval        `POLICY_EVALUATION`, `GRAPH_REVISION`, ...);
 *   durable hold reader  origin = the delegated `sourceLayer`, target = the delegated
 *                        `sourceCode`, so a doubly-delegated refusal loses nothing.
 */
export interface ExpansionAdmissionUpstreamFace {
  readonly code: string;
  readonly component: string | null;
  readonly layer: string;
  readonly origin: string | null;
  readonly target: string | null;
}

export interface ExpansionAdmissionRefusal {
  readonly code: ExpansionAdmissionCode;
  readonly layer: ExpansionAdmissionLayer;
  readonly ok: false;
  /**
   * Proof the refusal holds no budget. Forwarded VERBATIM from the scheduler on the one path
   * that can strand a reservation — a resource refusal arriving after budget was reserved — and
   * `EXPANSION_ADMISSION_NO_UNWIND` everywhere else, because everywhere else nothing was taken.
   */
  readonly unwind: ExpansionAdmissionUnwind;
  readonly upstream: ExpansionAdmissionUpstreamFace | null;
}

export interface ExpansionAdmissionPayload {
  readonly approval: unknown;
  readonly approvalCommand: unknown;
  readonly criteria: unknown;
  readonly goalRef: string;
  readonly opportunity: unknown;
  readonly parentNodeRef: string;
  readonly parentRunRef: string;
  readonly policy: unknown;
  readonly proposal: unknown;
  readonly supersession: unknown;
}

export interface ExpansionAdmissionEnvelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  /** Still `unknown` here: only `decodeExpansionAdmissionPayload` may narrow it. */
  readonly payload: unknown;
  readonly principalId: string;
  readonly projectId: string;
}

export type ExpansionAdmissionPayloadResult =
  | { readonly ok: true; readonly payload: ExpansionAdmissionPayload }
  | ExpansionAdmissionRefusal;

export type ExpansionAdmissionEnvelopeResult =
  | { readonly envelope: ExpansionAdmissionEnvelope; readonly ok: true }
  | ExpansionAdmissionRefusal;

export function expansionAdmissionRefusal(
  code: ExpansionAdmissionCode,
  upstream: ExpansionAdmissionUpstreamFace | null = null,
  unwind: ExpansionAdmissionUnwind = EXPANSION_ADMISSION_NO_UNWIND,
): ExpansionAdmissionRefusal {
  return Object.freeze({
    code, layer: EXPANSION_ADMISSION_CODE_LAYERS[code], ok: false as const, unwind,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }),
  });
}

export function upstreamFace(
  code: string,
  layer: string,
  parts: Partial<Omit<ExpansionAdmissionUpstreamFace, "code" | "layer">> = {},
): ExpansionAdmissionUpstreamFace {
  return Object.freeze({
    code, component: parts.component ?? null, layer,
    origin: parts.origin ?? null, target: parts.target ?? null,
  });
}

export function isExpansionAdmissionRefusal(
  value: unknown,
): value is ExpansionAdmissionRefusal {
  return typeof value === "object" && value !== null && "ok" in value
    && (value as { readonly ok: unknown }).ok === false;
}

/** Exact arity: an extra key is refused, never ignored, so the wire meaning cannot drift. */
function exactly(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key))
    ? value as Record<string, unknown> : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function decodeExpansionAdmissionEnvelope(
  value: unknown,
): ExpansionAdmissionEnvelopeResult {
  const record = exactly(value, EXPANSION_ADMISSION_ENVELOPE_KEYS);
  if (record === null
    || !text(record["commandId"]) || !text(record["correlationId"])
    || !text(record["decidedAt"]) || !text(record["principalId"])
    || !text(record["projectId"])) {
    return expansionAdmissionRefusal("EXPANSION_ADMISSION_ENVELOPE_MALFORMED");
  }
  return Object.freeze({
    envelope: Object.freeze({
      commandId: record["commandId"], correlationId: record["correlationId"],
      decidedAt: record["decidedAt"], payload: record["payload"],
      principalId: record["principalId"], projectId: record["projectId"],
    }),
    ok: true as const,
  });
}

export function decodeExpansionAdmissionPayload(value: unknown): ExpansionAdmissionPayloadResult {
  const record = exactly(value, EXPANSION_ADMISSION_PAYLOAD_KEYS);
  if (record === null || !text(record["goalRef"]) || !text(record["parentNodeRef"])
    || !text(record["parentRunRef"])) {
    return expansionAdmissionRefusal("EXPANSION_ADMISSION_PAYLOAD_MALFORMED");
  }
  return Object.freeze({
    ok: true as const,
    payload: Object.freeze({
      approval: record["approval"], approvalCommand: record["approvalCommand"],
      criteria: record["criteria"], goalRef: record["goalRef"],
      opportunity: record["opportunity"], parentNodeRef: record["parentNodeRef"],
      parentRunRef: record["parentRunRef"],
      policy: record["policy"], proposal: record["proposal"],
      supersession: record["supersession"],
    }),
  });
}
