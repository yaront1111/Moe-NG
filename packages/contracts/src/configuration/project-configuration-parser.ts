import {
  hasExactKeys, isHex64, isPlainRecord, isSafeArray, isSafeCount,
} from "../runtime/runtime-guards.js";
import { SOURCE_SHA_LENGTHS } from "../distribution/distribution-contract.js";
import type { DistributionSource } from "../distribution/distribution-contract.js";
import type { GitObjectFormat } from "../phase0-evidence-contract.js";

import {
  PROJECT_CONFIGURATION_EGRESS_POLICIES,
  PROJECT_CONFIGURATION_EXPOSURE_POLICIES,
  PROJECT_CONFIGURATION_GATE_MODES,
  PROJECT_CONFIGURATION_HOST_CONTAINMENTS,
  PROJECT_CONFIGURATION_INPUT_INVALID,
  PROJECT_CONFIGURATION_LIMIT_KEYS,
  PROJECT_CONFIGURATION_SCHEMA_VERSION,
  PROJECT_CONFIGURATION_VERSION_UNSUPPORTED,
  PROJECT_CONFIGURATION_WORKSPACE_ISOLATIONS,
  isBoundedText,
  isLogicalRef,
} from "./project-configuration-contract.js";
import type {
  ProjectConfigurationIsolation,
  ProjectConfigurationLimitEntry,
  ProjectConfigurationManifestResult,
  ProjectConfigurationNetwork,
  ProjectConfigurationPolicy,
  ProjectConfigurationSchemaVersions,
  ProjectConfigurationSelection,
  ProjectConfigurationSettings,
  ProjectConfigurationSettingsResult,
} from "./project-configuration-contract.js";

const MANIFEST_KEYS = ["projectId", "schemaVersion", "settings", "settingsDigest"] as const;
const SETTINGS_KEYS = [
  "isolation", "limits", "network", "orchestrationSource", "policy", "schemaVersions", "selection",
] as const;
const POLICY_KEYS = [
  "acceptanceGate", "autoApprovalOptInDigest", "evaluatorVersion", "expansionGate",
  "planningGate", "policyRevisionId", "revision",
] as const;
const SELECTION_KEYS = [
  "modelRef", "profileRef", "providerRef", "reasoningEffortRef", "runtimeRef", "snapshotRef",
  "structuredOutputSchemaRef",
] as const;
const LIMIT_ENTRY_KEYS = ["key", "value"] as const;
const NETWORK_KEYS = ["daemonExposure", "providerEgress"] as const;
const ISOLATION_KEYS = ["hostContainment", "workspace"] as const;
const SCHEMA_VERSION_KEYS = [
  "commandSchemaVersion", "errorSchemaVersion", "querySchemaVersion",
] as const;
const SOURCE_KEYS = ["objectFormat", "sourceSha"] as const;

const LOWER_HEX = /^[0-9a-f]*$/u;
const AUTO_APPROVAL = "POLICY_AUTO_APPROVAL_OPT_IN";

/** Closed-vocabulary membership. A value outside the frozen list is never coerced in. */
function member<T extends string>(vocabulary: readonly T[], value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  return (vocabulary as readonly string[]).includes(value) ? (value as T) : undefined;
}

function parseSource(value: unknown): DistributionSource | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, SOURCE_KEYS, [])) return undefined;
  const objectFormat = value["objectFormat"];
  if (typeof objectFormat !== "string") return undefined;
  if (!Object.hasOwn(SOURCE_SHA_LENGTHS, objectFormat)) return undefined;
  const sourceSha = value["sourceSha"];
  const width = SOURCE_SHA_LENGTHS[objectFormat as GitObjectFormat];
  if (typeof sourceSha !== "string" || sourceSha.length !== width) return undefined;
  if (!LOWER_HEX.test(sourceSha)) return undefined;
  return Object.freeze({ objectFormat: objectFormat as GitObjectFormat, sourceSha });
}

/**
 * The table is DENSE and POSITIONAL: length equals the key vocabulary, entry `i` must
 * already carry key `i`. Nothing is sorted and nothing is filled in — a reordered or
 * short table is a different table, not a table to be rescued.
 */
function parseLimits(value: unknown): readonly ProjectConfigurationLimitEntry[] | undefined {
  if (!isSafeArray(value) || value.length !== PROJECT_CONFIGURATION_LIMIT_KEYS.length) {
    return undefined;
  }
  const entries: ProjectConfigurationLimitEntry[] = [];
  for (const [index, key] of PROJECT_CONFIGURATION_LIMIT_KEYS.entries()) {
    if (!Object.hasOwn(value, index)) return undefined;
    const entry = value[index];
    if (!isPlainRecord(entry) || !hasExactKeys(entry, LIMIT_ENTRY_KEYS, [])) return undefined;
    const limit = entry["value"];
    if (entry["key"] !== key || !isSafeCount(limit)) return undefined;
    entries.push(Object.freeze({ key, value: limit }));
  }
  return Object.freeze(entries);
}

/**
 * The opt-in digest and the gate modes are one fact in two fields, so both directions
 * refuse: an opt-in gate with no digest, and fully manual gates carrying one.
 */
function parsePolicy(value: unknown): ProjectConfigurationPolicy | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, POLICY_KEYS, [])) return undefined;
  const acceptanceGate = member(PROJECT_CONFIGURATION_GATE_MODES, value["acceptanceGate"]);
  const expansionGate = member(PROJECT_CONFIGURATION_GATE_MODES, value["expansionGate"]);
  const planningGate = member(PROJECT_CONFIGURATION_GATE_MODES, value["planningGate"]);
  if (acceptanceGate === undefined || expansionGate === undefined) return undefined;
  if (planningGate === undefined) return undefined;
  const policyRevisionId = value["policyRevisionId"];
  const evaluatorVersion = value["evaluatorVersion"];
  const revision = value["revision"];
  if (!isLogicalRef(policyRevisionId) || !isBoundedText(evaluatorVersion)) return undefined;
  if (!isSafeCount(revision)) return undefined;
  const digest = value["autoApprovalOptInDigest"];
  const optIn = [acceptanceGate, expansionGate, planningGate].includes(AUTO_APPROVAL);
  if (optIn && !isHex64(digest)) return undefined;
  if (!optIn && digest !== null) return undefined;
  return Object.freeze({
    acceptanceGate,
    autoApprovalOptInDigest: optIn ? (digest as string) : null,
    evaluatorVersion,
    expansionGate,
    planningGate,
    policyRevisionId,
    revision,
  });
}

function parseSelection(value: unknown): ProjectConfigurationSelection | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, SELECTION_KEYS, [])) return undefined;
  if (!SELECTION_KEYS.every((key) => isLogicalRef(value[key]))) return undefined;
  return Object.freeze({
    modelRef: value["modelRef"] as string,
    profileRef: value["profileRef"] as string,
    providerRef: value["providerRef"] as string,
    reasoningEffortRef: value["reasoningEffortRef"] as string,
    runtimeRef: value["runtimeRef"] as string,
    snapshotRef: value["snapshotRef"] as string,
    structuredOutputSchemaRef: value["structuredOutputSchemaRef"] as string,
  });
}

function parseNetwork(value: unknown): ProjectConfigurationNetwork | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, NETWORK_KEYS, [])) return undefined;
  const daemonExposure = member(PROJECT_CONFIGURATION_EXPOSURE_POLICIES, value["daemonExposure"]);
  const providerEgress = member(PROJECT_CONFIGURATION_EGRESS_POLICIES, value["providerEgress"]);
  if (daemonExposure === undefined || providerEgress === undefined) return undefined;
  return Object.freeze({ daemonExposure, providerEgress });
}

function parseIsolation(value: unknown): ProjectConfigurationIsolation | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ISOLATION_KEYS, [])) return undefined;
  const hostContainment =
    member(PROJECT_CONFIGURATION_HOST_CONTAINMENTS, value["hostContainment"]);
  const workspace = member(PROJECT_CONFIGURATION_WORKSPACE_ISOLATIONS, value["workspace"]);
  if (hostContainment === undefined || workspace === undefined) return undefined;
  return Object.freeze({ hostContainment, workspace });
}

function parseSchemaVersions(value: unknown): ProjectConfigurationSchemaVersions | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, SCHEMA_VERSION_KEYS, [])) return undefined;
  if (!SCHEMA_VERSION_KEYS.every((key) => isBoundedText(value[key]))) return undefined;
  return Object.freeze({
    commandSchemaVersion: value["commandSchemaVersion"] as string,
    errorSchemaVersion: value["errorSchemaVersion"] as string,
    querySchemaVersion: value["querySchemaVersion"] as string,
  });
}

/** All-or-none. A partially valid settings record yields no snapshot at all. */
function parseSettingsFields(
  value: Readonly<Record<string, unknown>>,
): ProjectConfigurationSettings | undefined {
  const isolation = parseIsolation(value["isolation"]);
  const limits = parseLimits(value["limits"]);
  const network = parseNetwork(value["network"]);
  const orchestrationSource = parseSource(value["orchestrationSource"]);
  const policy = parsePolicy(value["policy"]);
  const schemaVersions = parseSchemaVersions(value["schemaVersions"]);
  const selection = parseSelection(value["selection"]);
  if (isolation === undefined || limits === undefined || network === undefined) return undefined;
  if (orchestrationSource === undefined || policy === undefined) return undefined;
  if (schemaVersions === undefined || selection === undefined) return undefined;
  return Object.freeze({
    isolation, limits, network, orchestrationSource, policy, schemaVersions, selection,
  });
}

export function parseProjectConfigurationSettings(
  value: unknown,
): ProjectConfigurationSettingsResult {
  if (!isPlainRecord(value) || !hasExactKeys(value, SETTINGS_KEYS, [])) {
    return PROJECT_CONFIGURATION_INPUT_INVALID;
  }
  const settings = parseSettingsFields(value);
  if (settings === undefined) return PROJECT_CONFIGURATION_INPUT_INVALID;
  return Object.freeze({ ok: true as const, settings });
}

/**
 * Refusal order is fixed and asserted: structure, then schema version, then fields.
 * Two guards can both be true for one hostile record, so which one answers is part of
 * the contract rather than an accident of statement order.
 */
export function parseProjectConfigurationManifest(
  value: unknown,
): ProjectConfigurationManifestResult {
  if (!isPlainRecord(value) || !hasExactKeys(value, MANIFEST_KEYS, [])) {
    return PROJECT_CONFIGURATION_INPUT_INVALID;
  }
  if (value["schemaVersion"] !== PROJECT_CONFIGURATION_SCHEMA_VERSION) {
    return PROJECT_CONFIGURATION_VERSION_UNSUPPORTED;
  }
  const projectId = value["projectId"];
  const settingsDigest = value["settingsDigest"];
  if (!isLogicalRef(projectId) || !isHex64(settingsDigest)) {
    return PROJECT_CONFIGURATION_INPUT_INVALID;
  }
  const settings = parseProjectConfigurationSettings(value["settings"]);
  if (!settings.ok) return PROJECT_CONFIGURATION_INPUT_INVALID;
  return Object.freeze({
    manifest: Object.freeze({
      projectId,
      schemaVersion: PROJECT_CONFIGURATION_SCHEMA_VERSION,
      settings: settings.settings,
      settingsDigest,
    }),
    ok: true as const,
  });
}
