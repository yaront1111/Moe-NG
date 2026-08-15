/**
 * Provider-run telemetry contracts: the closed vocabularies a provider run is
 * classified into, and the quantity discipline that stops an unmeasured fact
 * from becoming a measured zero.
 *
 * ## Why a quantity is a union and not `number | null`
 *
 * `number | null` satisfies the letter of "null quantities, never zero" and
 * then invites `?? 0` at the first consumer, where nothing in the type system
 * objects. A discriminated union makes an unreadable count STRUCTURALLY
 * incapable of being read as a number: the caller has to branch on `known`
 * before a `value` exists at all, and the false arm carries the exact reason
 * code and the layer that answered rather than a bare absence.
 *
 * A genuinely observed `0` is still a fact — `knownCount(0)` is legal. What is
 * impossible is arriving at `0` because a field was missing.
 *
 * ## Why coverage is its own closed class
 *
 * Completeness is NOT inferred from whether a number happens to be present.
 * Inferring it would recreate at the record level exactly the ambiguity the
 * quantity union removes at the field level: a record holding one known count
 * and one absent count would be indistinguishable from a fully measured one.
 */
import { types } from "node:util";

import { deepFreeze, isSafeByteCount } from "../../canonical.js";

export const PROVIDER_TELEMETRY_CONTRACT_VERSION = "moe-provider-telemetry/1" as const;

/**
 * How the provider's own run ENDED, as the run's terminal record reports it.
 * `REFUSED` is the launch never producing a run this vocabulary can speak for;
 * `UNKNOWN` is the run whose terminal record is absent or unreadable. Neither
 * ever becomes `COMPLETED` by omission.
 */
export const PROVIDER_TERMINAL_OUTCOMES = Object.freeze([
  "COMPLETED", "CANCELLED", "MAX_TURNS_EXHAUSTED", "ERROR_DURING_EXECUTION", "REFUSED", "UNKNOWN",
] as const);
export type ProviderTerminalOutcome = (typeof PROVIDER_TERMINAL_OUTCOMES)[number];

/**
 * What happened AROUND the run — process, capture and admission facts that are
 * independent of whatever the run itself reported. `NONE` is the only member
 * that asserts an absence of infrastructure fault, and it is reachable only
 * from an observed exit with an intact, admitted capture.
 */
export const PROVIDER_INFRASTRUCTURE_OUTCOMES = Object.freeze([
  "NONE", "PROCESS_SIGNALLED", "EXIT_UNOBSERVED", "CAPTURE_TRUNCATED", "CAPTURE_INCOMPLETE",
  "SCHEMA_UNSUPPORTED", "STREAM_ANOMALOUS", "LAUNCH_REFUSED", "LAUNCH_NOT_ATTEMPTED", "UNKNOWN",
] as const);
export type ProviderInfrastructureOutcome = (typeof PROVIDER_INFRASTRUCTURE_OUTCOMES)[number];

export const PROVIDER_COUNT_COVERAGE_CLASSES =
  Object.freeze(["COMPLETE", "PARTIAL", "UNKNOWN"] as const);
export type ProviderCountCoverage = (typeof PROVIDER_COUNT_COVERAGE_CLASSES)[number];

/**
 * Concurrency is the sharpest declared-versus-observed trap on this seam,
 * because the only concurrency number in reach — `concurrencyCeiling` — lives
 * on the launch SELECTION and is therefore a request, not a measurement. The
 * pinned provider result schema carries no achieved-concurrency field at all,
 * so `achieved` is unsupported by construction and there is deliberately no
 * member of this vocabulary that would let it be filled from the ceiling.
 */
export const PROVIDER_CONCURRENCY_FACTS =
  Object.freeze(["DECLARED_CEILING_ONLY", "NO_CONCURRENCY_FACTS"] as const);
export type ProviderConcurrencyFact = (typeof PROVIDER_CONCURRENCY_FACTS)[number];

export const PROVIDER_TELEMETRY_CODES = Object.freeze([
  "TELEMETRY_ACHIEVED_CONCURRENCY_UNSUPPORTED", "TELEMETRY_CAPTURE_INCOMPLETE",
  "TELEMETRY_CAPTURE_TRUNCATED", "TELEMETRY_CAPTURE_UNDECODABLE",
  "TELEMETRY_DECLARED_SELECTION_UNREADABLE", "TELEMETRY_LAUNCH_NOT_ATTEMPTED",
  "TELEMETRY_LAUNCH_REFUSED", "TELEMETRY_MODEL_ABSENT", "TELEMETRY_MODEL_AMBIGUOUS",
  "TELEMETRY_RESULT_ABSENT", "TELEMETRY_RUN_REF_MALFORMED", "TELEMETRY_SCHEMA_UNSUPPORTED",
  "TELEMETRY_STEPS_ABSENT", "TELEMETRY_STREAM_ANOMALOUS", "TELEMETRY_USAGE_ABSENT",
] as const);
export type ProviderTelemetryCode = (typeof PROVIDER_TELEMETRY_CODES)[number];

/**
 * WHICH layer answered. More than one layer can refuse the same run — the
 * launcher before any bytes exist, stream admission before any record is read,
 * the terminal record itself — so a test that pinned only the code would stay
 * green once a different layer started answering first.
 */
export const PROVIDER_TELEMETRY_LAYERS = Object.freeze([
  "TELEMETRY_INPUT", "TELEMETRY_LAUNCH", "TELEMETRY_CAPTURE", "TELEMETRY_SCHEMA",
  "TELEMETRY_RESULT",
] as const);
export type ProviderTelemetryLayer = (typeof PROVIDER_TELEMETRY_LAYERS)[number];

/**
 * Static per-code refusal messages. Nothing interpolated: a message quoting the
 * captured bytes, the model or a digest would echo provider output back out of
 * a failure path, and every consumer already has the code and the layer.
 */
export const PROVIDER_TELEMETRY_MESSAGES: Readonly<Record<ProviderTelemetryCode, string>> =
  Object.freeze({
    TELEMETRY_ACHIEVED_CONCURRENCY_UNSUPPORTED:
      "the pinned result schema reports no achieved concurrency",
    TELEMETRY_CAPTURE_INCOMPLETE: "the capture did not finish, so no count can be a total",
    TELEMETRY_CAPTURE_TRUNCATED: "the capture was cut, so no count can be a total",
    TELEMETRY_CAPTURE_UNDECODABLE: "the captured bytes do not decode to their declared digest",
    TELEMETRY_DECLARED_SELECTION_UNREADABLE:
      "the declared launch selection is not readable plain data",
    TELEMETRY_LAUNCH_NOT_ATTEMPTED: "this delivery launched no process of its own",
    TELEMETRY_LAUNCH_REFUSED: "the launcher refused before any provider bytes existed",
    TELEMETRY_MODEL_ABSENT: "no admitted record names the model evidence this fact needs",
    TELEMETRY_MODEL_AMBIGUOUS: "admitted records name more than one initialised model",
    TELEMETRY_RESULT_ABSENT: "the capture holds no terminal result record",
    TELEMETRY_RUN_REF_MALFORMED: "the provider run reference is not an exact bounded record",
    TELEMETRY_SCHEMA_UNSUPPORTED: "the capture holds a schema this parser version does not accept",
    TELEMETRY_STEPS_ABSENT: "the terminal result record reports no step count",
    TELEMETRY_STREAM_ANOMALOUS: "the capture holds an anomaly that destroyed its own evidence",
    TELEMETRY_USAGE_ABSENT: "the terminal result record reports no usage block",
  });

export interface ProviderTelemetryRefusal {
  readonly ok: false;
  readonly code: ProviderTelemetryCode;
  readonly layer: ProviderTelemetryLayer;
  readonly message: string;
}

export function telemetryRefusal(
  code: ProviderTelemetryCode,
  layer: ProviderTelemetryLayer,
): ProviderTelemetryRefusal {
  return deepFreeze({ ok: false as const, code, layer, message: PROVIDER_TELEMETRY_MESSAGES[code] });
}

export interface ProviderFactUnknown {
  readonly known: false;
  readonly code: ProviderTelemetryCode;
  readonly layer: ProviderTelemetryLayer;
}
export type ProviderQuantity = { readonly known: true; readonly value: number } | ProviderFactUnknown;
export type ProviderText = { readonly known: true; readonly value: string } | ProviderFactUnknown;

/** Run identity a telemetry record is bound to: the run, its effect, its attempt. */
export interface ProviderRunRef {
  readonly provider: "claude";
  readonly runRef: string;
  readonly effectIntentId: string;
  readonly attemptRef: string;
  readonly epoch: number;
}

const BOUNDED_REF = /^[!-~]{1,200}$/u;

export function unknownFact(
  code: ProviderTelemetryCode,
  layer: ProviderTelemetryLayer,
): ProviderFactUnknown {
  return deepFreeze({ known: false as const, code, layer });
}

/**
 * The ONE place a number becomes a known quantity. A caller cannot reach the
 * `known: true` arm with anything but a non-negative safe integer, which is why
 * an absent, null, string-typed or fractional field can only leave here as the
 * supplied `absent` fact — there is no arithmetic default to fall back to.
 */
export function knownCount(value: number): ProviderQuantity | null {
  return isSafeByteCount(value) ? deepFreeze({ known: true as const, value }) : null;
}

export function readCount(
  source: Readonly<Record<string, unknown>> | null,
  key: string,
  absent: ProviderFactUnknown,
): ProviderQuantity {
  if (source === null) return absent;
  const raw = source[key];
  if (typeof raw !== "number") return absent;
  return knownCount(raw) ?? absent;
}

export function readText(
  source: Readonly<Record<string, unknown>> | null,
  key: string,
  absent: ProviderFactUnknown,
): ProviderText {
  if (source === null) return absent;
  const raw = source[key];
  if (typeof raw !== "string" || !BOUNDED_REF.test(raw)) return absent;
  return deepFreeze({ known: true as const, value: raw });
}

/**
 * Coverage over a SET of counts. An empty set is `UNKNOWN` rather than
 * vacuously `COMPLETE`: "we measured nothing" and "we measured everything
 * there was" are the two readings this class exists to keep apart.
 */
export function countCoverage(facts: readonly ProviderQuantity[]): ProviderCountCoverage {
  if (facts.length === 0) return "UNKNOWN";
  const known = facts.filter((fact) => fact.known).length;
  if (known === facts.length) return "COMPLETE";
  return known === 0 ? "UNKNOWN" : "PARTIAL";
}

/**
 * TOTAL by construction: every arm answers null, so a malformed run reference
 * can never be partially adopted. `provider` is pinned to the literal rather
 * than read, because a record naming another provider is not a Claude run ref
 * with a bad field — it is a different fact entirely.
 */
export function snapshotRunRef(value: unknown): ProviderRunRef | null {
  if (typeof value !== "object" || value === null) return null;
  // A proxy is refused BEFORE any property is read, matching the launcher's own
  // discipline: a trap that has run has already had its effect whatever this
  // guard decides afterwards, and a REVOKED proxy makes `isProxy` itself throw —
  // so a value that will not answer whether it is a proxy is read as hostile.
  try {
    if (types.isProxy(value)) return null;
  } catch {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const runRef = raw["runRef"];
  const effectIntentId = raw["effectIntentId"];
  const attemptRef = raw["attemptRef"];
  const epoch = raw["epoch"];
  if (
    raw["provider"] !== "claude" ||
    typeof runRef !== "string" || !BOUNDED_REF.test(runRef) ||
    typeof effectIntentId !== "string" || !BOUNDED_REF.test(effectIntentId) ||
    typeof attemptRef !== "string" || !BOUNDED_REF.test(attemptRef) ||
    !isSafeByteCount(epoch)
  ) {
    return null;
  }
  return deepFreeze({ provider: "claude" as const, runRef, effectIntentId, attemptRef, epoch });
}
