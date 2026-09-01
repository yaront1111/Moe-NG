import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import {
  createProjectConfigurationManifest, encodeProjectConfigurationManifest,
} from "@moe/core";
import { DurableStoreError, SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectProjectConfiguration }
  from "./configuration/project-configuration-selection.js";
import { createDaemonCommandPorts } from "./daemon-command-registry.js";
import { createStoreDependencies, readStoreDependencyEnv }
  from "./daemon-store-dependencies.js";
import { VERIFICATION_CATALOG_VERSION }
  from "./evidence/verification-catalog-contracts.js";
import {
  DAEMON_CONTEXT_SEAL_WIRING_CODES, createDaemonContextSealPort,
  createDaemonFoundationWiring, resolveProjectConfigurationDigest,
} from "./daemon-context-seal-wiring.js";
import type { FoundationContextSealPort } from "./work/foundation-context-record.js";

const dispatchCapture = vi.hoisted(() => ({ contextSeal: null as unknown }));
const sealCapture = vi.hoisted(() => ({ expectedConfigurationDigest: null as string | null }));
vi.mock("./daemon-foundation-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon-foundation-command.js")>();
  return {
    ...actual,
    createFoundationDispatchHandler(
      options: Parameters<typeof actual.createFoundationDispatchHandler>[0],
    ) {
      dispatchCapture.contextSeal = options.contextSeal;
      return actual.createFoundationDispatchHandler(options);
    },
  };
});
vi.mock("./work/foundation-context-record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./work/foundation-context-record.js")>();
  return {
    ...actual,
    createDurableFoundationContextSealPort(
      options: Parameters<typeof actual.createDurableFoundationContextSealPort>[0],
    ) {
      sealCapture.expectedConfigurationDigest = options.expectedConfigurationDigest;
      return actual.createDurableFoundationContextSealPort(options);
    },
  };
});

const PROJECT_ID = "project-context-wiring";
const CONFIGURATION_DIGEST = "a".repeat(64);
const PROFILE_REVISION_ID = "profile-revision-context-wiring";

const verificationCatalogSource = (): unknown => ({
  catalogVersion: VERIFICATION_CATALOG_VERSION,
  entries: [{
    argv: ["pnpm", "test"], capability: "capability-context-wiring",
    profileRevisionId: PROFILE_REVISION_ID, projectId: PROJECT_ID,
  }],
});

describe("daemon context-seal wiring", () => {
  const stores: SqliteEventStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function createStore(): SqliteEventStore {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    stores.push(store);
    return store;
  }

  it("leaves the seal port absent when no configuration digest is bound", () => {
    const port = createDaemonContextSealPort({
      foundationCatalogSource: () => undefined,
      projectId: PROJECT_ID,
      store: createStore(),
      verificationCatalogSource,
    });

    expect(port).toBeUndefined();
  });

  it("does not coerce a malformed configuration digest into authority", () => {
    const port = createDaemonContextSealPort({
      foundationCatalogSource: () => undefined,
      projectConfigurationDigest: CONFIGURATION_DIGEST.toUpperCase(),
      projectId: PROJECT_ID,
      store: createStore(),
      verificationCatalogSource,
    });

    expect(port).toBeUndefined();
  });

  it("reads the optional digest while preserving empty as absent", () => {
    const base = {
      MOE_DAEMON_CREDENTIAL: "credential-context-wiring",
      MOE_PROJECT_ID: PROJECT_ID,
      MOE_STORE_PATH: "context-wiring.db",
    };

    expect(readStoreDependencyEnv({
      ...base, MOE_PROJECT_CONFIGURATION_DIGEST: CONFIGURATION_DIGEST,
    })).toMatchObject({ projectConfigurationDigest: CONFIGURATION_DIGEST });
    expect(readStoreDependencyEnv({
      ...base, MOE_PROJECT_CONFIGURATION_DIGEST: "",
    })).not.toHaveProperty("projectConfigurationDigest");
  });

  it("composes the durable port and preserves its empty-world refusal", () => {
    const port = createDaemonContextSealPort({
      foundationCatalogSource: () => undefined,
      projectConfigurationDigest: CONFIGURATION_DIGEST,
      projectId: PROJECT_ID,
      store: createStore(),
      verificationCatalogSource,
    });

    expect(port).toBeDefined();
    expect(port?.sealFoundationContext({
      attemptRef: "attempt-context-wiring", nodeKey: "node-context-wiring",
      projectId: PROJECT_ID, sessionId: "session-context-wiring",
    }, "2026-08-27T00:00:00.000Z")).toMatchObject({
      code: "FOUNDATION_CONTEXT_SEAL_PROFILE_UNREADABLE",
      layer: "FOUNDATION_CONTEXT_SEAL",
      ok: false,
    });
  });

  it("threads the configured seal through the registry and preserves the fallback", () => {
    const store = createStore();
    const configured = createDaemonContextSealPort({
      foundationCatalogSource: () => undefined,
      projectConfigurationDigest: CONFIGURATION_DIGEST,
      projectId: PROJECT_ID,
      store,
      verificationCatalogSource,
    });
    expect(configured).toBeDefined();
    if (configured === undefined) throw new Error("configured seal was not composed");
    createDaemonCommandPorts({
      clock: () => "2026-08-27T00:00:00.000Z",
      foundationContextSeal: configured,
      operatorPrincipalId: "operator-context-wiring",
      projectId: PROJECT_ID,
      store,
    });
    const configuredResult = (dispatchCapture.contextSeal as FoundationContextSealPort)
      .sealFoundationContext({
        attemptRef: "attempt-context-wiring", nodeKey: "node-context-wiring",
        projectId: PROJECT_ID, sessionId: "session-context-wiring",
      }, "2026-08-27T00:00:00.000Z");

    createDaemonCommandPorts({
      clock: () => "2026-08-27T00:00:00.000Z",
      operatorPrincipalId: "operator-context-wiring",
      projectId: PROJECT_ID,
      store,
    });
    const fallbackResult = (dispatchCapture.contextSeal as FoundationContextSealPort)
      .sealFoundationContext({
        attemptRef: "attempt-context-wiring", nodeKey: "node-context-wiring",
        projectId: PROJECT_ID, sessionId: "session-context-wiring",
      }, "2026-08-27T00:00:00.000Z");

    expect(configuredResult).toMatchObject({
      code: "FOUNDATION_CONTEXT_SEAL_PROFILE_UNREADABLE",
      layer: "FOUNDATION_CONTEXT_SEAL", ok: false,
    });
    expect(fallbackResult).toMatchObject({
      code: "FOUNDATION_CONTEXT_SEAL_UNCONFIGURED",
      layer: "FOUNDATION_CONTEXT_SEAL", ok: false,
    });
    if (configuredResult.ok || fallbackResult.ok) {
      throw new Error("both empty-world paths must refuse");
    }
    expect(configuredResult.code).not.toBe(fallbackResult.code);
  });
});

const DIGEST_LAYER = "DAEMON_PREREQUISITE";
const SELECTION_LAYER = "PROJECT_CONFIGURATION_SELECTION";
const hex = (character: string): string => character.repeat(64);

function settings(modelRef: string): Record<string, unknown> {
  return {
    isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
    limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key, index) => ({ key, value: index + 1 })),
    network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
    orchestrationSource: { objectFormat: "sha256", sourceSha: hex("2") },
    policy: {
      acceptanceGate: "MANUAL_HUMAN_APPROVAL", autoApprovalOptInDigest: null,
      evaluatorVersion: "policy-evaluator-v1", expansionGate: "MANUAL_HUMAN_APPROVAL",
      planningGate: "MANUAL_HUMAN_APPROVAL", policyRevisionId: "policy-revision-1", revision: 1,
    },
    schemaVersions: {
      commandSchemaVersion: "moe-command-1", errorSchemaVersion: "moe-error-1",
      querySchemaVersion: "moe-query-1",
    },
    selection: {
      modelRef, profileRef: "profile-1", providerRef: "provider-1",
      reasoningEffortRef: "effort-1", runtimeRef: "runtime-1", snapshotRef: "snapshot-1",
      structuredOutputSchemaRef: "schema-1",
    },
  };
}

/** Seeds through the PRODUCTION selection command; never hand-inserts a row. */
function seedConfiguration(store: SqliteEventStore, modelRef = "model-1"): string {
  const created = createProjectConfigurationManifest(PROJECT_ID, settings(modelRef));
  if (!created.ok) throw new Error(`fixture create refused: ${created.code}`);
  const encoded = encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(`fixture encode refused: ${encoded.code}`);
  const selected = selectProjectConfiguration(store, {
    commandId: `configuration-${modelRef}`, correlationId: `correlation-${modelRef}`,
    decidedAt: "2026-08-29T00:00:00.000Z", expectedVersion: 0,
    manifestBytes: encoded.bytes, principalId: "principal-seal-wiring", projectId: PROJECT_ID,
  });
  if (!selected.ok) throw new Error(`fixture selection refused: ${selected.code}`);
  return created.manifest.settingsDigest;
}

describe("R3-4 project configuration digest binding", () => {
  const stores: SqliteEventStore[] = [];
  const bootDirectory = mkdtempSync(join(tmpdir(), "moe-r3-4-seal-boot-"));
  const verificationCatalogPath = join(bootDirectory, "verification-catalog.json");
  let bootCounter = 0;

  writeFileSync(verificationCatalogPath, JSON.stringify(verificationCatalogSource()), "utf8");

  function createStore(): SqliteEventStore {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    stores.push(store);
    return store;
  }

  /**
   * A file-backed store the PRODUCTION boot path can open by MOE_STORE_PATH, prepared
   * the way production prepares one: a first boot WITHOUT a digest installs the genesis
   * recovery binding, and only then is the configuration selected. Seeding a bare store
   * instead makes the genesis fence (RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT) answer
   * first, which would prove the daemon refuses rather than that THIS guard refuses.
   */
  function seededStorePath(): string {
    bootCounter += 1;
    const path = join(bootDirectory, `${bootCounter}.db`);
    const base = {
      MOE_DAEMON_CREDENTIAL: "credential-r3-4", MOE_PROJECT_ID: PROJECT_ID,
      MOE_STORE_PATH: path,
    };
    createStoreDependencies(readStoreDependencyEnv(base)).close();
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      seedConfiguration(store);
    } finally {
      store.close();
    }
    return path;
  }

  function bootEnv(digest: string): Record<string, string> {
    return {
      MOE_DAEMON_CREDENTIAL: "credential-r3-4", MOE_PROJECT_ID: PROJECT_ID,
      MOE_PROJECT_CONFIGURATION_DIGEST: digest, MOE_STORE_PATH: seededStorePath(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchCapture.contextSeal = null;
    sealCapture.expectedConfigurationDigest = null;
  });

  afterEach(() => {
    for (const store of stores.splice(0)) {
      try {
        store.close();
      } catch {
        // An arm may have closed the handle already.
      }
    }
  });

  afterAll(() => {
    try {
      rmSync(bootDirectory, { force: true, recursive: true });
    } catch {
      // A boot arm throws while holding the handle; the temp directory outlives the run.
    }
  });

  it("A: DURABLE SOURCE - the durable configuration alone configures the seal", () => {
    const store = createStore();
    const durable = seedConfiguration(store);

    expect(resolveProjectConfigurationDigest(store, {
      envDigest: undefined, projectId: PROJECT_ID,
    })).toEqual({ digest: durable, ok: true, source: "DURABLE" });

    // No env digest anywhere: the daemon derives its own, so `moe up` never has to carry it.
    const wiring = createDaemonFoundationWiring({
      projectId: PROJECT_ID, store, verificationCatalogPath,
    });
    expect(wiring.foundationContextSeal).toBeDefined();
    expect(durable).not.toBe(CONFIGURATION_DIGEST);
    expect(durable).not.toBe(hex("b"));
    wiring.foundationContextSeal?.sealFoundationContext({
      attemptRef: "attempt-r3-4-a", nodeKey: "node-r3-4-a",
      projectId: PROJECT_ID, sessionId: "session-r3-4-a",
    }, "2026-08-29T00:00:00.000Z");
    expect(sealCapture.expectedConfigurationDigest).toBe(durable);
  });

  it("A2: NO CATALOGS - boot keeps other ports serving and the seal owns refusal", () => {
    const store = createStore();
    seedConfiguration(store);
    const wiring = createDaemonFoundationWiring({ projectId: PROJECT_ID, store });

    expect(wiring.foundationContextSeal).toBeDefined();
    const ports = createDaemonCommandPorts({
      clock: () => "2026-08-29T00:00:00.000Z",
      ...wiring,
      operatorPrincipalId: "operator-context-wiring", projectId: PROJECT_ID, store,
    });
    expect(ports.registry.get("project.register")).toMatchObject({
      kind: "project.register", payloadKeys: ["owner"],
    });
    expect(wiring.foundationContextSeal?.sealFoundationContext({
      attemptRef: "attempt-r3-4-a2", nodeKey: "node-r3-4-a2",
      projectId: PROJECT_ID, sessionId: "session-r3-4-a2",
    }, "2026-08-29T00:00:00.000Z")).toMatchObject({
      code: "FOUNDATION_CONTEXT_SEAL_REFUSED", layer: "FOUNDATION_CONTEXT_SEAL", ok: false,
    });
  });

  it("B: ABSENT STAYS VALID - no configuration leaves the unconfigured fallback serving", () => {
    const store = createStore();

    expect(resolveProjectConfigurationDigest(store, {
      envDigest: undefined, projectId: PROJECT_ID,
    })).toEqual({ digest: null, ok: true, source: "ABSENT" });

    const wiring = createDaemonFoundationWiring({ projectId: PROJECT_ID, store });
    expect(wiring.foundationContextSeal).toBeUndefined();

    createDaemonCommandPorts({
      clock: () => "2026-08-29T00:00:00.000Z",
      ...(wiring.foundationContextSeal === undefined
        ? {} : { foundationContextSeal: wiring.foundationContextSeal }),
      operatorPrincipalId: "operator-context-wiring", projectId: PROJECT_ID, store,
    });
    expect(dispatchCapture.contextSeal).not.toBeNull();
    expect((dispatchCapture.contextSeal as FoundationContextSealPort).sealFoundationContext({
      attemptRef: "attempt-r3-4", nodeKey: "node-r3-4",
      projectId: PROJECT_ID, sessionId: "session-r3-4",
    }, "2026-08-29T00:00:00.000Z")).toMatchObject({
      code: "FOUNDATION_CONTEXT_SEAL_UNCONFIGURED", layer: "FOUNDATION_CONTEXT_SEAL", ok: false,
    });
  });

  it("C: GUARD MATCH - an operator digest equal to the durable one keeps DURABLE as source", () => {
    const store = createStore();
    const durable = seedConfiguration(store);

    expect(resolveProjectConfigurationDigest(store, {
      envDigest: durable, projectId: PROJECT_ID,
    })).toEqual({ digest: durable, ok: true, source: "DURABLE" });
  });

  it("C2: CASE GUARD - uppercase digest is malformed before source selection", () => {
    const store = createStore();
    const durable = seedConfiguration(store);

    expect(resolveProjectConfigurationDigest(store, {
      envDigest: durable.toUpperCase(), projectId: PROJECT_ID,
    })).toEqual({
      code: "PROJECT_CONFIGURATION_DIGEST_MALFORMED", layer: DIGEST_LAYER, ok: false,
      upstream: null,
    });
  });

  it("D: GUARD MISMATCH - a disagreeing operator digest fails the daemon closed at boot", () => {
    const store = createStore();
    const durable = seedConfiguration(store);
    expect(durable).not.toBe(hex("b"));

    expect(resolveProjectConfigurationDigest(store, {
      envDigest: hex("b"), projectId: PROJECT_ID,
    })).toEqual({
      code: "PROJECT_CONFIGURATION_DIGEST_MISMATCH", layer: DIGEST_LAYER, ok: false,
      upstream: null,
    });
    // Through the PRODUCTION entry: readStoreDependencyEnv -> createStoreDependencies.
    expect(() => createStoreDependencies(readStoreDependencyEnv(bootEnv(hex("b")))))
      .toThrow(/^PROJECT_CONFIGURATION_DIGEST_MISMATCH/u);
  });

  it("E: GUARD MALFORMED - a non-hex64 operator digest refuses instead of being ignored", () => {
    const store = createStore();
    seedConfiguration(store);

    expect(resolveProjectConfigurationDigest(store, {
      envDigest: "", projectId: PROJECT_ID,
    })).toEqual({
      code: "PROJECT_CONFIGURATION_DIGEST_MALFORMED", layer: DIGEST_LAYER, ok: false,
      upstream: null,
    });
    expect(resolveProjectConfigurationDigest(store, {
      envDigest: hex("a").toUpperCase(), projectId: PROJECT_ID,
    })).toEqual({
      code: "PROJECT_CONFIGURATION_DIGEST_MALFORMED", layer: DIGEST_LAYER, ok: false,
      upstream: null,
    });
    expect(() => createStoreDependencies(readStoreDependencyEnv(bootEnv("not-a-digest"))))
      .toThrow(/^PROJECT_CONFIGURATION_DIGEST_MALFORMED/u);
  });

  it("F: READER REFUSAL FORWARDED - an unreadable tail is never reported as absent", () => {
    const store = createStore();
    seedConfiguration(store);
    const corruptBytes = new Uint8Array([0xff]);
    const corruptTail = {
      commitExpectedVersionDecision: (
        input: Parameters<SqliteEventStore["commitExpectedVersionDecision"]>[0],
      ) => store.commitExpectedVersionDecision(input),
      getAggregateVersion: (aggregateId: string) => store.getAggregateVersion(aggregateId),
      getCommandDecision(key: Parameters<SqliteEventStore["getCommandDecision"]>[0]) {
        const decision = store.getCommandDecision(key);
        return decision === null ? null : { ...decision, resultBytes: corruptBytes };
      },
      getCommandReceipt: (commandId: string) => store.getCommandReceipt(commandId),
      readAggregateEvents(id: string, after: number, limit: number) {
        const page = store.readAggregateEvents(id, after, limit);
        return {
          ...page,
          items: page.items.map((event) => ({ ...event, payload: corruptBytes })),
        };
      },
    };

    expect(resolveProjectConfigurationDigest(corruptTail, {
      envDigest: undefined, projectId: PROJECT_ID,
    })).toEqual({
      code: "PROJECT_CONFIGURATION_DIGEST_UNREADABLE", layer: DIGEST_LAYER, ok: false,
      upstream: { code: "PROJECT_CONFIGURATION_UNREADABLE", layer: SELECTION_LAYER },
    });
  });

  it("pins the wiring's refusal vocabulary in both directions", () => {
    const store = createStore();
    const emitted = new Set<string>();
    for (const envDigest of [hex("b"), "not-a-digest"]) {
      const answer = resolveProjectConfigurationDigest(store, { envDigest, projectId: PROJECT_ID });
      if (answer.ok) throw new Error(`expected a refusal for ${envDigest}`);
      emitted.add(answer.code);
    }
    const unreadable = resolveProjectConfigurationDigest({
      commitExpectedVersionDecision: (): never => {
        throw new Error("unreachable");
      },
      getAggregateVersion: (): never => {
        throw new DurableStoreError("STORE_CLOSED", "closed by test");
      },
      getCommandDecision: (): never => {
        throw new Error("unreachable");
      },
      getCommandReceipt: (): never => {
        throw new Error("unreachable");
      },
      readAggregateEvents: (): never => {
        throw new Error("unreachable");
      },
    }, { envDigest: undefined, projectId: PROJECT_ID });
    if (unreadable.ok) throw new Error("expected the reader refusal to be forwarded");
    emitted.add(unreadable.code);

    // Bidirectional: every advertised code is reachable AND every reachable code is advertised.
    expect([...emitted].sort()).toEqual([...DAEMON_CONTEXT_SEAL_WIRING_CODES].sort());
    expect(new Set(DAEMON_CONTEXT_SEAL_WIRING_CODES).size)
      .toBe(DAEMON_CONTEXT_SEAL_WIRING_CODES.length);
  });
});
