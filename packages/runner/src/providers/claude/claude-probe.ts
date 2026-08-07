import { deepFreeze } from "../../canonical.js";
import {
  CLAUDE_CAPABILITY_PROFILE_VERSION,
  UNPROVEN_PROBE_REPORT,
  assessCapabilities,
  capabilitySchemaDigestOf,
  isBoundedLabel,
  resolveContextLimit,
  type ClaudeCapability,
  type ClaudeCapabilityProfile,
  type ClaudeCapabilityStatus,
  type ClaudeContextPolicy,
  type ClaudeProbePort,
  type ClaudeProbeReport,
} from "./claude-capabilities.js";
import {
  buildProviderRuntimeObservation,
  type ClaudeFailure,
  type ClaudeObservationErrorCode,
  type ObservationClock,
  type PlatformIdentity,
  type ProviderRuntimeObservation,
} from "./claude-observation.js";

/**
 * The capability probe itself. Vocabulary and proof rules live in
 * `claude-capabilities.ts`; this module only orchestrates them and binds the
 * resulting profile to the runtime observation it was derived from, so a later
 * `AdmissionQuote` can be bound to one digest that covers both.
 *
 * It has no process authority: it calls an injected port and never spawns,
 * signals, pins, or activates anything.
 */
export interface ProbeClaudeRuntimeInput {
  readonly port: ClaudeProbePort;
  readonly clock: ObservationClock;
  readonly platformIdentity: PlatformIdentity;
}

export interface ProbeClaudeRuntimeOk {
  readonly ok: true;
  readonly profile: ClaudeCapabilityProfile;
  readonly observation: ProviderRuntimeObservation;
}

export type ProbeClaudeRuntimeResult =
  | ProbeClaudeRuntimeOk
  | ClaudeFailure<ClaudeObservationErrorCode>;

/**
 * A port that throws is not an error: it is a probe that proved nothing, which
 * is a legitimate — and fully `UNSUPPORTED` — result. Only caller-supplied facts
 * being unusable (platform identity, clock) fail closed, because those are not
 * observations about the runtime and guessing them would corrupt the digest.
 */
export function probeClaudeRuntime(input: ProbeClaudeRuntimeInput): ProbeClaudeRuntimeResult {
  let report: ClaudeProbeReport;
  try {
    report = input.port.report();
  } catch {
    report = UNPROVEN_PROBE_REPORT;
  }
  const contextLimit = resolveContextLimit(report.declaredContextLimit);
  const contextPolicy: ClaudeContextPolicy =
    contextLimit.kind === "UNKNOWN" ? "HOLD_UNKNOWN" : "ADMISSIBLE";
  const capabilities = assessCapabilities(report, contextLimit);
  const profile = deepFreeze({
    profileVersion: CLAUDE_CAPABILITY_PROFILE_VERSION,
    capabilities,
    contextLimit,
    contextPolicy,
    capabilitySchemaDigest: capabilitySchemaDigestOf(capabilities, contextLimit, contextPolicy),
  } satisfies ClaudeCapabilityProfile);
  const observed = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: report.resolvedRuntimeClosure,
    reportedVersion: isBoundedLabel(report.reportedVersion) ? report.reportedVersion : null,
    adapterCapabilitySchemaDigest: profile.capabilitySchemaDigest,
    pinningMethod: report.pinningMethod,
    platformIdentity: input.platformIdentity,
    clock: input.clock,
  });
  if (!observed.ok) {
    return observed;
  }
  return Object.freeze({ ok: true as const, profile, observation: observed.observation });
}

/** Reads a single capability, defaulting to UNSUPPORTED rather than throwing. */
export function capabilityStatus(
  profile: ClaudeCapabilityProfile,
  capability: ClaudeCapability,
): ClaudeCapabilityStatus {
  return (
    profile.capabilities.find((entry) => entry.capability === capability)?.status ?? "UNSUPPORTED"
  );
}

export {
  CLAUDE_CAPABILITIES,
  CLAUDE_CAPABILITY_PROFILE_VERSION,
  CLAUDE_CAPABILITY_STATUSES,
  CLAUDE_CONTEXT_POLICIES,
  CLAUDE_PROOF_METHODS,
} from "./claude-capabilities.js";
export type {
  ClaudeCancelObservation,
  ClaudeCapability,
  ClaudeCapabilityProfile,
  ClaudeCapabilityRecord,
  ClaudeCapabilityStatus,
  ClaudeContextLimit,
  ClaudeContextPolicy,
  ClaudeProbePort,
  ClaudeProbeReport,
  ClaudeProcessTreeObservation,
  ClaudeProofMethod,
  ClaudeRunEnumerationObservation,
  ClaudeStructuredSample,
  ClaudeTokenizerObservation,
} from "./claude-capabilities.js";
