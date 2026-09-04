/**
 * The world the node-brief producer is graded against, built by PRODUCTION writers.
 *
 * The active graph comes from `activateApprovedGraph` — the real transition service — over the
 * shipped bootstrap sequence, so `readCurrentActiveGraph` answers for a project whose graph a
 * command wrote. Nothing here hand-commits a graph revision, and no brief is hand-built: the
 * suite only ever reads what the production readers hand back.
 *
 * The repository scope is the REAL `resolveFoundationRepositoryScope` over a decoded catalog and
 * the same store, so the workspace proposal is the authority's answer rather than a literal.
 *
 * Capabilities need their own store: `resolveCurrentProviderProfile` binds the configuration's
 * limits to the probed profile's, and the bootstrap sequence's probe carries a different limit
 * table than the configuration below. That store exists only to feed the off-limits consumer's
 * three non-mission inputs; the mission under test never comes from it.
 */

import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import type { ProjectConfigurationLimitKey } from "@moe/contracts";
import {
  CONTEXT_MANIFEST_VERSION, DEFAULT_CONTEXT_BYTE_BUDGET, renderContext, selectContext,
} from "@moe/context";
import type { RenderedContext } from "@moe/context";
import {
  createProjectConfigurationManifest, encodeProjectConfigurationManifest,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  OBSERVATION, POLICY_REF, POLICY_SLICE, PROJECT_ID,
  activatePayload, envelope, evaluationInput, hex64, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { selectProjectConfiguration } from "../configuration/project-configuration-selection.js";
import {
  VERIFICATION_CATALOG_VERSION,
} from "../evidence/verification-catalog-contracts.js";
import {
  createVerificationCatalogReader,
} from "../evidence/verification-catalog-reader.js";
import type { VerificationCatalogReader } from "../evidence/verification-catalog-reader.js";
import { resolveCurrentProviderProfile } from "../provider-profile/provider-profile-resolver.js";
import {
  decodeFoundationRepositoryScopeCatalog, resolveFoundationRepositoryScope,
} from "../work/foundation-repository-scope-authority.js";
import {
  FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
} from "../work/foundation-repository-scope-contracts.js";
import type {
  FoundationRepositoryScopeResult,
} from "../work/foundation-repository-scope-contracts.js";
import { activateApprovedGraph } from "./graph-activation-service.js";
import {
  approvableStore, contextFor, inputFor, requestFor,
} from "./graph-activation-test-fixtures.js";
import type { NodeBriefDeps } from "./node-mission-producer.js";

export { PROJECT_ID, closeStores } from "../bootstrap/bootstrap-test-fixtures.js";

/**
 * The node the shipped journey seals, and the durable objective/capability it carries. Spelled
 * here so an assertion can name the EXPECTED text; every arm still reads the value back through
 * the production closure reader rather than trusting these.
 */
export const NODE_KEY = "node-a";
export const NODE_OBJECTIVE = "Land node-a.";
export const NODE_CAPABILITY = "capability-implement";
export const ABSENT_NODE_KEY = "node-zeta";

export const SOURCE_ROOT = "D:\\projexts\\moe-next";
export const WORKTREE_PARENT = "D:\\projexts\\moe-worktrees";
export const CATALOG_ARGV = Object.freeze(["pnpm", "--filter", "@moe/daemon", "test"]);
export const CATALOG_TEST_STRING = "pnpm --filter @moe/daemon test";

const PROFILE_REF = "profile-ref-1";
const MINIMUM_REF = "provider-profile-1";

export const RUNTIME_FACTS = Object.freeze({
  adapterCapabilitySchemaDigest: hex64("ca9ab111"),
  platformIdentity: "win32-x64",
  reportedVersion: "2.0.30",
});

const SELECTION = Object.freeze({
  modelRef: "model-ref-1",
  profileRef: PROFILE_REF,
  providerRef: "provider-ref-1",
  reasoningEffortRef: "reasoning-effort-ref-1",
  runtimeRef: "runtime-ref-1",
  snapshotRef: "snapshot-ref-1",
  structuredOutputSchemaRef: "structured-output-schema-ref-1",
});

/** A store whose graph the PRODUCTION activation service made ACTIVE. */
export function activeGraphStore(): SqliteEventStore {
  const store = approvableStore();
  const outcome = activateApprovedGraph(
    contextFor(store, requestFor("cmd-activate-brief")), inputFor(store));
  if (!outcome.ok) {
    throw new Error(`fixture activation refused: ${outcome.code}@${outcome.refusedBy}`);
  }
  return store;
}

/** The same shipped sequence, stopped BEFORE the activation: readable, and with no ACTIVE graph. */
export function inactiveGraphStore(): SqliteEventStore {
  return approvableStore();
}

export function catalogEntry(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    argv: [...CATALOG_ARGV],
    capability: NODE_CAPABILITY,
    profileRevisionId: PROFILE_REF,
    projectId: PROJECT_ID,
    ...overrides,
  };
}

/** The reader over an in-memory catalog value: host-scoped config, with no path opened. */
export function catalogReader(
  entries: readonly Record<string, unknown>[] = [catalogEntry()],
): VerificationCatalogReader {
  return createVerificationCatalogReader({
    catalogSource: (): unknown => ({ catalogVersion: VERIFICATION_CATALOG_VERSION, entries }),
  });
}

/** A reader for a project the operator's catalog never mentions. */
export function foreignCatalogReader(): VerificationCatalogReader {
  return catalogReader([catalogEntry({ projectId: "project-elsewhere" })]);
}

export function scopeCatalogEntry(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    declaredPaths: ["apps/daemon/src"],
    projectId: PROJECT_ID,
    repositoryRef: OBSERVATION.repositoryRef,
    scopeRef: OBSERVATION.scopeRef,
    sourceRepositoryRoot: SOURCE_ROOT,
    worktreeParent: WORKTREE_PARENT,
    ...overrides,
  };
}

/** The REAL resolver's answer for this store, never a hand-built authority record. */
export function repositoryScopeFor(
  store: SqliteEventStore,
  entries: readonly Record<string, unknown>[] = [scopeCatalogEntry()],
): () => FoundationRepositoryScopeResult {
  const decoded = decodeFoundationRepositoryScopeCatalog({
    catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION, entries,
  });
  if (!decoded.ok) throw new Error(`fixture scope catalog refused: ${decoded.code}`);
  return (): FoundationRepositoryScopeResult => resolveFoundationRepositoryScope(
    store, decoded.catalog, {
      baseRevisionHash: OBSERVATION.baseRevisionHash,
      projectId: PROJECT_ID,
      repositoryRef: OBSERVATION.repositoryRef,
      scopeRef: OBSERVATION.scopeRef,
    });
}

export function depsFor(
  store: SqliteEventStore,
  overrides: Partial<NodeBriefDeps> = {},
): NodeBriefDeps {
  return {
    catalog: catalogReader(),
    repositoryScope: repositoryScopeFor(store),
    store,
    ...overrides,
  };
}

/** A rendered context the REAL renderer produced, never a literal. */
export function renderedContext(): RenderedContext {
  const selected = selectContext({
    byteBudget: DEFAULT_CONTEXT_BYTE_BUDGET,
    exclusions: [{ itemId: "journal-9", reason: "beyond the journal entry limit" }],
    mandatory: [{ content: "the node brief", id: "mission-1", kind: "MANDATORY",
      section: "mission" }],
    optional: [{ content: "a prior dead end", id: "journal-1", kind: "OPTIONAL", priority: 2,
      section: "journal" }],
  });
  if (selected.kind !== "ADMITTED") {
    throw new Error(`fixture selection refused: ${selected.code}`);
  }
  const value = renderContext(selected.selection);
  if (value.manifest.version !== CONTEXT_MANIFEST_VERSION) {
    throw new Error("fixture render carries an unexpected manifest version");
  }
  return value;
}

/** Positional table: the value a key carries is its index, so every entry is distinguishable. */
const limitValue = (key: ProjectConfigurationLimitKey): number =>
  PROJECT_CONFIGURATION_LIMIT_KEYS.indexOf(key) + 1;

function profileBody(): Record<string, unknown> {
  return {
    capabilitySchemaDigest: hex64("ca9ab111"),
    concurrencyCeiling: limitValue("activeProviderSessions"),
    limits: {
      stderrBytes: limitValue("capturedOutputBytes"),
      stdoutBytes: limitValue("capturedOutputBytes"),
      tailBytes: limitValue("uiTailBytes"),
      timeoutMs: limitValue("runnerAuthorizedMsPerAttempt"),
    },
    modelSnapshotEvidence: "claude-cli-2.0.30-2026-05-01",
    modelSnapshotKind: "DATED_SNAPSHOT",
    profileRevisionId: PROFILE_REF,
    provider: "claude",
    providerMinimumProfileRef: MINIMUM_REF,
    reasoningEffort: "high",
    selectedModelId: "claude-opus-5",
    selection: SELECTION,
  };
}

function settingsBody(): Record<string, unknown> {
  return {
    isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
    limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key) => ({ key, value: limitValue(key) })),
    network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
    orchestrationSource: { objectFormat: "sha256", sourceSha: hex64("0c5") },
    policy: {
      acceptanceGate: "MANUAL_HUMAN_APPROVAL",
      autoApprovalOptInDigest: null,
      evaluatorVersion: "policy-evaluator-v1",
      expansionGate: "MANUAL_HUMAN_APPROVAL",
      planningGate: "MANUAL_HUMAN_APPROVAL",
      policyRevisionId: "policy-revision-1",
      revision: 1,
    },
    schemaVersions: {
      commandSchemaVersion: "moe-command-1",
      errorSchemaVersion: "moe-error-1",
      querySchemaVersion: "moe-query-1",
    },
    selection: SELECTION,
  };
}

/** Drives the production writers. A refused setup throws rather than leaving an empty store. */
export function capabilities(): unknown {
  const store = openStore();
  const steps = [
    envelope("project.register", 0, { owner: "owner-1" }),
    envelope("project.bind_repository", 1, { observation: OBSERVATION }),
    envelope("provider.probe", 0, {
      observation: {
        profile: profileBody(), providerMinimumProfileRef: MINIMUM_REF,
        truthClass: "DAEMON_VERIFIED",
      },
    }),
    envelope("policy.install", 0, { slice: POLICY_SLICE }),
    envelope("policy.validate", 1, { input: evaluationInput(POLICY_REF) }),
    envelope("project.activate", 2, activatePayload()),
  ];
  for (const step of steps) {
    const outcome = send(store, step);
    if (!outcome.ok) throw new Error(`seed failed at ${step.kind}: ${outcome.code}`);
  }
  const created = createProjectConfigurationManifest(PROJECT_ID, settingsBody());
  if (!created.ok) throw new Error(`seed manifest refused: ${created.code}`);
  const encoded = encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(`seed encode refused: ${encoded.code}`);
  const selected = selectProjectConfiguration(store, {
    commandId: "configuration-command-1",
    correlationId: "correlation-configuration-1",
    decidedAt: "2026-08-19T18:00:00.000Z",
    expectedVersion: 0,
    manifestBytes: encoded.bytes,
    principalId: "principal-1",
    projectId: PROJECT_ID,
  });
  if (!selected.ok) throw new Error(`seed selection refused: ${selected.code}`);
  return resolveCurrentProviderProfile(store, {
    expectedConfigurationDigest: created.manifest.settingsDigest,
    projectId: PROJECT_ID,
  });
}
