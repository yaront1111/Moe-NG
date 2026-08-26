/**
 * THE POST-VERIFICATION FINALIZATION VOCABULARY (task-48c79a29).
 *
 * WHAT THE WRAPPER AND THE SOURCE EACH SAY. Every refusal below carries TWO
 * facts: a wrapper code naming WHICH STAGE of finalization declined, and the
 * refusing authority's OWN code and layer saying WHY. Flattening them loses the
 * distinction between "the journal is unreadable" and "finalization refused" —
 * two answers demanding opposite repairs. Nothing here ever restamps an upstream
 * refusal with this layer.
 *
 * FOUR OUTCOMES, NOT THREE. `DRAINING`, `NO_OP` and `RELEASED` are the kernel's
 * own. `BINDING_WRITTEN_RELEASE_REFUSED` is the fourth and the subtle one: it is
 * EXACTLY the state the pre-verification ordering produces — the core handoff
 * binding is composed before the kernel is asked, so a release the kernel then
 * declines leaves an inert binding standing with no release beside it. Folding
 * that into a generic refusal would leave an operator unable to see that a
 * binding is sitting there unreleased, so it is a first-class answer with its own
 * name. It is a FACT about what the attempt handed off, never authority: a
 * consumer may act on a binding only when it also sees RELEASED.
 *
 * THE PAYLOAD MAY SELECT IDENTITIES AND NOTHING ELSE. `FINALIZATION_REQUEST_KEYS`
 * is an EXACT-ARITY allow-list, so release, truth, terminal, receipt, observation,
 * digest and handoff authority are refused STRUCTURALLY — there is no key to
 * carry them and no downstream branch that has to remember to ignore one.
 */

const LAYER = "DAEMON_ATTEMPT_FINALIZATION";
export type AttemptFinalizationLayer = typeof LAYER;
export const ATTEMPT_FINALIZATION_LAYER: AttemptFinalizationLayer = LAYER;

export const ATTEMPT_FINALIZATION_CODES = Object.freeze([
  "ATTEMPT_FINALIZATION_ATTEMPT_UNREADABLE",
  "ATTEMPT_FINALIZATION_BOUNDARY_UNRESOLVED",
  "ATTEMPT_FINALIZATION_HANDOFF_UNRESOLVED",
  "ATTEMPT_FINALIZATION_HORIZON_MOVED",
  "ATTEMPT_FINALIZATION_JOURNAL_UNRESOLVED",
  "ATTEMPT_FINALIZATION_RECEIPT_FOREIGN",
  "ATTEMPT_FINALIZATION_RECEIPT_UNVERIFIED",
  "ATTEMPT_FINALIZATION_RELEASE_REFUSED",
  "ATTEMPT_FINALIZATION_REQUEST_MALFORMED",
  "ATTEMPT_FINALIZATION_TERMINAL_UNRESOLVED",
] as const);
export type AttemptFinalizationCode = (typeof ATTEMPT_FINALIZATION_CODES)[number];

export const ATTEMPT_FINALIZATION_OUTCOMES = Object.freeze([
  "BINDING_WRITTEN_RELEASE_REFUSED", "DRAINING", "NO_OP", "RELEASED",
] as const);
export type AttemptFinalizationOutcomeName = (typeof ATTEMPT_FINALIZATION_OUTCOMES)[number];

/** Exactly the two identities a caller may select. NOT a receipt, NOT a digest,
 *  NOT a boundary, NOT a handoff, NOT a terminality, NOT a truth class, NOT a
 *  release: those seven categories have no key here, which is the whole point. */
export const FINALIZATION_REQUEST_KEYS = Object.freeze([
  "attemptAggregateId", "verificationId",
] as const);

/** The seven authority categories the allow-list refuses structurally. Named so a
 *  suite can sweep them rather than transcribing a list that would drift. */
export const FINALIZATION_FORBIDDEN_KEYS = Object.freeze([
  "contextDigest", "handoff", "observationRef", "receiptRef", "release",
  "resourcesTerminal", "safeBoundaryObserved", "truthClass",
] as const);

/** The refusing authority's OWN code and layer. `null` only when this module's
 *  own admission declined and no upstream was consulted. */
export interface FinalizationSource {
  readonly code: string; readonly layer: string;
}

export interface AttemptFinalizationRefused {
  readonly code: AttemptFinalizationCode; readonly layer: AttemptFinalizationLayer;
  readonly ok: false; readonly source: FinalizationSource | null;
}

export interface FinalizationRequest {
  readonly attemptAggregateId: string; readonly verificationId: string;
}

export const refuseFinalization = (
  code: AttemptFinalizationCode, source: FinalizationSource | null = null,
): AttemptFinalizationRefused =>
  Object.freeze({ code, layer: LAYER, ok: false as const, source });

/**
 * The refusing layer, whichever of the two shapes the authority uses. Producers
 * on this lane spell it `layer` or `refusedBy`; reading only one would silently
 * answer "UNKNOWN" for half the roster and make the attribution untestable.
 */
export function sourceOf(refusal: object): FinalizationSource {
  const row = refusal as Record<string, unknown>;
  const layer = typeof row["layer"] === "string"
    ? row["layer"]
    : typeof row["refusedBy"] === "string" ? row["refusedBy"] : "UNKNOWN";
  return Object.freeze({
    code: typeof row["code"] === "string" ? row["code"] : "UNKNOWN", layer,
  });
}

/**
 * EXACT ARITY over OWN properties, enumerable or not.
 *
 * `Object.keys` is blind to a non-enumerable own property, so a hostile request
 * could smuggle `handoff` past a key-count check that used it; `Reflect.ownKeys`
 * cannot be answered from above the way `in` and `Reflect.has` can, and it sees
 * symbols too. TOTAL over `unknown`: a null or non-object request refuses rather
 * than crashing, because a crash is not a fail-closed answer.
 */
export function admitFinalizationRequest(value: unknown): FinalizationRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const allowed = new Set<string | symbol>(FINALIZATION_REQUEST_KEYS);
  if (keys.length !== FINALIZATION_REQUEST_KEYS.length) return null;
  if (keys.some((key) => !allowed.has(key))) return null;
  const row = value as Record<string, unknown>;
  return FINALIZATION_REQUEST_KEYS.every(
    (key) => typeof row[key] === "string" && row[key] !== "",
  ) ? (value as FinalizationRequest) : null;
}
