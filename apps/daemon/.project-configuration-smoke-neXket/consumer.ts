
import assert from "node:assert/strict";
import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import { createProjectConfigurationManifest, encodeProjectConfigurationManifest } from "@moe/core";
import { readCurrentProjectConfiguration, selectProjectConfiguration } from "@moe/daemon";
import { SqliteEventStore } from "@moe/store";
const projectId = "package-root-configuration-smoke";
const settings = {
  isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
  limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key, index) => ({ key, value: index + 1 })),
  network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
  orchestrationSource: { objectFormat: "sha256", sourceSha: "2".repeat(64) },
  policy: { acceptanceGate: "MANUAL_HUMAN_APPROVAL", autoApprovalOptInDigest: null,
    evaluatorVersion: "policy-evaluator-v1", expansionGate: "MANUAL_HUMAN_APPROVAL",
    planningGate: "MANUAL_HUMAN_APPROVAL", policyRevisionId: "policy-revision-1", revision: 1 },
  schemaVersions: { commandSchemaVersion: "moe-command-1", errorSchemaVersion: "moe-error-1",
    querySchemaVersion: "moe-query-1" },
  selection: { modelRef: "model-1", profileRef: "profile-1", providerRef: "provider-1",
    reasoningEffortRef: "effort-1", runtimeRef: "runtime-1", snapshotRef: "snapshot-1",
    structuredOutputSchemaRef: "schema-1" },
};
const created = createProjectConfigurationManifest(projectId, settings);
if (!created.ok) throw new Error(created.code);
const encoded = encodeProjectConfigurationManifest(created.manifest);
if (!encoded.ok) throw new Error(encoded.code);
let store = SqliteEventStore.openForProject("/mnt/d/projexts/moe-next/apps/daemon/.project-configuration-smoke-neXket/consumer.db", projectId);
try {
  const selected = selectProjectConfiguration(store, { projectId, commandId: "command-1",
    correlationId: "correlation-1", decidedAt: "2026-08-15T18:00:00.000Z",
    principalId: "principal-1", expectedVersion: 0, manifestBytes: encoded.bytes });
  assert.deepStrictEqual(selected, { authority: "DAEMON_VERIFIED", evidence: "DURABLE",
    manifest: created.manifest, manifestBytes: encoded.bytes, ok: true, outcome: "SELECTED",
    selectionVersion: 1 });
} finally { store.close(); }
store = SqliteEventStore.openForProject("/mnt/d/projexts/moe-next/apps/daemon/.project-configuration-smoke-neXket/consumer.db", projectId);
try {
  const current = readCurrentProjectConfiguration(store, { projectId,
    expectedSettingsDigest: created.manifest.settingsDigest });
  assert.deepStrictEqual(current, { authority: "DAEMON_VERIFIED", evidence: "DURABLE",
    manifest: created.manifest, manifestBytes: encoded.bytes, ok: true, outcome: "CURRENT",
    selectionVersion: 1 });
  process.stdout.write(JSON.stringify({ authority: current.authority, evidence: current.evidence,
    outcome: current.outcome, selectionVersion: current.selectionVersion }));
} finally { store.close(); }
