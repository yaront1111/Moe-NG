import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import {
  createProjectConfigurationManifest, encodeProjectConfigurationManifest,
} from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const stdinProbe = vi.hoisted(() => ({ readers: [] as Array<() => readonly Uint8Array[]> }));
vi.mock("../../../packages/runner/src/platform/windows/windows-boundary.js", async (original) => {
  const actual = await original<typeof import(
    "../../../packages/runner/src/platform/windows/windows-boundary.js"
  )>();
  return {
    ...actual,
    openWindowsProcessBoundary(...args: Parameters<typeof actual.openWindowsProcessBoundary>) {
      const opened = actual.openWindowsProcessBoundary(...args);
      if (typeof opened === "object" && opened !== null && "providerStdin" in opened) {
        const stdin: Writable = opened.providerStdin;
        const writes = vi.spyOn(stdin, "write");
        stdinProbe.readers.push(() => writes.mock.calls.map((call) => {
          const chunk: unknown = call[0];
          if (typeof chunk === "string" || chunk instanceof Uint8Array) return Buffer.from(chunk);
          throw new Error("provider stdin received an unsupported chunk type");
        }));
      }
      return opened;
    },
  };
});
import { selectProjectConfiguration }
  from "../../../apps/daemon/src/configuration/project-configuration-selection.js";
import {
  createStoreDependencies, readStoreDependencyEnv,
} from "../../../apps/daemon/src/daemon-store-dependencies.js";
import { send }
  from "../../../apps/daemon/src/bootstrap/bootstrap-test-fixtures.js";
import { credentialSha256Of }
  from "../../../apps/daemon/src/identity/session-authenticator.js";
import { SESSION_SCHEMA_VERSION } from "../../../apps/daemon/src/identity/session-contracts.js";
import { runSessionCommand } from "../../../apps/daemon/src/identity/session-services.js";
import { handleAsyncCommandRequest } from "../../../apps/daemon/src/http/http-adapter.js";
import {
  ACTIVATION_AGGREGATE, CREDENTIAL, FOUNDATION_SEAM_CATALOG_PATH, NODE_KEY, SESSION_ID,
  activationBytes, cleanupSeamHarnesses, commandRequest, dispatchPayload, seedFoundationStore,
} from "../../../apps/daemon/src/http/foundation-registry-fixtures.js";
import { PROJECT_ID, PRINCIPAL_ID }
  from "../../../apps/daemon/src/recovery/restore-test-harness.js";
import { resolveLaunchEnv } from "../../../apps/daemon/src/orchestrator/moe-up-env.js";
import { snapshotProjectLaunchEnvironment }
  from "../../../apps/daemon/src/projects/project-launch-environment.js";
import { readCurrentActiveGraph }
  from "../../../apps/daemon/src/planning/active-graph-projection.js";
import { probeFor }
  from "../../../apps/daemon/src/provider-profile/provider-runtime-observation-test-fixtures.js";
import {
  deriveFoundationCaptureRef, readFoundationCaptureContext,
} from "../../../apps/daemon/src/work/foundation-capture-context-ledger.js";
import { readFoundationAttemptRecord }
  from "../../../apps/daemon/src/work/foundation-attempt-service.js";
import { readSealedFoundationContext }
  from "../../../apps/daemon/src/work/foundation-context-record.js";
import { readCurrentProviderRun }
  from "../../../apps/daemon/src/telemetry/provider-run-reader.js";
import { discoverInstalledClaudeRuntime }
  from "../../../packages/runner/src/providers/claude/claude-runtime-discovery.js";
import type { ProviderRuntimeObservation } from "../../../packages/runner/src/providers/claude/claude-observation.js";
import { withE2eRun } from "./e2e-harness.js";
const encoder = new TextEncoder();
const PROFILE_REF = "profile-r3-4-physical";
const ATTEMPT_REF = "attempt-1";
const DECIDED_AT = "2026-08-30T00:00:00.000Z";
const FORBIDDEN_CODES = Object.freeze([
  "FOUNDATION_CONTEXT_SEAL_UNCONFIGURED",
  "LAUNCH_RUNTIME_PIN_ROOT_UNCONFIGURED",
  "CLAUDE_LAUNCH_REQUEST_MALFORMED",
  "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
] as const);
interface SeededWorld {
  readonly pinRoot: string;
  readonly root: string;
  readonly settingsDigest: string;
  readonly storePath: string;
  readonly verificationCatalogPath: string;
}
function profileFor(runtime: ProviderRuntimeObservation | null): Record<string, unknown> {
  const selection = {
    modelRef: "model-r3-4", profileRef: PROFILE_REF, providerRef: "provider-claude",
    reasoningEffortRef: "effort-high", runtimeRef: "runtime-installed",
    snapshotRef: "snapshot-installed", structuredOutputSchemaRef: "schema-r3-4",
  };
  return {
    capabilitySchemaDigest: runtime?.adapterCapabilitySchemaDigest ?? "a1".repeat(32),
    concurrencyCeiling: 1,
    contextLimit: { bytes: 400_000, kind: "CONSERVATIVE_INPUT_BYTES",
      source: "R3-4 physical provider control" },
    limits: { stderrBytes: 65_536, stdoutBytes: 65_536, tailBytes: 4_096,
      timeoutMs: 30_000 },
    modelSnapshotEvidence: "snapshot-r3-4",
    modelSnapshotKind: "DATED_SNAPSHOT",
    profileRevisionId: PROFILE_REF, provider: "claude",
    providerMinimumProfileRef: "provider-profile-1", reasoningEffort: "high",
    selectedModelId: "claude-opus-5", selection,
  };
}
function settingsFor(profile: Record<string, unknown>): Record<string, unknown> {
  const values: Readonly<Record<string, number>> = {
    activeProviderSessions: 1, capturedOutputBytes: 65_536,
    runnerAuthorizedMsPerAttempt: 30_000, uiTailBytes: 4_096,
  };
  return {
    isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
    limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key, index) =>
      ({ key, value: values[key] ?? index + 1 })),
    network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
    orchestrationSource: { objectFormat: "sha256", sourceSha: "0c".repeat(32) },
    policy: { acceptanceGate: "MANUAL_HUMAN_APPROVAL", autoApprovalOptInDigest: null,
      evaluatorVersion: "policy-evaluator-v1", expansionGate: "MANUAL_HUMAN_APPROVAL",
      planningGate: "MANUAL_HUMAN_APPROVAL", policyRevisionId: "policy-r3-4", revision: 1 },
    schemaVersions: { commandSchemaVersion: "moe-command-1", errorSchemaVersion: "moe-error-1",
      querySchemaVersion: "moe-query-1" },
    selection: profile["selection"],
  };
}
function openBoundSession(store: SqliteEventStore): void {
  const opened = runSessionCommand(store, encoder.encode(JSON.stringify({
    commandId: "cmd-r3-4-session", correlationId: "corr-r3-4-session",
    decidedAt: DECIDED_AT, expectedVersion: 0, kind: "session.open",
    payload: { capabilities: ["work.claim"], credentialSha256: credentialSha256Of(CREDENTIAL),
      expiresAt: "2027-01-01T00:00:00.000Z", sessionId: SESSION_ID },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, schemaVersion: SESSION_SCHEMA_VERSION,
  })));
  if (!opened.ok) throw new Error(`session.open refused: ${opened.code}@${opened.refusedBy}`);
}
function seedWorld(root: string, runtime: ProviderRuntimeObservation | null): SeededWorld {
  const storePath = join(root, "store.sqlite");
  const pinRoot = join(root, "runtime-pins");
  createStoreDependencies({ credential: CREDENTIAL, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, storePath }).close();
  seedFoundationStore(storePath);
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  const profile = profileFor(runtime);
  try {
    const probed = send(store, probeFor({ commandId: "probe-r3-4", expectedVersion: 1,
      profile, runtime: runtime === null ? null
        : Object.fromEntries(Object.entries(structuredClone(runtime))) }));
    if (!probed.ok) throw new Error(`provider.probe refused: ${probed.code}@${probed.refusedBy}`);
    const created = createProjectConfigurationManifest(PROJECT_ID, settingsFor(profile));
    if (!created.ok) throw new Error(`configuration refused: ${created.code}`);
    const encoded = encodeProjectConfigurationManifest(created.manifest);
    if (!encoded.ok) throw new Error(`configuration encode refused: ${encoded.code}`);
    const selected = selectProjectConfiguration(store, { commandId: "configuration-r3-4",
      correlationId: "correlation-r3-4", decidedAt: DECIDED_AT, expectedVersion: 0,
      manifestBytes: encoded.bytes, principalId: PRINCIPAL_ID, projectId: PROJECT_ID });
    if (!selected.ok) throw new Error(`configuration selection refused: ${selected.code}`);
    openBoundSession(store);
    const verificationCatalogPath = join(root, "verification-catalog.json");
    writeFileSync(verificationCatalogPath, JSON.stringify({
      catalogVersion: "moe-verification-catalog/1",
      entries: [{ argv: ["pnpm", "test"], capability: "capability-implement",
        profileRevisionId: PROFILE_REF, projectId: PROJECT_ID }],
    }), "utf8");
    return { pinRoot, root, settingsDigest: created.manifest.settingsDigest,
      storePath, verificationCatalogPath };
  } finally {
    store.close();
  }
}
function childEnvironment(world: SeededWorld, guard?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env, MOE_AGENT_COMMAND: process.execPath, MOE_DAEMON_CREDENTIAL: CREDENTIAL,
    MOE_FOUNDATION_WORKSPACE_CATALOG: FOUNDATION_SEAM_CATALOG_PATH,
    MOE_PROJECT_ID: PROJECT_ID, MOE_RUNTIME_PIN_ROOT: world.pinRoot,
    MOE_STORE_PATH: world.storePath, MOE_VERIFICATION_CATALOG: world.verificationCatalogPath,
  };
  if (guard === undefined) delete env.MOE_PROJECT_CONFIGURATION_DIGEST;
  else env.MOE_PROJECT_CONFIGURATION_DIGEST = guard;
  const snapshot = snapshotProjectLaunchEnvironment(env);
  if (snapshot === null) throw new Error("project launch environment snapshot refused");
  const resolved = resolveLaunchEnv({ env: snapshot, repoRoot: process.cwd() });
  if (!resolved.ok) throw new Error(`moe up env refused: ${resolved.refusals[0]?.code ?? "unknown"}`);
  return { ...snapshot, ...resolved.env };
}
function capturedStdin(): Buffer {
  return Buffer.concat(stdinProbe.readers.flatMap((read) => read()).map((bytes) => Buffer.from(bytes)));
}
function recordAt(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`fixture ${key} is not a record`);
  }
  return value as Record<string, unknown>;
}
function commandRequestForRuntime(runtimeObservationDigest: string, lockIdentity: string) {
  const activation = JSON.parse(new TextDecoder().decode(activationBytes())) as
    Record<string, unknown>;
  const payload = recordAt(activation, "payload");
  const section = recordAt(payload, "activation");
  section["observedRuntimeDigest"] = runtimeObservationDigest;
  section["lockIdentity"] = lockIdentity;
  recordAt(section, "claim")["lockIdentity"] = lockIdentity;
  recordAt(recordAt(payload, "effect"), "intent")["runtimeObservationDigest"] =
    runtimeObservationDigest;
  return commandRequest({ payload: dispatchPayload({
    bytesBase64: Buffer.from(encoder.encode(JSON.stringify(activation))).toString("base64"),
  }) });
}
function refusalCode(
  answer: Awaited<ReturnType<typeof handleAsyncCommandRequest>>,
): string | null {
  if (answer.ok) return null;
  return answer.outcome === "PORT_REFUSED" ? answer.refusal.code : answer.error.code;
}
afterEach(() => {
  vi.restoreAllMocks();
  stdinProbe.readers.length = 0;
});
afterAll(() => cleanupSeamHarnesses());
it("reaches a real provider with the durable sealed context on stdin", async () => {
  await withE2eRun(34, async (run) => {
    const discovered = await discoverInstalledClaudeRuntime();
    if (!("ok" in discovered && discovered.ok === true)) {
      const code = "code" in discovered ? discovered.code : undefined;
      const expectedCode = process.platform === "win32"
        ? "CLAUDE_RUNTIME_PATH_MISSING" : "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED";
      if (code !== expectedCode) {
        throw new Error(`installed runtime discovery refused: ${JSON.stringify(discovered)}`);
      }
      expect(discovered).toMatchObject({ code: expectedCode,
        layer: "RUNTIME", truthClass: "UNKNOWN" });
      return;
    }
    stdinProbe.readers.length = 0;
    const root = mkdtempSync(join(tmpdir(), "moe-r3-4-sealed-context-"));
    run.registerCleanup(`scratch:${root}`, () => rmSync(root, { force: true, recursive: true }));
    const world = seedWorld(root, discovered.observation);
    const childEnv = childEnvironment(world);
    const previousPinRoot = process.env.MOE_RUNTIME_PIN_ROOT;
    const nextPinRoot = childEnv.MOE_RUNTIME_PIN_ROOT;
    if (nextPinRoot === undefined) delete process.env.MOE_RUNTIME_PIN_ROOT;
    else process.env.MOE_RUNTIME_PIN_ROOT = nextPinRoot;
    run.registerCleanup("restore runtime pin root", () => {
      if (previousPinRoot === undefined) delete process.env.MOE_RUNTIME_PIN_ROOT;
      else process.env.MOE_RUNTIME_PIN_ROOT = previousPinRoot;
    });
    const provider = createStoreDependencies(readStoreDependencyEnv(childEnv));
    run.registerCleanup("daemon provider", () => provider.close());
    const answer = await handleAsyncCommandRequest(provider.provide(),
      commandRequestForRuntime(discovered.observation.observationDigest,
        `lock-r3-4-${world.root.slice(-6)}`));
    const code = refusalCode(answer);
    if (code !== null) expect(new Set<string>(FORBIDDEN_CODES).has(code),
      `forbidden launch refusal: ${code}`).toBe(false);
    const store = SqliteEventStore.openForProject(world.storePath, PROJECT_ID);
    run.registerCleanup("readback store", () => store.close());
    const active = readCurrentActiveGraph(store, PROJECT_ID);
    if (!active.ok) throw new Error(`active graph unreadable: ${active.code}`);
    const capture = readFoundationCaptureContext(store, deriveFoundationCaptureRef({
      attemptAggregateId: ACTIVATION_AGGREGATE, attemptId: ATTEMPT_REF, nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION_ID,
    }));
    if (!capture.ok) throw new Error(`capture unreadable: ${capture.code}`);
    const sealed = readSealedFoundationContext(store, {
      attemptRef: ATTEMPT_REF, projectId: PROJECT_ID, sessionId: SESSION_ID,
    }, { configurationDigest: world.settingsDigest, graphContentHash: active.graphContentHash,
      graphEpoch: active.graphEpoch, graphRevisionRef: active.revisionId,
      inputManifestDigest: capture.record.inputManifest.sha256, nodeKey: NODE_KEY });
    if (!sealed.ok) throw new Error(`sealed context unreadable: ${sealed.code}`);
    const providerRun = readCurrentProviderRun(store, {
      attemptRef: ATTEMPT_REF, projectId: PROJECT_ID,
    });
    if (!("ok" in providerRun && providerRun.ok === true)) {
      throw new Error(`provider run unreadable: ${JSON.stringify(providerRun)}`);
    }
    if (providerRun.record.launch.kind !== "OBSERVED") {
      throw new Error(`provider did not launch: ${JSON.stringify(providerRun.record.launch)}`);
    }
    expect(capturedStdin()).toEqual(Buffer.from(sealed.record.manifest.binding.exactBytes));
    const attempt = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    if (!attempt.ok) throw new Error(`attempt unreadable: ${attempt.code}`);
    const observation = attempt.record["observation"];
    if (typeof observation !== "object" || observation === null) {
      throw new Error("attempt observation unreadable");
    }
    expect((observation as Record<string, unknown>)["contextManifestDigest"])
      .toBe(sealed.record.manifest.digest);
  });
}, 180_000);
it("refuses a wrong operator digest guard before a daemon can serve", async () => {
  await withE2eRun(35, async (run) => {
    const root = mkdtempSync(join(tmpdir(), "moe-r3-4-wrong-guard-"));
    run.registerCleanup(`scratch:${root}`, () => rmSync(root, { force: true, recursive: true }));
    const world = seedWorld(root, null);
    const childEnv = childEnvironment(world, "f".repeat(64));
    expect(() => createStoreDependencies(readStoreDependencyEnv(childEnv)))
      .toThrow(/^PROJECT_CONFIGURATION_DIGEST_MISMATCH:/u);
  });
});
