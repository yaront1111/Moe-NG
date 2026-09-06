import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import {
  createProjectConfigurationManifest, encodeProjectConfigurationManifest,
} from "@moe/core";
import { DurableStoreError, SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { selectProjectConfiguration }
  from "./configuration/project-configuration-selection.js";
import { acquireFoundationStore } from "./daemon-store-acquisition.js";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "./bootstrap/bootstrap-services.js";
import {
  CLASSIFYING_POLICY_SLICE, POLICY_SLICE, PROVIDER_OBSERVATION,
} from "./bootstrap/bootstrap-test-fixtures.js";
import { FIXTURE_ACTIVATION_RECEIPTS } from "./bootstrap/bootstrap-test-fixtures.js";
import { designAggregateId } from "./design/design-contracts.js";
import { GOAL_HANDLERS } from "./goals/goal-services.js";
import { PLANNING_HANDLERS } from "./planning/planning-services.js";
import { PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";
import { documentWorkAggregateId } from "./documents/document-work-service.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import {
  STORE_DEPENDENCIES_ENV_MISSING,
  createStoreDependencies,
  readStoreDependencyEnv,
} from "./daemon-store-dependencies.js";
import {
  FOUNDATION_WORKSPACE_CATALOG_ENV_KEY,
} from "./work/foundation-capture-lifecycle.js";
import { MCP_EXCLUDED_COMMAND_KINDS, wiredMcpToolKinds } from "./mcp-tool-allowlist.js";
import { OPERATOR_PRINCIPAL_KINDS } from "./daemon-command-vocabulary.js";
import { HUMAN_ONLY_STEPS } from "./orchestrator/agent-spawn-contract.js";
import { ASYNC_SERVED_BOOTSTRAP_KINDS } from "./bootstrap/bootstrap-contracts.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { bytes, envelopeObject } from "./http/http-test-fixtures.js";

const CREDENTIAL = "test-operator-credential";
const PROJECT = "proj-store-deps";
const CLOCK = (): string => "2026-08-09T12:00:00.000Z";
const CONFIGURATION_PROJECT = "proj-store-deps-configuration";

const hex = (character: string): string => character.repeat(64);

function configurationSettings(): Record<string, unknown> {
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
      modelRef: "model-store-deps", profileRef: "profile-store-deps",
      providerRef: "provider-store-deps", reasoningEffortRef: "effort-store-deps",
      runtimeRef: "runtime-store-deps", snapshotRef: "snapshot-store-deps",
      structuredOutputSchemaRef: "schema-store-deps",
    },
  };
}

function createConfigurationStore(): Readonly<{
  directory: string; settingsDigest: string; storePath: string;
}> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "moe-store-deps-config-")));
  const storePath = join(directory, "store.db");
  const config = {
    credential: CREDENTIAL, principalId: "operator-local",
    projectId: CONFIGURATION_PROJECT, storePath,
  };
  createStoreDependencies(config).close();
  const store = SqliteEventStore.openForProject(storePath, CONFIGURATION_PROJECT);
  const created = createProjectConfigurationManifest(CONFIGURATION_PROJECT, configurationSettings());
  if (!created.ok) throw new Error(`fixture create refused: ${created.code}`);
  const encoded = encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(`fixture encode refused: ${encoded.code}`);
  const selected = selectProjectConfiguration(store, {
    commandId: "configuration-store-deps", correlationId: "correlation-store-deps",
    decidedAt: CLOCK(), expectedVersion: 0, manifestBytes: encoded.bytes,
    principalId: "operator-local", projectId: CONFIGURATION_PROJECT,
  });
  store.close();
  if (!selected.ok) throw new Error(`fixture selection refused: ${selected.code}`);
  return { directory, settingsDigest: created.manifest.settingsDigest, storePath };
}

const directory = realpathSync(mkdtempSync(join(tmpdir(), "moe-store-deps-")));
const storePath = join(directory, "store.db");

const provider = createStoreDependencies({
  clock: CLOCK,
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath,
});
const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
setupStore.close();
const deps = provider.provide();

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

function dispatch(envelope: Record<string, unknown>, credential: string = CREDENTIAL) {
  return handleCommandRequest(deps, {
    body: bytes(envelope),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
}

function registerEnvelope(): Record<string, unknown> {
  return {
    ...envelopeObject({
      commandId: "cmd-register-1",
      commandKind: "project.register",
      payload: { owner: "operator-local" },
    }),
    expectedVersion: 0,
  };
}

describe("readStoreDependencyEnv", () => {
  it("refuses with the stable code naming every missing variable", () => {
    expect(() => readStoreDependencyEnv({})).toThrowError(
      `${STORE_DEPENDENCIES_ENV_MISSING}: MOE_STORE_PATH, MOE_PROJECT_ID, MOE_DAEMON_CREDENTIAL`,
    );
  });

  it("treats an EMPTY optional as absent, exactly as the required trio does", () => {
    // MOE_PRINCIPAL_ID="" must not mint a daemon whose operator principal is
    // the empty string; the trio already reads empty as missing, and the
    // optionals follow the same rule rather than a second, weaker one.
    const config = readStoreDependencyEnv({
      MOE_DAEMON_CREDENTIAL: "secret",
      MOE_NODE_SPECS_DIR: "",
      MOE_PRINCIPAL_ID: "",
      MOE_PROJECT_ID: "proj",
      MOE_STORE_PATH: "D:/tmp/store.db",
    });
    expect(config.principalId).toBe("operator-local");
    expect(config.nodeSpecsDir).toBeUndefined();
  });

  it("reads the OPTIONAL Foundation workspace catalog path under the same rule", () => {
    const base = {
      MOE_DAEMON_CREDENTIAL: "secret", MOE_PROJECT_ID: "proj",
      MOE_STORE_PATH: "D:/tmp/store.db",
    };
    const configured = readStoreDependencyEnv({
      ...base, [FOUNDATION_WORKSPACE_CATALOG_ENV_KEY]: "D:/tmp/catalog.json",
    });
    const empty = readStoreDependencyEnv({ ...base, [FOUNDATION_WORKSPACE_CATALOG_ENV_KEY]: "" });

    expect(configured.workspaceCatalogPath).toBe("D:/tmp/catalog.json");
    expect(empty.workspaceCatalogPath).toBeUndefined();
    expect(readStoreDependencyEnv(base).workspaceCatalogPath).toBeUndefined();
    // The key is read from the SAME published constant the lifecycle reader uses;
    // two hand-written copies would drift in exactly one direction.
    expect(FOUNDATION_WORKSPACE_CATALOG_ENV_KEY).toBe("MOE_FOUNDATION_WORKSPACE_CATALOG");
  });
});

describe("the Foundation workspace catalog never gates daemon boot", () => {
  /** A provider is opened per case here rather than reusing the module-level one:
   *  the subject IS the boot, so it has to happen inside the case. */
  function bootWith(label: string, catalogPath: string | undefined) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), `moe-store-deps-catalog-${label}-`)));
    const path = join(directory, "store.db");
    const built = createStoreDependencies({
      clock: CLOCK, credential: CREDENTIAL, principalId: "operator-local",
      projectId: `${PROJECT}-${label}`, storePath: path,
      ...(catalogPath === undefined ? {} : { workspaceCatalogPath: catalogPath }),
    });
    return { built, directory };
  }

  it.each([
    ["absent", undefined],
    ["missing-file", join(tmpdir(), "moe-no-such-catalog-file.json")],
  ] as readonly (readonly [string, string | undefined])[])(
    "boots and serves every other command kind with a %s catalog", (label, catalogPath) => {
      const { built, directory } = bootWith(label, catalogPath);
      try {
        const deps = built.provide();
        // The registry is whole: an unconfigured workspace authority refuses
        // Foundation PREPARATION at dispatch time, it does not remove a kind.
        expect(deps.registry.get("foundation.dispatch")?.asyncHandler).toBeDefined();
        expect([...deps.registry.keys()].length).toBeGreaterThan(0);
      } finally {
        built.close();
        rmSync(directory, { force: true, recursive: true });
      }
    });
});

describe("createStoreDependencies", () => {
  it("provides the project-bound Product Contract /2 current reader", () => {
    const current = provider.productContractV2Current?.();
    expect(current).toBeDefined();
    expect(current?.boundProjectId).toBe(PROJECT);
    expect(current?.readCurrent("contract-v2")).toEqual({
      code: "CUTOVER_V2_NOT_ACTIVE",
      layer: "DAEMON_CUTOVER_V2_AUTHORITY",
      outcome: "REFUSED",
    });
  });

  it("provides the project-bound Product Contract /2 pending reader", () => {
    const pending = provider.productContractV2Pending?.();
    expect(pending).toBeDefined();
    expect(pending?.boundProjectId).toBe(PROJECT);
    expect(pending?.readPending("goal-v2-pending")).toEqual({
      code: "CUTOVER_V2_NOT_ACTIVE",
      layer: "DAEMON_CUTOVER_V2_AUTHORITY",
      outcome: "REFUSED",
    });
  });

  it("provides a distinct /2 command plane that is inactive rather than falling back to v1", () => {
    const v2 = provider.provideV2?.();
    expect(v2).toBeDefined();
    if (v2 === undefined) return;
    expect([...v2.registry.keys()].sort()).toEqual(Object.keys(PAYLOAD_KEYS)
      .filter((kind) => kind !== "planning.submit_decomposition").sort());

    const result = handleCommandRequest(v2, {
      body: bytes(envelopeObject({
        commandId: "command-v2-before-cutover",
        commandKind: "product_contract.propose_revision",
        payload: { draft: {}, goalRef: "goal-v2-before-cutover" },
      })),
      credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "HTTP_LISTENER");
    expect(result).toMatchObject({
      httpStatus: 422,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: {
        code: "CUTOVER_V2_NOT_ACTIVE",
        layer: "DAEMON_CUTOVER_V2_AUTHORITY",
      },
      stage: "DISPATCH",
    });
  });

  it("provides the goal catalog over its bound project store", () => {
    const port = provider.goalCatalog?.();
    expect(port).toBeDefined();
    expect(port?.boundProjectId).toBe(PROJECT);
    // An empty catalog ends its own pinned enumeration, so the composition root's port answers
    // page one with no continuation.
    expect(port?.readGoals()).toStrictEqual({ goals: [], nextCursor: null, outcome: "GOALS" });
  });

  it("provides a read-only document dossier port over the bound store", () => {
    const port = provider.documentDossiers?.();
    expect(port).toBeDefined();
    if (port === undefined) return;

    const inspection = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      const aggregateId = documentWorkAggregateId(PROJECT);
      const before = inspection.getAggregateVersion(aggregateId);
      expect(port.readLatest(PROJECT)).toStrictEqual({
        advisoryOnly: true,
        authority: "NONE",
        code: "DOCUMENT_WORK_DOSSIER_MISSING",
        layer: "DAEMON_READ_MODEL",
        ok: false,
        outcome: "REFUSED",
      });
      expect(inspection.getAggregateVersion(aggregateId)).toBe(before);
    } finally {
      inspection.close();
    }
  });

  /**
   * The environments read, resolved through the REAL composition root
   * (task-ef76a7f4523d46f48a2f9eb19595e801). A fresh project has set no variable, so the honest
   * answer is the EMPTY TABLE at ok:true -- NOT a refusal, because "no variables yet" must stay
   * distinguishable from "wrong credential". Unlike the design read, `projectId` IS bound at
   * composition time: the aggregate id is `environment/<projectId>/<name>`, a composition-root
   * fact with no request field that could name another project.
   *
   * NO VALUE arm at this layer too: the port is the one production ships, so serializing its
   * answer and searching for the seeded plaintext is a check on the shipped read path, not on a
   * handler wrapper.
   */
  it("provides an environments read port that answers the empty table with no value", () => {
    const port = provider.environmentReads?.();
    expect(port).toBeDefined();
    if (port === undefined) return;

    expect(port.read({ environment: "preview" }))
      .toStrictEqual({ environment: "preview", ok: true, variables: [] });
    // The store's scope authority answers, at its own layer.
    expect(port.read({ environment: "staging" })).toStrictEqual({
      code: "ENV_ENVIRONMENT_UNKNOWN",
      detail: "the environment named is not one this project has",
      layer: "SCOPE",
      ok: false,
    });
    expect(JSON.stringify(port.read({ environment: "preview" }))).not.toContain(CREDENTIAL);
  });

  /**
   * The design read, resolved through the REAL composition root. A fresh project has appended
   * no revision, so the honest answer is `DESIGN_REVISION_ABSENT` at the LEDGER layer -- the
   * LAYER is asserted with the code because the same code minted at another layer would mean a
   * different surface answered. `projectId` travels in the INPUT rather than being bound at
   * composition time: the HTTP handler passes the authenticated principal's project, so binding
   * it here as well would hide a principal/project mismatch.
   */
  it("provides a design read port that answers ABSENT from the bound store without writing", () => {
    const port = provider.designReads?.();
    expect(port).toBeDefined();
    if (port === undefined) return;

    const inspection = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      const aggregateId = designAggregateId("goal-missing");
      const before = inspection.getAggregateVersion(aggregateId);
      expect(port.read({ goalRef: "goal-missing", projectId: PROJECT })).toStrictEqual({
        code: "DESIGN_REVISION_ABSENT",
        layer: "LEDGER",
        ok: false,
        sourceCode: null,
        sourceLayer: null,
      });
      expect(inspection.getAggregateVersion(aggregateId)).toBe(before);
    } finally {
      inspection.close();
    }
  });

  it("refuses an unknown credential at the AUTHENTICATE stage", () => {
    const result = dispatch(registerEnvelope(), "wrong-credential");
    expect(result).toMatchObject({
      error: { code: "AUTHENTICATION_FAILED" },
      httpStatus: 401,
      ok: false,
      outcome: "REFUSED",
      stage: "AUTHENTICATE",
    });
  });

  it("commits project.register durably through the committed bootstrap service", () => {
    const result = dispatch(registerEnvelope());
    expect(result).toMatchObject({
      decision: {
        commandId: "cmd-register-1",
        disposition: "DECIDED",
        resultCode: "EFFECTS_COMMITTED",
      },
      httpStatus: 200,
      ok: true,
      outcome: "ACCEPTED",
    });
  });

  it("replays the identical command instead of re-running its effect", () => {
    const result = dispatch(registerEnvelope());
    expect(result).toMatchObject({
      decision: { disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" },
      ok: true,
      outcome: "ACCEPTED",
    });
  });

  it("surfaces a prerequisite refusal as a port refusal naming the refusing layer", () => {
    const result = dispatch({
      ...envelopeObject({
        commandId: "cmd-goal-early",
        commandKind: "goal.create",
        // Prose only: goal.create admits a brief and derives every identity, so a payload
        // naming one would be refused a stage EARLIER, at PAYLOAD_SHAPE, and this arm would
        // stop reaching the prerequisite layer it is about.
        payload: { instructions: "Seed the first goal.", title: "Early goal" },
        targetAggregateId: "goal-1",
      }),
      expectedVersion: 0,
    });
    expect(result).toMatchObject({
      httpStatus: 422,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_PREREQUISITE" },
      stage: "DISPATCH",
    });
  });

  it("baselines the stream, then serves a session.open committed through the adapter", () => {
    const port = provider.subscriptions?.();
    expect(port).toBeDefined();
    // Seating happens at the baseline checkpoint: earlier events belong to the
    // snapshot, so the first page is a PAGE (not a refusal) with nothing after it.
    const seated = port?.readPage({ projection: "moe.board", subscriberId: "control-room-1" });
    expect(seated).toMatchObject({ outcome: "PAGE" });

    const sessionSecret = "session-secret-1";
    const opened = dispatch({
      ...envelopeObject({
        commandId: "cmd-session-open-1",
        commandKind: "session.open",
        payload: {
          capabilities: ["goal.write"],
          credentialSha256: createHash("sha256").update(sessionSecret, "utf8").digest("hex"),
          expiresAt: "2027-01-01T00:00:00.000Z",
          sessionId: "sess-1",
        },
      }),
      expectedVersion: 0,
    });
    expect(opened).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
      ok: true,
      outcome: "ACCEPTED",
    });

    const page = port?.readPage({ projection: "moe.board", subscriberId: "control-room-1" });
    expect(page).toMatchObject({ outcome: "PAGE" });
    if (page?.outcome !== "PAGE") throw new Error("unreachable");
    expect(page.events.map((event) => event.eventType)).toContain("SessionOpened");
    if (page.nextCursor === null) throw new Error("expected a durable page offer");
    expect(port?.acknowledge({ cursor: page.nextCursor, subscriberId: "control-room-1" }))
      .toEqual({ cursor: page.nextCursor, outcome: "ACKNOWLEDGED" });
    expect(port?.readPage({ projection: "moe.board", subscriberId: "control-room-1" }))
      .toMatchObject({ events: [], nextCursor: null, outcome: "PAGE" });

    // The freshly opened session credential authenticates and carries goal.write:
    // goal.create passes AUTHENTICATE and AUTHORIZE, then refuses on the missing
    // project prerequisite — proving the session chain end to end.
    const viaSession = dispatch(
      {
        ...envelopeObject({
          commandId: "cmd-goal-via-session",
          commandKind: "goal.create",
          payload: { instructions: "Seed a goal through the session.", title: "Session goal" },
          targetAggregateId: "goal-2",
        }),
        expectedVersion: 0,
      },
      sessionSecret,
    );
    expect(viaSession).toMatchObject({
      httpStatus: 422,
      outcome: "PORT_REFUSED",
      refusal: { code: "BOOTSTRAP_PREREQUISITE_MISSING" },
    });
  });

  it("refuses an unregistered stream reader with the stable code", () => {
    const port = provider.subscriptions?.();
    const page = port?.readPage({ projection: "moe.board", subscriberId: "ghost-reader" });
    expect(page).toMatchObject({
      code: "SUBSCRIPTION_NOT_REGISTERED",
      layer: "STATE",
      outcome: "REFUSED",
    });
  });

  it("replays across a fresh store handle, proving the decision is durable", () => {
    const reopened = createStoreDependencies({
      clock: CLOCK,
      credential: CREDENTIAL,
      principalId: "operator-local",
      projectId: PROJECT,
      storePath,
    });
    try {
      const result = handleCommandRequest(reopened.provide(), {
        body: bytes(registerEnvelope()),
        credential: CREDENTIAL,
        protocolVersion: WIRE_PROTOCOL_VERSION,
      }, "HTTP_LISTENER");
      expect(result).toMatchObject({
        decision: { disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" },
        ok: true,
        outcome: "ACCEPTED",
      });
    } finally {
      reopened.close();
    }
  });
});

describe("subscription port quarantine on OUTCOME_UNKNOWN", () => {
  const READER = "control-room-1";
  const quarantineDirectory = realpathSync(mkdtempSync(join(tmpdir(), "moe-store-deps-quarantine-")));
  const quarantineProvider = createStoreDependencies({
    clock: CLOCK,
    credential: CREDENTIAL,
    principalId: "operator-local",
    projectId: "proj-quarantine",
    storePath: join(quarantineDirectory, "store.db"),
  });
  const quarantineDeps = quarantineProvider.provide();
  const portFactory = quarantineProvider.subscriptions;
  if (portFactory === undefined) throw new Error("unreachable: subscriptions is always wired");
  const port = portFactory();
  /** The handle the ambiguous COMMIT ran on. Production deliberately leaves it to
   *  GC; the TEST must close it or Windows keeps the store file locked at rmSync. */
  let quarantinedHandle: DatabaseSync | null = null;

  afterAll(() => {
    quarantineProvider.close();
    // Tolerated double close: without the quarantine the provider cache still IS
    // this handle, and provider.close() above has already closed it.
    try {
      quarantinedHandle?.close();
    } catch { /* already closed with the provider */ }
    rmSync(quarantineDirectory, { force: true, recursive: true });
  });

  function dispatchQuarantine(envelope: Record<string, unknown>) {
    return handleCommandRequest(quarantineDeps, {
      body: bytes(envelope),
      credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "HTTP_LISTENER");
  }

  /** The subscription-writes suite's fault-injection idiom: one call runs under a
   *  patched prototype exec, and the original is restored whatever was thrown. */
  function withPatchedExec<Result>(
    patch: (original: typeof DatabaseSync.prototype.exec) => typeof DatabaseSync.prototype.exec,
    run: () => Result,
  ): Result {
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = patch(original);
    try {
      return run();
    } finally {
      DatabaseSync.prototype.exec = original;
    }
  }

  function issuedCursor() {
    const page = port.readPage({ projection: "moe.board", subscriberId: READER });
    if (page.outcome !== "PAGE") throw new Error(`expected a PAGE, got ${page.outcome}`);
    if (page.nextCursor === null) throw new Error("expected a durable page offer");
    return page.nextCursor;
  }

  it("re-acquires a fresh handle after a lost COMMIT acknowledgement", () => {
    const registered = dispatchQuarantine({
      ...envelopeObject({
        commandId: "cmd-quarantine-register",
        commandKind: "project.register",
        payload: { owner: "operator-local" },
      }),
      expectedVersion: 0,
    });
    expect(registered).toMatchObject({ ok: true, outcome: "ACCEPTED" });
    const cursor = issuedCursor();

    // The store suite's lost-acknowledgement fault: COMMIT executes — the write
    // durably LANDS — and only its acknowledgement is lost on the way back.
    const caught = withPatchedExec(
      (original) => function execWithLostAck(this: DatabaseSync, sql: string): void {
        original.call(this, sql);
        if (sql.trim() === "COMMIT") {
          quarantinedHandle = this;
          throw new Error("simulated lost COMMIT acknowledgement");
        }
      },
      () => {
        try {
          port.acknowledge({ cursor, subscriberId: READER });
          return null;
        } catch (error) {
          return error;
        }
      },
    );
    expect(caught).toBeInstanceOf(DurableStoreError);
    expect((caught as DurableStoreError).code).toBe("OUTCOME_UNKNOWN");
    expect(quarantinedHandle).not.toBeNull();

    // The quarantine witness, and the arm that DISCRIMINATES against the old
    // behavior: acquire() marks itself with the busy_timeout pragma, so the SAME
    // port's next operation must run exactly one acquisition on an object that is
    // not the quarantined handle. The stale-handle behavior it replaces reused
    // the poisoned handle silently (zero acquisitions) and, because this fault
    // leaves the connection healthy, would even have answered correctly here.
    const acquired: unknown[] = [];
    const healed = withPatchedExec(
      (original) => function execRecordingAcquire(this: DatabaseSync, sql: string): void {
        if (sql.startsWith("PRAGMA busy_timeout")) acquired.push(this);
        original.call(this, sql);
      },
      () => port.readPage({ projection: "moe.board", subscriberId: READER }),
    );
    expect(acquired).toHaveLength(1);
    expect(acquired[0]).not.toBe(quarantinedHandle);

    // Durable truth, re-read through the fresh handle: the ambiguous COMMIT had
    // landed, so the cursor is already consumed — the page is empty at head and a
    // re-acknowledge of the consumed offer refuses instead of double-advancing.
    expect(healed).toMatchObject({ events: [], nextCursor: null, outcome: "PAGE" });
    expect(port.acknowledge({ cursor, subscriberId: READER })).toMatchObject({
      code: "SUBSCRIPTION_CURSOR_NOT_ISSUED", layer: "STATE", outcome: "REFUSED",
    });
  });

  it("keeps the cached handle across a clean acknowledge cycle", () => {
    const opened = dispatchQuarantine({
      ...envelopeObject({
        commandId: "cmd-quarantine-session",
        commandKind: "session.open",
        payload: {
          capabilities: ["goal.write"],
          credentialSha256: createHash("sha256")
            .update("quarantine-session-secret", "utf8").digest("hex"),
          expiresAt: "2027-01-01T00:00:00.000Z",
          sessionId: "sess-quarantine-1",
        },
      }),
      expectedVersion: 0,
    });
    expect(opened).toMatchObject({ ok: true, outcome: "ACCEPTED" });
    const cursor = issuedCursor();

    // Regression arm: two consecutive operations on a healthy port run ZERO
    // acquisitions — the cached pair is reused, no handle is reopened.
    const acquired: unknown[] = [];
    const [acknowledged, page] = withPatchedExec(
      (original) => function execRecordingAcquire(this: DatabaseSync, sql: string): void {
        if (sql.startsWith("PRAGMA busy_timeout")) acquired.push(this);
        original.call(this, sql);
      },
      () => [
        port.acknowledge({ cursor, subscriberId: READER }),
        port.readPage({ projection: "moe.board", subscriberId: READER }),
      ] as const,
    );
    expect(acknowledged).toEqual({ cursor, outcome: "ACKNOWLEDGED" });
    expect(page).toMatchObject({ events: [], nextCursor: null, outcome: "PAGE" });
    expect(acquired).toHaveLength(0);
  });
});

/**
 * vitest rewrites `./daemon-command-registry.js` back to the `.ts` module and `tsc`
 * never reads a bridge at all, so the extracted registry's runtime edge is invisible
 * to every in-process suite here. This probe therefore runs a REAL child Node process
 * against the shipped default provider: it imports `daemon-store-dependencies.ts` (the
 * module that carries the default export - an export-star bridge would not forward it),
 * which in turn resolves `./daemon-command-registry.js` through Node itself.
 */
const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHILD_SOURCE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const { RECOVERY_BINDING_CODEC_VERSION, SqliteEventStore } = await import("@moe/store");
  const setup = SqliteEventStore.openForProject(
    process.env.MOE_STORE_PATH, process.env.MOE_PROJECT_ID,
  );
  const installed = setup.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: "${"71".repeat(32)}",
    installedAt: "2026-08-12T00:00:00.000Z",
    keyEpochRef: "${"72".repeat(32)}",
    payload: new TextEncoder().encode("child-smoke-recovery-binding"),
    slot: "ACTIVE",
  });
  setup.close();
  if (!installed.ok) throw new Error("recovery binding refused: " + installed.code);

  const provider = (await import("./src/daemon-store-dependencies.ts")).default;
  const bridged = await import("./src/daemon-command-registry.js");
  const { RUNTIME_COMMAND_ENVELOPE_VERSION } = await import("@moe/contracts");
  const { handleCommandRequest } = await import("./src/http/http-adapter.ts");
  const { WIRE_PROTOCOL_VERSION } = await import("./src/http/http-contract.ts");
  const deps = provider.provide();
  const entry = deps.registry.get("project.register");
  const dispatch = () => handleCommandRequest(deps, {
    body: new TextEncoder().encode(JSON.stringify({
      commandId: "cmd-child-register", commandKind: "project.register",
      correlationId: "corr-child", expectedVersion: 0, payload: { owner: "operator-local" },
      requestDigest: "c".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: process.env.MOE_DAEMON_CREDENTIAL, targetAggregateId: "agg-child",
    })),
    credential: process.env.MOE_DAEMON_CREDENTIAL,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
  const first = dispatch();
  const second = dispatch();
  const sourceSnapshotPublisher = provider.sourceSnapshotPublisher();
  // CALLED, not merely counted: \`providerKeys\` reads the default provider object, so a port
  // whose key is present there but absent from the COMPOSITION's return would pass that arm
  // and throw "unreachable" the first time production asked for it. Invoking it is what binds
  // the composition factory to the shipped provider.
  const remote = provider.repositoryRemote();
  const remoteView = remote.readRemote();
  const shapeOf = (result) => ({
    commandId: result.decision?.commandId ?? null,
    disposition: result.decision?.disposition ?? null,
    outcome: result.outcome,
    resultCode: result.decision?.resultCode ?? null,
  });
  report({
    outcome: "LOADED",
    bridgeExports: Object.keys(bridged).sort(),
    depsKeys: Object.keys(deps).sort(),
    first: shapeOf(first),
    providerKeys: Object.keys(provider).sort(),
    registerCapability: entry.requiredCapability,
    registerHandler: typeof entry.handler,
    registerPayloadKeys: entry.payloadKeys,
    registryKinds: [...deps.registry.keys()].sort(),
    remoteBoundProjectId: remote.boundProjectId,
    remoteKeys: Object.keys(remoteView).sort(),
    remoteOutcome: remoteView.outcome,
    remoteUrl: remoteView.remoteUrl,
    sameEffect: first.decision?.effectId === second.decision?.effectId,
    sameSourceSnapshotPublisher:
      sourceSnapshotPublisher === provider.sourceSnapshotPublisher(),
    second: shapeOf(second),
  });
} catch (error) {
  report({ outcome: "FAILED", code: error?.code ?? "NO_CODE", message: String(error?.message) });
}
`;

it("serves the default provider and its registry bridge under plain Node", { timeout: 180_000 }, async () => {
  const childDirectory = realpathSync(mkdtempSync(join(tmpdir(), "moe-store-deps-child-")));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", CHILD_SOURCE],
      {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          MOE_DAEMON_CREDENTIAL: "child-operator-credential",
          MOE_PROJECT_ID: "proj-child-smoke",
          MOE_STORE_PATH: join(childDirectory, "store.db"),
        },
        maxBuffer: 1_000_000,
        shell: false,
        timeout: 120_000,
        windowsHide: true,
      },
    );
    // Values, not typeofs: a binding that resolved to the wrong module, a
    // registry that lost an entry, or a replay that ran the effect twice all
    // have to show up here rather than pass as "it imported".
    expect(JSON.parse(stdout)).toEqual({
      outcome: "LOADED",
      bridgeExports: ["OPERATOR_CAPABILITIES", "agentCapabilitiesFor", "createDaemonCommandPorts"],
      depsKeys: ["authenticator", "decisions", "eventStreamAccess", "registry"],
      first: {
        commandId: "cmd-child-register", disposition: "DECIDED",
        outcome: "ACCEPTED", resultCode: "EFFECTS_COMMITTED",
      },
      // THE EXACT KEY SET, and `graph` is why it is exact. A port constructed by
      // `createStoreDependencies` but absent from the shipped default object is
      // unreachable from the real daemon while every direct-injection test stays
      // green; a subset assertion would have blessed exactly that omission.
      providerKeys: [
        "activation", "activity", "affordances", "budgetCommitment", "commandAuthorityPlane",
        "designReads", "documentCoverage",
        "documentDossiers",
        "documentIngest", "environmentReads", "goalCatalog", "goalSource",
        "graph", "health",
        "pairingOpenSessions",
        // `previews` is the daemon's ONE preview supervisor, forwarded for exactly the reason
        // stated above: absent here, the shipped daemon's shutdown sweeps nothing and every
        // preview server it started keeps its port after the daemon is gone.
        "planningRuns", "policy", "previews", "productContractGate1", "productContractPending",
        "productContractV2Current", "productContractV2Pending",
        "provide", "provideV2", "reconciliation", "repositoryRemote", "repositoryWorkflows", "restore", "runs",
        "sessionChallengeOperands", "sessionHandshake", "sessions", "sourceSnapshotPublisher",
        "subscriptions",
      ],
      // The repository-remote read, resolved through the REAL composition in this child: the
      // provider key alone cannot prove the composition supplies it. Nothing has published in
      // this fresh store, so the honest answer is the unbound view -- all nulls under an
      // `outcome: "REMOTE"`, never a refusal -- bound to this child's own project.
      remoteBoundProjectId: "proj-child-smoke",
      remoteKeys: ["boundAt", "boundBy", "outcome", "readAt", "remoteUrl"],
      remoteOutcome: "REMOTE",
      remoteUrl: null,
      registerCapability: "project.admin",
      registerHandler: "function",
      registerPayloadKeys: ["owner"],
      // The kind SET, not its size: a bare count lands every registration as an
      // off-by-one naming nothing. A new command writes its own kind here.
      registryKinds: [
        "approval.decide", "approval.decide_intent",
        "criterion_check.approve", "criterion_check.verify",
        "cutover.activate",
        // The design authoring wire (task-06ac0da1): a SEAT kind, unlike its neighbours here.
        "design.submit",
        "effect.activate",
        // The two OPERATOR-ONLY environment writes (task-a2409cba), served by their own edge.
        "environment.set_variable", "environment.unset_variable",
        "escalation.decide", "events.resume", "foundation.dispatch",
        "foundation.verification",
        "goal.close",
        "goal.create",
        "goal.create_with_source",
        "graph.approve", "graph.prepare_supersession", "graph.release_preparation",
        "graph.request_expansion", "graph.supersede",
        "integration.accept_output", "journal.append",
        "plan.propose", "planning.submit_decomposition", "policy.install",
        "policy.validate", "preview.decide",
        "product_contract.answer_clarification", "product_contract.approve_gate_1",
        "product_contract.ask_clarification", "product_contract.propose_revision",
        "project.activate", "project.bind_repository", "project.register",
        "provider.probe", "qualification.replan", "recovery.complete",
        "repository.bootstrap", "repository.publish", "repository.recover",
        "resource.confirm_released", "resource.reconcile",
        "review.submit",
        "session.close", "session.open", "session.renew",
        "step.checkpoint", "step.finish", "step.start",
        "work.claim", "work.release",
        "work.renew", "work.resume",
      ],
      sameEffect: true,
      sameSourceSnapshotPublisher: true,
      second: {
        commandId: "cmd-child-register", disposition: "REPLAYED",
        outcome: "ACCEPTED", resultCode: "EFFECTS_COMMITTED",
      },
    });
  } finally {
    // Only after the child exits: Windows keeps the SQLite file locked while it lives.
    rmSync(childDirectory, { force: true, recursive: true });
  }
});

describe("first boot", () => {
  it("authenticates the operator on a fresh store with no manual binding install", () => {
    // The genesis seam: no restore has run, no fixture installed a binding.
    // Before genesis wiring this deadlocked — the operator could never get in.
    const freshDirectory = realpathSync(mkdtempSync(join(tmpdir(), "moe-first-boot-")));
    const freshProvider = createStoreDependencies({
      clock: CLOCK,
      credential: CREDENTIAL,
      principalId: "operator-local",
      projectId: PROJECT,
      storePath: join(freshDirectory, "store.db"),
    });
    try {
      const verdict = freshProvider.provide().authenticator.authenticate(CREDENTIAL).verdict;
      expect(verdict).toBe("AUTHENTICATED");
    } finally {
      freshProvider.close();
      rmSync(freshDirectory, { force: true, recursive: true });
    }
  });
});

describe("Foundation wiring startup cleanup", () => {
  const mismatchDigest = (durable: string): string => hex(durable.startsWith("b") ? "c" : "b");
  const acquireInput = (storePath: string, durable: string) => ({
    clock: CLOCK, projectConfigurationDigest: mismatchDigest(durable),
    projectId: CONFIGURATION_PROJECT, storePath,
  });

  function bestEffortRemoveFixture(directory: string): void {
    // The assertion owns Windows lock evidence; cleanup must never replace that failure.
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* process exit releases a mutant's leaked handle */ }
  }

  function countingOpener(counter: { count: number }, throwAfterClose = false) {
    return (path: string, projectId: string): SqliteEventStore => {
      const real = SqliteEventStore.openForProject(path, projectId);
      return new Proxy(real, {
        get(target, key) {
          if (key === "close") return (): void => {
            counter.count += 1;
            target.close();
            if (throwAfterClose) throw new Error("cleanup close failed");
          };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
  }

  it("consumer closes its real store before surfacing a digest mismatch", () => {
    const fixture = createConfigurationStore();
    try {
      expect(() => createStoreDependencies({
        credential: CREDENTIAL, principalId: "operator-local",
        projectConfigurationDigest: mismatchDigest(fixture.settingsDigest),
        projectId: CONFIGURATION_PROJECT,
        storePath: fixture.storePath,
      })).toThrowError(/^PROJECT_CONFIGURATION_DIGEST_MISMATCH:/u);
      expect(() => rmSync(fixture.directory, { force: true, recursive: true })).not.toThrow();
    } finally {
      bestEffortRemoveFixture(fixture.directory);
    }
  });

  it("closes exactly once before rethrowing a digest mismatch", () => {
    const fixture = createConfigurationStore();
    const counter = { count: 0 };
    try {
      expect(() => acquireFoundationStore(
        acquireInput(fixture.storePath, fixture.settingsDigest), countingOpener(counter),
      )).toThrowError(/^PROJECT_CONFIGURATION_DIGEST_MISMATCH:/u);
      expect(counter.count).toBe(1);
      expect(() => rmSync(fixture.directory, { force: true, recursive: true })).not.toThrow();
    } finally {
      bestEffortRemoveFixture(fixture.directory);
    }
  });

  it("never lets a cleanup failure mask the digest mismatch", () => {
    const fixture = createConfigurationStore();
    const counter = { count: 0 };
    try {
      expect(() => acquireFoundationStore(
        acquireInput(fixture.storePath, fixture.settingsDigest), countingOpener(counter, true),
      )).toThrowError(/^PROJECT_CONFIGURATION_DIGEST_MISMATCH:/u);
      expect(counter.count).toBe(1);
      expect(() => rmSync(fixture.directory, { force: true, recursive: true })).not.toThrow();
    } finally {
      bestEffortRemoveFixture(fixture.directory);
    }
  });

  it("keeps the real opener as a defaulted production dependency", () => {
    const fixture = createConfigurationStore();
    expect(acquireFoundationStore.length).toBe(1);
    const acquired = acquireFoundationStore({
      clock: CLOCK, projectId: CONFIGURATION_PROJECT, storePath: fixture.storePath,
    });
    try {
      expect(acquired.store.getHealth()).toMatchObject({
        databasePath: fixture.storePath,
        durability: "WAL_FILE",
        projectId: CONFIGURATION_PROJECT,
      });
    } finally {
      acquired.store.close();
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });
});

/**
 * task-ed89967f / R3-016 — THE CONSUMER EDGE for the composition's one-line principal forward.
 *
 * Epic rail 8B: a gate must assert a consumer edge, not a producer's own presence. Every other
 * arm for this feature drives `createAffordancePort` directly, which stays green even if the
 * composition root never forwards `config.principalId` — the feature would then exist in the
 * module and not in the daemon. This arm is the only one that fails when that single property is
 * dropped, because without it the composed surface's authority map is EMPTY.
 */
describe("the composed affordance port carries planning authority (task-ed89967f / R3-016)", () => {
  const AUTHORITY_PROJECT = "proj-store-deps-authority";
  /** Deliberately NOT the registered project owner below, so the arm distinguishes a forwarded
   *  configured principal from a producer that reached for the owner. */
  const AUTHORITY_PRINCIPAL = "principal-composed-1";
  const AUTHORITY_OWNER = "operator-local";
  const NODE_REF = "node-composed-1";
  const GOAL_COMMAND = "composed-goal";
  const GOAL_ID = `goal-${GOAL_COMMAND}`;
  const RUN_ID = `run-${GOAL_COMMAND}`;

  const authorityDirectory = realpathSync(mkdtempSync(join(tmpdir(), "moe-store-deps-authority-")));
  const authorityStorePath = join(authorityDirectory, "store.db");
  const nodeSpecsDir = join(authorityDirectory, "nodes");

  function seedWorld(): void {
    mkdirSync(nodeSpecsDir, { recursive: true });
    // EXACTLY ONE merged node: `mergedNodes` unions spec files with compiled nodes, and this
    // world has no approved plan, so the compiled side contributes none.
    writeFileSync(
      join(nodeSpecsDir, "node.json"),
      JSON.stringify({ nodeRef: NODE_REF, title: "The composed node" }),
      "utf8",
    );
    writeFileSync(join(nodeSpecsDir, "forged-compiled.json"), JSON.stringify({
      nodeRef: `node:v1:${"a".repeat(64)}`, title: "An operator spec cannot override compiled work",
    }), "utf8");
    for (const [name, nodeRef] of [["publish", "publish:decision"], ["criterion", "criterion:v1:run"]]) {
      writeFileSync(join(nodeSpecsDir, `${name}.json`), JSON.stringify({ nodeRef, title: "Reserved workflow" }), "utf8");
    }
    const store = SqliteEventStore.openForProject(authorityStorePath, AUTHORITY_PROJECT);
    installTestRecoveryBinding(store);
    let minted = 0;
    const commit = (
      kind: string, payload: Record<string, unknown>, expectedVersion = 0, commandId?: string,
    ): void => {
      const outcome = runBootstrapCommand(store, new TextEncoder().encode(JSON.stringify({
        commandId: commandId ?? `composed-${kind}-${String(minted += 1)}`,
        correlationId: "corr-r3-016-composed",
        decidedAt: CLOCK(),
        expectedVersion,
        kind,
        payload,
        principalId: AUTHORITY_OWNER,
        projectId: AUTHORITY_PROJECT,
        schemaVersion: "moe-bootstrap-command/1",
      })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS }, undefined,
      // `project.activate` MINTS its witness from measured receipts, never the payload.
      FIXTURE_ACTIVATION_RECEIPTS);
      if (!outcome.ok) throw new Error(`${kind}: ${outcome.code} (${outcome.refusedBy})`);
    };
    commit("project.register", { owner: AUTHORITY_OWNER });
    commit("project.bind_repository", {
      observation: {
        baseRevisionHash: hex("b"), repositoryRef: "repo-composed",
        scopeRef: "scope-composed", truthClass: "DAEMON_VERIFIED",
      },
    }, 1);
    commit("provider.probe", { observation: PROVIDER_OBSERVATION });
    commit("policy.install", { slice: POLICY_SLICE });
    commit("policy.install", { slice: CLASSIFYING_POLICY_SLICE }, 1);
    commit("project.activate", // NO WITNESS: the daemon mints it from its own measured receipts.
      {}, 2);
    commit("goal.create", {
      instructions: "Carry the composed planning run.", title: "Composed goal",
    }, 0, GOAL_COMMAND);
    store.close();
  }

  seedWorld();
  const authorityProvider = createStoreDependencies({
    clock: CLOCK,
    credential: CREDENTIAL,
    nodeSpecsDir,
    principalId: AUTHORITY_PRINCIPAL,
    projectId: AUTHORITY_PROJECT,
    storePath: authorityStorePath,
  });

  afterAll(() => {
    authorityProvider.close();
    rmSync(authorityDirectory, { force: true, recursive: true });
  });

  it("authors the composed authority map with the configured StoreDependencyConfig principal", () => {
    const port = authorityProvider.affordances?.();
    expect(port).toBeDefined();
    if (port === undefined) throw new Error("affordances is always wired");
    const read = port.readSurface();
    if (read.outcome !== "SURFACE") throw new Error(`refused: ${read.code}`);

    // THE CONTROL that makes the assertion below load-bearing: the world really does offer an
    // eligible run and really does bind it, so an empty map could only mean a missing forward.
    expect(read.planningGoalRefs).toEqual({ [RUN_ID]: GOAL_ID });
    expect(read.nextAllowedCommands.some((offer) =>
      offer.commandKind === "plan.propose" && offer.targetAggregateId === RUN_ID)).toBe(true);

    expect(Object.keys(read.planningAuthorityByRun)).toEqual([RUN_ID]);
    const entry = read.planningAuthorityByRun[RUN_ID];
    if (entry === undefined) throw new Error("the composed run must carry material");
    expect(entry.goalRef).toBe(GOAL_ID);
    // The one line under test. `AUTHORITY_PRINCIPAL` reaches this material ONLY through
    // `principalId: config.principalId` in daemon-store-foundation-composition.ts.
    expect((entry.authority["planRevision"] as Record<string, unknown>)["authorRef"])
      .toBe(AUTHORITY_PRINCIPAL);
    expect(AUTHORITY_PRINCIPAL).not.toBe(AUTHORITY_OWNER);
    // And the merged-node roster really came from the composed spec directory.
    expect((entry.authority["planRevision"] as Record<string, unknown>)["affectedNodeIds"])
      .toEqual([NODE_REF]);
  });
});

/**
 * THE DEPLOYMENT KINDS' FENCE ROSTERS, BOTH DIRECTIONS (DoD 1 of task-04b3ce7e).
 *
 * Deploying a product, and naming the host it deploys to, are operator acts. Three independent
 * rosters carry that fact — the dispatch fence (`OPERATOR_PRINCIPAL_KINDS`), the transport
 * exclusion derived from it (`mcp-tool-allowlist.ts`) and the staffing fence the WRAPPER reads
 * (`HUMAN_ONLY_STEPS`) — and a kind fenced in two of the three is reachable through the third.
 *
 * SET EQUALITY, NOT MEMBERSHIP, and computed per roster from the ADVERTISED deployment kinds
 * rather than from a hand-written pair: a third deployment kind added to `PAYLOAD_KEYS` without
 * its fences reds here instead of shipping reachable. Deleting an entry from ANY side reds,
 * which is the property DoD 1 names.
 *
 * NO COUNT LITERAL ANYWHERE IN THE ARM. Eight rows are moving these rosters concurrently; every
 * assertion below relates production surfaces to each other, so a sibling landing a kind cannot
 * red it spuriously.
 */
describe("the deployment kinds are published human-only and MCP-excluded", () => {
  const advertised = Object.keys(PAYLOAD_KEYS)
    .filter((kind) => kind.startsWith("deployment.")).sort();
  const deploymentMembers = (roster: Iterable<string>): readonly string[] =>
    [...roster].filter((kind) => kind.startsWith("deployment.")).sort();

  it("advertises both kinds, so the equalities below have a non-empty subject", () => {
    // A roster arm whose subject is empty passes VACUOUSLY. This is the control that keeps the
    // three equalities meaningful, and it names the kinds once so a rename is caught here.
    expect(advertised).toEqual(["deployment.deploy", "deployment.set_target"]);
  });

  it("fences every advertised deployment kind at dispatch, on MCP and in the wrapper", () => {
    // (1) THE DISPATCH FENCE. Set-equal, so an operator-roster entry deleted for one kind reds.
    expect(deploymentMembers(OPERATOR_PRINCIPAL_KINDS)).toEqual(advertised);
    // (2) THE TRANSPORT EXCLUSION, asserted on BOTH sides of the derivation: present in the
    // excluded roster AND absent from the allowlist the two MCP entries actually pass to
    // `@moe/mcp`. Asserting only the first would stay green if the allowlist stopped
    // subtracting the exclusion.
    expect(deploymentMembers(MCP_EXCLUDED_COMMAND_KINDS)).toEqual(advertised);
    expect(deploymentMembers(wiredMcpToolKinds())).toEqual([]);
    // (3) THE STAFFING FENCE. Both kinds carry a non-null agent capability (GOAL, like
    // `repository.publish`), so absence here is a staffed-deployer leak the capability gate
    // would not refuse.
    expect(deploymentMembers(HUMAN_ONLY_STEPS)).toEqual(advertised);
  });

  it("serves deployment.deploy from the ASYNC half of the surface, never the sync tables", () => {
    // The served surface has two halves, and the sync tables are no longer the whole seam. A
    // roster arm that enumerated only the synchronous handlers would report this kind as
    // advertised-but-unserved; one that trusted the advertised roster alone would stay green
    // while the async entry vanished.
    const synchronous = Object.keys({
      ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS,
    });
    expect(synchronous.filter((kind) => kind.startsWith("deployment."))).toEqual([]);
    // `deployment.deploy` and ONLY it: `deployment.set_target` is an ordinary synchronous write
    // whose handler is a sibling row's, so naming it here would claim an async seam it does not
    // have. The membership is proved rather than declared in
    // daemon-command-async-entries.test.ts, which dispatches the kind through the entry.
    expect(deploymentMembers(ASYNC_SERVED_BOOTSTRAP_KINDS)).toEqual(["deployment.deploy"]);
  });
});
