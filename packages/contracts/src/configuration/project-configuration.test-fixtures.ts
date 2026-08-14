/**
 * Hand-written expectations for the project configuration contract.
 *
 * Every list here is TRANSCRIBED FROM THE PINNED DESIGN, never read off the module
 * under test: a list derived from the exports agrees with them by construction and
 * would assert nothing. The limit keys come from design 2.1, 11.2 and 19.1, in that
 * order; the enum members from 11.6/8.4, 13.2, 19.2 and 19.3.
 */

/** Design 2.1 (11 keys), 11.2 (2 keys), 19.1 (17 keys) — 30 total, hand-counted. */
export const EXPECTED_LIMIT_KEYS: readonly string[] = [
  "providerSlotsPerProject", "providerSlotsPerGoal", "expansionDepthMax",
  "expansionWidthMax", "expansionNodesMax", "activeGoalNodesMax", "activeGoalHardEdgesMax",
  "priorityAgingQuantum", "fairnessTicketCeiling", "dispatchDecisionBoundMs",
  "reviewRoundsMax",
  "attemptsPerNodeLineage", "runnerAuthorizedMsPerAttempt",
  "commandBodyBytes", "canonicalJsonDepth", "individualStringBytes",
  "objectiveCriterionBytes", "submittedExpansionRelations", "activeNodes",
  "dispatchableFairnessTickets", "retainedEvents", "activeProviderSessions",
  "capturedOutputBytes", "uiTailBytes", "eventSubscribers", "waitersPerProject",
  "pendingOutboxRows", "presencePerSecond", "presenceBurst", "artifactStoreByteQuota",
];

export const EXPECTED_LIMIT_KEY_COUNT = 30;

export const EXPECTED_GATE_MODES: readonly string[] = [
  "MANUAL_HUMAN_APPROVAL", "POLICY_AUTO_APPROVAL_OPT_IN",
];
export const EXPECTED_EGRESS_POLICIES: readonly string[] = [
  "EGRESS_ALLOWLISTED", "EGRESS_DENIED", "EGRESS_UNRESTRICTED",
];
export const EXPECTED_EXPOSURE_POLICIES: readonly string[] = [
  "LOOPBACK_ONLY", "REVIEWED_AUTHENTICATED_NON_LOOPBACK",
];
export const EXPECTED_WORKSPACE_ISOLATIONS: readonly string[] = [
  "PER_ATTEMPT_WORKTREE", "SHARED_CHECKOUT",
];
export const EXPECTED_HOST_CONTAINMENTS: readonly string[] = ["NOT_CLAIMED", "SANDBOX_ENFORCED"];
export const EXPECTED_REFUSAL_CODES: readonly string[] = [
  "PROJECT_CONFIGURATION_INPUT_INVALID", "PROJECT_CONFIGURATION_VERSION_UNSUPPORTED",
];
export const EXPECTED_REFUSAL_LAYERS: readonly string[] = ["PROJECT_CONFIGURATION_MANIFEST"];
export const EXPECTED_SCHEMA_VERSION = "moe-project-configuration/1";

export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);
export const SOURCE_SHA_256 = "c".repeat(64);

/** A mutable, non-frozen input tree. Each call returns a fresh graph. */
export function validSettingsInput(): Record<string, unknown> {
  return {
    isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
    limits: EXPECTED_LIMIT_KEYS.map((key, index) => ({ key, value: index })),
    network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
    orchestrationSource: { objectFormat: "sha256", sourceSha: SOURCE_SHA_256 },
    policy: {
      acceptanceGate: "MANUAL_HUMAN_APPROVAL",
      autoApprovalOptInDigest: null,
      evaluatorVersion: "moe-policy-evaluator/1",
      expansionGate: "MANUAL_HUMAN_APPROVAL",
      planningGate: "MANUAL_HUMAN_APPROVAL",
      policyRevisionId: "policy-revision-7",
      revision: 7,
    },
    schemaVersions: {
      commandSchemaVersion: "moe-command-envelope/1",
      errorSchemaVersion: "moe-error-registry/1",
      querySchemaVersion: "moe-query-envelope/1",
    },
    selection: {
      modelRef: "gpt-4.1-mini",
      profileRef: "profile_v2",
      providerRef: "anthropic-claude",
      reasoningEffortRef: "effort.high",
      runtimeRef: "runtime-node22",
      snapshotRef: "snapshot-2026-08-14",
      structuredOutputSchemaRef: "schema.plan.v1",
    },
  };
}

export function validManifestInput(): Record<string, unknown> {
  return {
    projectId: "proj-dd087108",
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    settings: validSettingsInput(),
    settingsDigest: DIGEST_A,
  };
}

/**
 * Filesystem and URI spellings that must ALL refuse. The predicate under test is one
 * rule (no separator, no leading dot, bounded, well-formed NFC), so this table tests
 * the rule rather than defining it — which is why {@link LEGITIMATE_REFS} exists.
 */
export const HOSTILE_REFS: readonly (readonly [string, string])[] = [
  ["windows drive backslash", "C:\\model"],
  ["windows drive forward slash", "C:/model"],
  ["windows drive relative", "C:model"],
  ["unc share", "\\\\host\\share"],
  ["posix absolute", "/etc/model"],
  ["dot segment current", "./model"],
  ["dot segment parent", "../model"],
  ["bare dot", "."],
  ["bare dot dot", ".."],
  ["file uri", "file:///model"],
  ["file uri with host", "file://host/model"],
  ["nested relative", "models/gpt"],
  ["embedded nul", "mo\u0000del"],
  ["lone surrogate", "mo\uD800del"],
  ["denormalized nfc", "e\u0301clair"],
  ["over long", "m".repeat(129)],
  ["empty", ""],
];

/** Legitimate refs that must ALL be accepted: without these an always-refusing
 *  predicate would satisfy every row of {@link HOSTILE_REFS}. */
export const LEGITIMATE_REFS: readonly string[] = [
  "gpt-4.1-mini", "anthropic-claude", "profile_v2", "effort.high",
  "runtime-node22", "snapshot-2026-08-14", "schema.plan.v1", "m".repeat(128),
];
