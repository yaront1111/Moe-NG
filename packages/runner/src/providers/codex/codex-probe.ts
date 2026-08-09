import { deepFreeze } from "../../canonical.js";
import {
  CODEX_CAPABILITY_PROFILE_VERSION,
  UNPROVEN_PROBE_REPORT,
  assessCapabilities,
  capabilitySchemaDigestOf,
  isBoundedLabel,
  resolveContextLimit,
  type CodexCapability,
  type CodexCapabilityProfile,
  type CodexCapabilityStatus,
  type CodexContextPolicy,
  type CodexProbePort,
  type CodexProbeReport,
} from "./codex-capabilities.js";
import {
  buildProviderRuntimeObservation,
  type CodexFailure,
  type CodexObservationErrorCode,
  type ObservationClock,
  type PlatformIdentity,
  type ProviderRuntimeObservation,
} from "./codex-observation.js";

export interface ProbeCodexRuntimeInput {
  readonly port: CodexProbePort;
  readonly clock: ObservationClock;
  readonly platformIdentity: PlatformIdentity;
}

export interface ProbeCodexRuntimeOk {
  readonly ok: true;
  readonly profile: CodexCapabilityProfile;
  readonly observation: ProviderRuntimeObservation;
}

export type ProbeCodexRuntimeResult =
  | ProbeCodexRuntimeOk
  | CodexFailure<CodexObservationErrorCode>;

const REPORT_KEYS = Object.freeze([
  "resolvedRuntimeClosure", "reportedVersion", "schemaVersion", "pinningMethod",
  "structuredSample", "rawSampleBase64", "cancelObservation", "cwdObservation",
  "processTreeObservation", "runEnumeration", "tokenizer", "declaredContextLimit",
  "helpText", "resumeClaim",
] as const);

function completeReport(value: unknown): value is CodexProbeReport {
  return typeof value === "object" && value !== null &&
    REPORT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function readReport(port: CodexProbePort): CodexProbeReport {
  try {
    const report: unknown = port.report();
    return completeReport(report) ? report : UNPROVEN_PROBE_REPORT;
  } catch {
    return UNPROVEN_PROBE_REPORT;
  }
}

function buildProfile(report: CodexProbeReport): CodexCapabilityProfile {
  const contextLimit = resolveContextLimit(report.declaredContextLimit);
  const contextPolicy: CodexContextPolicy =
    contextLimit.kind === "UNKNOWN" ? "HOLD_UNKNOWN" : "ADMISSIBLE";
  const capabilities = assessCapabilities(report, contextLimit);
  return deepFreeze({
    profileVersion: CODEX_CAPABILITY_PROFILE_VERSION,
    capabilities,
    contextLimit,
    contextPolicy,
    capabilitySchemaDigest: capabilitySchemaDigestOf(capabilities, contextLimit, contextPolicy),
  } satisfies CodexCapabilityProfile);
}

function probeWithReport(
  input: ProbeCodexRuntimeInput,
  report: CodexProbeReport,
): ProbeCodexRuntimeResult {
  const profile = buildProfile(report);
  const observed = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: report.resolvedRuntimeClosure,
    reportedVersion: isBoundedLabel(report.reportedVersion) ? report.reportedVersion : null,
    adapterCapabilitySchemaDigest: profile.capabilitySchemaDigest,
    pinningMethod: report.pinningMethod,
    platformIdentity: input.platformIdentity,
    clock: input.clock,
  });
  if (!observed.ok) return observed;
  return Object.freeze({ ok: true as const, profile, observation: observed.observation });
}

export function probeCodexRuntime(input: ProbeCodexRuntimeInput): ProbeCodexRuntimeResult {
  const report = readReport(input.port);
  try {
    return probeWithReport(input, report);
  } catch {
    return probeWithReport(input, UNPROVEN_PROBE_REPORT);
  }
}

export function capabilityStatus(
  profile: CodexCapabilityProfile,
  capability: CodexCapability,
): CodexCapabilityStatus {
  return profile.capabilities.find((entry) => entry.capability === capability)?.status ??
    "UNSUPPORTED";
}

export {
  CODEX_CAPABILITIES,
  CODEX_CAPABILITY_PROFILE_VERSION,
  CODEX_CAPABILITY_STATUSES,
  CODEX_CONTEXT_POLICIES,
  CODEX_PROOF_METHODS,
} from "./codex-capabilities.js";
