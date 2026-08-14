import type { DistributionSource } from "../distribution/distribution-contract.js";

export const PROJECT_CONFIGURATION_SCHEMA_VERSION = "moe-project-configuration/1" as const;

/**
 * The ordered authority limit vocabulary, frozen key-by-key from the pinned design.
 * ORDER IS PART OF THE CONTRACT: a stored table is compared positionally, so a
 * reordered table is a different table and is refused rather than sorted back.
 *
 * The design's NUMBERS are deliberately absent. Every value is required caller
 * input; this package invents no default and a missing value fails closed.
 */
export const PROJECT_CONFIGURATION_LIMIT_KEYS = Object.freeze([
  // Design 2.1 — provider slots, expansion budget, active graph, scheduler, review.
  "providerSlotsPerProject", "providerSlotsPerGoal", "expansionDepthMax",
  "expansionWidthMax", "expansionNodesMax", "activeGoalNodesMax", "activeGoalHardEdgesMax",
  "priorityAgingQuantum", "fairnessTicketCeiling", "dispatchDecisionBoundMs",
  "reviewRoundsMax",
  // Design 11.2 — v1 meters and policy limits.
  "attemptsPerNodeLineage", "runnerAuthorizedMsPerAttempt",
  // Design 19.1 — versioned input and backpressure limits.
  "commandBodyBytes", "canonicalJsonDepth", "individualStringBytes",
  "objectiveCriterionBytes", "submittedExpansionRelations", "activeNodes",
  "dispatchableFairnessTickets", "retainedEvents", "activeProviderSessions",
  "capturedOutputBytes", "uiTailBytes", "eventSubscribers", "waitersPerProject",
  "pendingOutboxRows", "presencePerSecond", "presenceBurst", "artifactStoreByteQuota",
] as const);

/**
 * Design 11.6 and 8.4: a human approval gate, or the opt-in policy auto-approval
 * that produces a real `DAEMON_VERIFIED` ApprovalDecision. Absence of a decision
 * is not a member — it is not a gate mode at all.
 */
export const PROJECT_CONFIGURATION_GATE_MODES = Object.freeze([
  "MANUAL_HUMAN_APPROVAL", "POLICY_AUTO_APPROVAL_OPT_IN",
] as const);

/** Design 13.2: the declared provider-environment network policy. */
export const PROJECT_CONFIGURATION_EGRESS_POLICIES = Object.freeze([
  "EGRESS_ALLOWLISTED", "EGRESS_DENIED", "EGRESS_UNRESTRICTED",
] as const);

/** Design 19.2: loopback is the only default bind; non-loopback needs reviewed policy. */
export const PROJECT_CONFIGURATION_EXPOSURE_POLICIES = Object.freeze([
  "LOOPBACK_ONLY", "REVIEWED_AUTHENTICATED_NON_LOOPBACK",
] as const);

/** Design 13.2: per-attempt worktree, or a shared checkout recorded honestly as such. */
export const PROJECT_CONFIGURATION_WORKSPACE_ISOLATIONS = Object.freeze([
  "PER_ATTEMPT_WORKTREE", "SHARED_CHECKOUT",
] as const);

/**
 * Design 19.3: v1 explicitly does NOT claim containment against a same-user host
 * process. The vocabulary exists so a project can record that truth rather than
 * leave it implied; `SANDBOX_ENFORCED` is representable only for a later layer
 * that actually proves it.
 */
export const PROJECT_CONFIGURATION_HOST_CONTAINMENTS = Object.freeze([
  "NOT_CLAIMED", "SANDBOX_ENFORCED",
] as const);

export const PROJECT_CONFIGURATION_REFUSAL_CODES = Object.freeze([
  "PROJECT_CONFIGURATION_INPUT_INVALID", "PROJECT_CONFIGURATION_VERSION_UNSUPPORTED",
] as const);

export const PROJECT_CONFIGURATION_REFUSAL_LAYERS = Object.freeze([
  "PROJECT_CONFIGURATION_MANIFEST",
] as const);

export type ProjectConfigurationLimitKey = (typeof PROJECT_CONFIGURATION_LIMIT_KEYS)[number];
export type ProjectConfigurationGateMode = (typeof PROJECT_CONFIGURATION_GATE_MODES)[number];
export type ProjectConfigurationEgressPolicy =
  (typeof PROJECT_CONFIGURATION_EGRESS_POLICIES)[number];
export type ProjectConfigurationExposurePolicy =
  (typeof PROJECT_CONFIGURATION_EXPOSURE_POLICIES)[number];
export type ProjectConfigurationWorkspaceIsolation =
  (typeof PROJECT_CONFIGURATION_WORKSPACE_ISOLATIONS)[number];
export type ProjectConfigurationHostContainment =
  (typeof PROJECT_CONFIGURATION_HOST_CONTAINMENTS)[number];
export type ProjectConfigurationRefusalCode =
  (typeof PROJECT_CONFIGURATION_REFUSAL_CODES)[number];
export type ProjectConfigurationRefusalLayer =
  (typeof PROJECT_CONFIGURATION_REFUSAL_LAYERS)[number];

export interface ProjectConfigurationRefusal {
  readonly code: ProjectConfigurationRefusalCode;
  readonly layer: ProjectConfigurationRefusalLayer;
  readonly ok: false;
}

/**
 * Design 11.6: the immutable policy revision and evaluator version that decided,
 * plus the three approval gates. `autoApprovalOptInDigest` is present exactly when
 * some gate is `POLICY_AUTO_APPROVAL_OPT_IN` — the opt-in is a named artifact, never
 * an implied default.
 */
export interface ProjectConfigurationPolicy {
  readonly acceptanceGate: ProjectConfigurationGateMode;
  readonly autoApprovalOptInDigest: string | null;
  readonly evaluatorVersion: string;
  readonly expansionGate: ProjectConfigurationGateMode;
  readonly planningGate: ProjectConfigurationGateMode;
  readonly policyRevisionId: string;
  readonly revision: number;
}

/**
 * Seven LOGICAL selection references. Each is a single opaque token, never a
 * filesystem path: no drive, UNC, POSIX-absolute, file-URI or dot-segment spelling
 * can satisfy the token rule, so the closed contract carries no path key at all.
 */
export interface ProjectConfigurationSelection {
  readonly modelRef: string;
  readonly profileRef: string;
  readonly providerRef: string;
  readonly reasoningEffortRef: string;
  readonly runtimeRef: string;
  readonly snapshotRef: string;
  readonly structuredOutputSchemaRef: string;
}

/** One positional cell of the ordered limit table. */
export interface ProjectConfigurationLimitEntry {
  readonly key: ProjectConfigurationLimitKey;
  readonly value: number;
}

/** Design 13.2 and 19.2: provider egress out, daemon exposure in. */
export interface ProjectConfigurationNetwork {
  readonly daemonExposure: ProjectConfigurationExposurePolicy;
  readonly providerEgress: ProjectConfigurationEgressPolicy;
}

/** Design 13.2 and 19.3: what isolation actually holds, stated without overclaim. */
export interface ProjectConfigurationIsolation {
  readonly hostContainment: ProjectConfigurationHostContainment;
  readonly workspace: ProjectConfigurationWorkspaceIsolation;
}

/** Design 17: the canonical command, query and error schema versions in force. */
export interface ProjectConfigurationSchemaVersions {
  readonly commandSchemaVersion: string;
  readonly errorSchemaVersion: string;
  readonly querySchemaVersion: string;
}

/**
 * The complete effective authority of one project. Every field is required input.
 * There is no digest here: a digest over the settings cannot be one of the settings
 * it covers, so `settingsDigest` lives only on the manifest.
 */
export interface ProjectConfigurationSettings {
  readonly isolation: ProjectConfigurationIsolation;
  readonly limits: readonly ProjectConfigurationLimitEntry[];
  readonly network: ProjectConfigurationNetwork;
  readonly orchestrationSource: DistributionSource;
  readonly policy: ProjectConfigurationPolicy;
  readonly schemaVersions: ProjectConfigurationSchemaVersions;
  readonly selection: ProjectConfigurationSelection;
}

export interface ProjectConfigurationManifest {
  readonly projectId: string;
  readonly schemaVersion: typeof PROJECT_CONFIGURATION_SCHEMA_VERSION;
  readonly settings: ProjectConfigurationSettings;
  readonly settingsDigest: string;
}

export type ProjectConfigurationSettingsResult =
  | { readonly ok: true; readonly settings: ProjectConfigurationSettings }
  | ProjectConfigurationRefusal;

export type ProjectConfigurationManifestResult =
  | { readonly manifest: ProjectConfigurationManifest; readonly ok: true }
  | ProjectConfigurationRefusal;

/**
 * Module-constant refusals. They are frozen singletons carrying nothing observed at
 * the failure site, so a refusal can never leak the hostile input that produced it.
 */
export const PROJECT_CONFIGURATION_INPUT_INVALID: ProjectConfigurationRefusal = Object.freeze({
  code: "PROJECT_CONFIGURATION_INPUT_INVALID" as const,
  layer: "PROJECT_CONFIGURATION_MANIFEST" as const,
  ok: false as const,
});

export const PROJECT_CONFIGURATION_VERSION_UNSUPPORTED: ProjectConfigurationRefusal =
  Object.freeze({
    code: "PROJECT_CONFIGURATION_VERSION_UNSUPPORTED" as const,
    layer: "PROJECT_CONFIGURATION_MANIFEST" as const,
    ok: false as const,
  });

export const PROJECT_CONFIGURATION_MAX_REF_CHARS = 128;

/**
 * A logical reference token: bounded, well-formed, NFC, and free of every separator
 * a filesystem spelling needs. Refusing `/`, `\` and `:` categorically excludes
 * `C:\x`, `C:/x`, `C:x`, `\\host\share`, `/etc/x` and `file:///x` without
 * enumerating them; refusing a leading `.` excludes `.`, `..`, `./x` and `../x`.
 */
export function isLogicalRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > PROJECT_CONFIGURATION_MAX_REF_CHARS) return false;
  if (!value.isWellFormed() || value.normalize("NFC") !== value) return false;
  if (value.startsWith(".")) return false;
  for (const unit of value) {
    if (unit === "/" || unit === "\\" || unit === ":") return false;
    if (unit <= "\u001f" || unit === "\u007f") return false;
  }
  return true;
}
