import type {
  RuntimeRecoveryCategory,
  RuntimeRetryability,
  RuntimeTransportBinding,
} from "@moe/contracts";

import {
  GENERATED_COMMAND_BUILDERS,
  GENERATED_CONTRACT_PINS,
  GENERATED_ERROR_TABLE,
  GENERATED_QUERY_BUILDERS,
  GENERATED_TELEMETRY_KINDS,
  GENERATED_WIRE_PROTOCOL_VERSION,
} from "./generated/generated-client.js";
import type {
  GeneratedCommandBuilders,
  GeneratedContractPins,
  GeneratedErrorTable,
  GeneratedQueryBuilders,
} from "./generated/generated-client.js";

/**
 * v1 semantics: this is the DEGENERATE EXACT-PIN of design section 834's API
 * compatibility range. Three exact version strings, never a span. A degenerate pin is
 * strictly stricter than a range, so it can refuse a compatible build but can never
 * admit an incompatible one. Widening to a real range is a later, deliberate change.
 */
export interface ApiCompatibilityRange {
  readonly commandEnvelopeVersion: string;
  readonly errorRegistryVersion: string;
  readonly queryEnvelopeVersion: string;
}

/**
 * The `DistributionManifest` fields a control room needs to decide compatibility, in
 * design section 834's own vocabulary so a future daemon can serve it unreshaped.
 *
 * Only `contractSchemaHash` and `apiCompatibilityRange` gate admission.
 * `buildToolVersions`, `sourceSha`, and `assetDigest` are provenance a UI can display;
 * they are checked for shape only, because this client holds no expected value to
 * compare them against and inventing one would be a fabricated pin.
 */
export interface DistributionCompatibilityReport {
  readonly apiCompatibilityRange: ApiCompatibilityRange;
  readonly assetDigest?: string;
  readonly buildToolVersions: Readonly<Record<string, string>>;
  readonly contractSchemaHash: string;
  readonly sourceSha?: string;
}

/**
 * The whole generated surface, reachable only through a matching gate.
 *
 * `wireProtocolVersion` lives here rather than on the package root deliberately: the root
 * exports the gate and nothing else, and a build whose pins do not match should not even
 * learn the protocol string it failed to match.
 */
export interface ControlRoomClientSurface {
  readonly commands: GeneratedCommandBuilders;
  readonly errors: GeneratedErrorTable;
  readonly pins: GeneratedContractPins;
  readonly queries: GeneratedQueryBuilders;
  readonly telemetryKinds: typeof GENERATED_TELEMETRY_KINDS;
  readonly wireProtocolVersion: typeof GENERATED_WIRE_PROTOCOL_VERSION;
}

/**
 * A locally observed refusal, deliberately NOT a daemon `RuntimeError`.
 * `createRuntimeError` fails closed to `UNKNOWN_ERROR` unless the caller supplies the
 * lifecycle source the code declares, and `DISTRIBUTION_MISMATCH` declares `PROJECT`.
 * A control room cannot observe project state at startup, so claiming one would invent
 * daemon truth. Retryability, recovery, and transport are projected verbatim from the
 * generated registry table because those are facts about the CODE; `truthClass` is
 * `OBSERVED` because the client itself compared the pins.
 */
export interface CompatRefusalError {
  readonly code: "DISTRIBUTION_MISMATCH";
  readonly recoveryCategory: RuntimeRecoveryCategory;
  readonly retryability: RuntimeRetryability;
  readonly transport: RuntimeTransportBinding;
  readonly truthClass: "OBSERVED";
}

export type CompatGateResult =
  | { readonly client: ControlRoomClientSurface; readonly ok: true }
  | { readonly error: CompatRefusalError; readonly ok: false };

const REPORT_REQUIRED = Object.freeze([
  "apiCompatibilityRange", "buildToolVersions", "contractSchemaHash",
] as const);
const REPORT_OPTIONAL = Object.freeze(["assetDigest", "sourceSha"] as const);
const RANGE_KEYS = Object.freeze([
  "commandEnvelopeVersion", "errorRegistryVersion", "queryEnvelopeVersion",
] as const);

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set<string>([...required, ...optional]);
  const present = Object.keys(record);
  return present.every((key) => allowed.has(key))
    && required.every((key) => Object.hasOwn(record, key));
}

function rangeMatchesPins(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, RANGE_KEYS, [])) return false;
  return value["commandEnvelopeVersion"] === GENERATED_CONTRACT_PINS.commandEnvelopeVersion
    && value["errorRegistryVersion"] === GENERATED_CONTRACT_PINS.errorRegistryVersion
    && value["queryEnvelopeVersion"] === GENERATED_CONTRACT_PINS.queryEnvelopeVersion;
}

function buildToolVersionsValid(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((entry) => isNonEmptyString(entry));
}

function optionalIdentityValid(record: Readonly<Record<string, unknown>>): boolean {
  return REPORT_OPTIONAL.every(
    (key) => !Object.hasOwn(record, key) || isNonEmptyString(record[key]),
  );
}

const MISMATCH_ROW = GENERATED_ERROR_TABLE["DISTRIBUTION_MISMATCH"];

const REFUSAL_ERROR: CompatRefusalError = Object.freeze({
  code: "DISTRIBUTION_MISMATCH",
  recoveryCategory: MISMATCH_ROW.recoveryCategory,
  retryability: MISMATCH_ROW.retryability,
  transport: MISMATCH_ROW.transport,
  truthClass: "OBSERVED",
});

/** One shared frozen refusal: no builder, no partial surface, identity is stable. */
const REFUSED: CompatGateResult = Object.freeze({ error: REFUSAL_ERROR, ok: false as const });

function refuse(): CompatGateResult {
  return REFUSED;
}

const CLIENT_SURFACE: ControlRoomClientSurface = Object.freeze({
  commands: GENERATED_COMMAND_BUILDERS,
  errors: GENERATED_ERROR_TABLE,
  pins: GENERATED_CONTRACT_PINS,
  queries: GENERATED_QUERY_BUILDERS,
  telemetryKinds: GENERATED_TELEMETRY_KINDS,
  wireProtocolVersion: GENERATED_WIRE_PROTOCOL_VERSION,
});

const ADMITTED: CompatGateResult = Object.freeze({ client: CLIENT_SURFACE, ok: true as const });

/**
 * Fails closed before any action can be rendered. The report crosses a trust boundary,
 * so the parameter is `unknown`: a missing, malformed, or drifted manifest all resolve
 * to the same `DISTRIBUTION_MISMATCH` refusal that exposes zero builders.
 */
export function createCompatGate(report: unknown): CompatGateResult {
  if (!isPlainObject(report)) return refuse();
  if (!hasExactKeys(report, REPORT_REQUIRED, REPORT_OPTIONAL)) return refuse();
  if (report["contractSchemaHash"] !== GENERATED_CONTRACT_PINS.contractDigest) return refuse();
  if (!rangeMatchesPins(report["apiCompatibilityRange"])) return refuse();
  if (!buildToolVersionsValid(report["buildToolVersions"])) return refuse();
  if (!optionalIdentityValid(report)) return refuse();
  return ADMITTED;
}

/**
 * The RUNTIME degenerate pin. `/bootstrap` serves only the wire protocol string,
 * and that string is the join of all three envelope versions
 * (command + query + error registry), so matching it pins every envelope version
 * at once - a compatible daemon cannot serve a drifted wire string, and a drifted
 * daemon cannot forge the matching one.
 *
 * This is DELIBERATELY NARROWER than `createCompatGate`: the offline gate also
 * checks `contractSchemaHash` and `apiCompatibilityRange`, neither of which the
 * runtime handshake exposes. Admitting on the wire string alone is a documented
 * narrowing, and it stays strictly stricter than admitting anything: it can refuse
 * a compatible daemon (its wire string differs), but it can never admit an
 * incompatible wire. The parameter is `unknown` because it crosses a trust
 * boundary - a missing, non-string, or drifted value all resolve to the same
 * shared `DISTRIBUTION_MISMATCH` refusal that exposes zero builders.
 */
export function admitByWireProtocol(protocolVersion: unknown): CompatGateResult {
  if (typeof protocolVersion === "string" && protocolVersion === GENERATED_WIRE_PROTOCOL_VERSION) {
    return ADMITTED;
  }
  return refuse();
}
