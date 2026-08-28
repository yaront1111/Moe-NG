import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonCommandPorts } from "./daemon-command-registry.js";
import { readStoreDependencyEnv } from "./daemon-store-dependencies.js";
import { VERIFICATION_CATALOG_VERSION }
  from "./evidence/verification-catalog-contracts.js";
import { createDaemonContextSealPort } from "./daemon-context-seal-wiring.js";
import type { FoundationContextSealPort } from "./work/foundation-context-record.js";

const dispatchCapture = vi.hoisted(() => ({ contextSeal: null as unknown }));
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
