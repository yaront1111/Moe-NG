/**
 * The exact external contract for the daemon's atomic `graph.request_expansion` path.
 *
 * WHAT A CALLER MAY SAY. Four members and nothing else: a rationale plus the three SUBJECT
 * references naming which goal, which parent node and which parent planning run the expansion is
 * about. Everything that carries authority — the project, the authenticated principal, the goal's
 * current version/generation/graph epoch, the hold id, the planning-run ref, the deadline, the
 * proposal and source fingerprints, the safe-release evidence and the worker handoff — is read or
 * derived by daemon production code. `EXPANSION_REQUEST_SERVER_OWNED_KEYS` names those explicitly
 * so the sweep that proves a caller cannot present one is generated from a production roster
 * rather than from a list a test author remembered.
 *
 * WHY THE DECODER REFUSES EXTRA KEYS RATHER THAN IGNORING THEM. Silently dropping an unexpected
 * `release` member would let a caller believe it had supplied release truth and let a reviewer
 * believe the field was load-bearing. An exact-arity record refuses, so the wire meaning of the
 * payload cannot drift under either reading.
 *
 * WHY THE LAYER IS DERIVED FROM THE CODE. `expansionRequestRefusal` takes no layer argument: the
 * closed `EXPANSION_REQUEST_CODE_LAYERS` map is the single source, so a call site cannot mint a
 * refusal whose code and layer disagree, and the code roster cannot drift from the layer map.
 *
 * This module reads nothing, writes nothing and mints no authority. Consumers:
 * `expansion-request-current-authority.ts`, `expansion-request-ledger.ts` and
 * `expansion-request-service.ts` in this slice; task-c4171c1cfe854cb78dd233794b342025 downstream.
 */

export const EXPANSION_REQUEST_KIND = "graph.request_expansion" as const;

/** The complete external payload. Sorted, and compared by exact arity. */
export const EXPANSION_REQUEST_PAYLOAD_KEYS = Object.freeze([
  "goalRef", "parentNodeRef", "parentRunRef", "rationale",
] as const);

/** The SERVER-assembled envelope. Never decoded from caller bytes; `payload` alone is. */
export const EXPANSION_REQUEST_ENVELOPE_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "payload", "principalId", "projectId",
] as const);

/**
 * Members a caller must never be able to present, each one a fact this slice derives. The
 * decoder refuses ANY extra key; this roster exists so the refusal is proved member by member.
 */
export const EXPANSION_REQUEST_SERVER_OWNED_KEYS = Object.freeze([
  "commandId", "deadline", "expansion", "expectedVersion", "generation", "graphEpoch", "holdId",
  "kind", "parentRevisionRef", "planningRunRef", "principalId", "projectId", "proposalBaseHash",
  "release", "sourceFingerprint", "truthClass", "workerHandoff",
] as const);

/** Which surface answered a refusal. Closed: a refusal outside this roster is a bug. */
export const EXPANSION_REQUEST_LAYERS = Object.freeze([
  "BINDING", "CURRENT_AUTHORITY", "HOLD", "LEDGER", "PLANNING_RUN", "RELEASE_AUTHORITY", "REQUEST",
] as const);

export type ExpansionRequestLayer = (typeof EXPANSION_REQUEST_LAYERS)[number];

/**
 * Every refusal this slice can mint, mapped to the layer that mints it. The code roster is
 * DERIVED from these keys below, so the two can never disagree.
 */
export const EXPANSION_REQUEST_CODE_LAYERS = Object.freeze({
  EXPANSION_REQUEST_BINDING_REFUSED: "BINDING",
  EXPANSION_REQUEST_ENVELOPE_MALFORMED: "REQUEST",
  EXPANSION_REQUEST_GOAL_ABSENT: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_GOAL_FOREIGN: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_GOAL_MALFORMED: "CURRENT_AUTHORITY",
  /** DRAFT: a real goal that has not reached an executing lifecycle, and is not terminal. */
  EXPANSION_REQUEST_GOAL_NOT_EXECUTING: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_GOAL_TERMINAL: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_GRAPH_EPOCH_MISMATCH: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_GRAPH_GOAL_MISMATCH: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_GRAPH_UNAVAILABLE: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_HOLD_REFUSED: "HOLD",
  EXPANSION_REQUEST_LEDGER_ABSENT: "LEDGER",
  EXPANSION_REQUEST_LEDGER_AMBIGUOUS: "LEDGER",
  /** READ side: the hold leg and the run leg describe different worlds. */
  EXPANSION_REQUEST_LEDGER_CONFLICTING: "LEDGER",
  EXPANSION_REQUEST_LEDGER_FOREIGN: "LEDGER",
  EXPANSION_REQUEST_LEDGER_IDEMPOTENCY_CONFLICT: "LEDGER",
  EXPANSION_REQUEST_LEDGER_MALFORMED: "LEDGER",
  EXPANSION_REQUEST_LEDGER_SPLIT: "LEDGER",
  EXPANSION_REQUEST_LEDGER_STALE: "LEDGER",
  EXPANSION_REQUEST_LEDGER_TERMINAL: "LEDGER",
  EXPANSION_REQUEST_LEDGER_UNAVAILABLE: "LEDGER",
  /** WRITE side: the store fenced the commit on an expected version. */
  EXPANSION_REQUEST_LEDGER_VERSION_CONFLICT: "LEDGER",
  EXPANSION_REQUEST_PARENT_NODE_ABSENT: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_PARENT_RUN_ABSENT: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_PARENT_RUN_FOREIGN: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_PARENT_RUN_MALFORMED: "CURRENT_AUTHORITY",
  EXPANSION_REQUEST_PAYLOAD_MALFORMED: "REQUEST",
  EXPANSION_REQUEST_RELEASE_AUTHORITY_UNAVAILABLE: "RELEASE_AUTHORITY",
  EXPANSION_REQUEST_RELEASE_REFUSED: "RELEASE_AUTHORITY",
  EXPANSION_REQUEST_RUN_REFUSED: "PLANNING_RUN",
} as const satisfies Readonly<Record<string, ExpansionRequestLayer>>);

export type ExpansionRequestCode = keyof typeof EXPANSION_REQUEST_CODE_LAYERS;

/** Derived, never restated: the roster IS the layer map's key set. */
export const EXPANSION_REQUEST_CODES: readonly ExpansionRequestCode[] = Object.freeze(
  (Object.keys(EXPANSION_REQUEST_CODE_LAYERS) as ExpansionRequestCode[]).sort(),
);

export interface ExpansionRequestPayload {
  readonly goalRef: string;
  readonly parentNodeRef: string;
  readonly parentRunRef: string;
  readonly rationale: string;
}

export interface ExpansionRequestEnvelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  /** Still `unknown` here: only `decodeExpansionRequestPayload` may narrow it. */
  readonly payload: unknown;
  readonly principalId: string;
  readonly projectId: string;
}

export interface ExpansionRequestRefusal {
  readonly code: ExpansionRequestCode;
  readonly layer: ExpansionRequestLayer;
  readonly ok: false;
  /** The delegated surface's own code, copied verbatim; null when this slice refused alone. */
  readonly sourceCode: string | null;
  /** The delegated surface's own layer, copied verbatim; null when this slice refused alone. */
  readonly sourceLayer: string | null;
}

export type ExpansionRequestPayloadResult =
  | { readonly ok: true; readonly payload: ExpansionRequestPayload }
  | ExpansionRequestRefusal;

export type ExpansionRequestEnvelopeResult =
  | { readonly envelope: ExpansionRequestEnvelope; readonly ok: true }
  | ExpansionRequestRefusal;

/** Core's own `MAX_TEXT`; a rationale or ref longer than this could not reach the reducer. */
export const MAX_EXPANSION_REQUEST_TEXT = 256;

export function deepFreezeExpansionValue<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreezeExpansionValue((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export function expansionRequestRefusal(
  code: ExpansionRequestCode,
  sourceCode: string | null = null,
  sourceLayer: string | null = null,
): ExpansionRequestRefusal {
  return Object.freeze({
    code,
    layer: EXPANSION_REQUEST_CODE_LAYERS[code],
    ok: false as const,
    sourceCode,
    sourceLayer,
  });
}

export function isExpansionRequestRefusal(value: unknown): value is ExpansionRequestRefusal {
  return typeof value === "object" && value !== null && "ok" in value
    && (value as { readonly ok: unknown }).ok === false;
}

/** Bounded, NUL-free, non-empty text. A NUL byte reaches the store as a malformed id. */
export function boundedExpansionText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= MAX_EXPANSION_REQUEST_TEXT && !value.includes("\u0000");
}

/** Exact arity over own enumerable string keys, with no inherited member admitted. */
export function exactExpansionRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string")) return null;
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined || !property.enumerable || !("value" in property)) return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * The ONE decode of caller bytes in this slice. It copies every accepted member into a fresh
 * frozen record, so a caller retaining a reference to the input cannot mutate what the daemon
 * went on to persist.
 */
export function decodeExpansionRequestPayload(value: unknown): ExpansionRequestPayloadResult {
  const item = exactExpansionRecord(value, EXPANSION_REQUEST_PAYLOAD_KEYS);
  if (item === null) return expansionRequestRefusal("EXPANSION_REQUEST_PAYLOAD_MALFORMED");
  if (!EXPANSION_REQUEST_PAYLOAD_KEYS.every((key) => boundedExpansionText(item[key]))) {
    return expansionRequestRefusal("EXPANSION_REQUEST_PAYLOAD_MALFORMED");
  }
  return Object.freeze({
    ok: true as const,
    payload: Object.freeze({
      goalRef: item["goalRef"] as string,
      parentNodeRef: item["parentNodeRef"] as string,
      parentRunRef: item["parentRunRef"] as string,
      rationale: item["rationale"] as string,
    }),
  });
}

/**
 * Defensive re-validation of the SERVER envelope. The composition root builds it, so a refusal
 * here is a daemon fault rather than a caller one — but an unchecked envelope is how a blank
 * principal or project id would reach a decision key.
 */
export function decodeExpansionRequestEnvelope(value: unknown): ExpansionRequestEnvelopeResult {
  const item = exactExpansionRecord(value, EXPANSION_REQUEST_ENVELOPE_KEYS);
  if (item === null) return expansionRequestRefusal("EXPANSION_REQUEST_ENVELOPE_MALFORMED");
  const texts = ["commandId", "correlationId", "decidedAt", "principalId", "projectId"];
  if (!texts.every((key) => boundedExpansionText(item[key]))) {
    return expansionRequestRefusal("EXPANSION_REQUEST_ENVELOPE_MALFORMED");
  }
  return Object.freeze({
    envelope: Object.freeze({
      commandId: item["commandId"] as string,
      correlationId: item["correlationId"] as string,
      decidedAt: item["decidedAt"] as string,
      payload: item["payload"],
      principalId: item["principalId"] as string,
      projectId: item["projectId"] as string,
    }),
    ok: true as const,
  });
}
