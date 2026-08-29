import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DurableStoreError, SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

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
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { bytes, envelopeObject } from "./http/http-test-fixtures.js";

const CREDENTIAL = "test-operator-credential";
const PROJECT = "proj-store-deps";
const CLOCK = (): string => "2026-08-09T12:00:00.000Z";

const directory = mkdtempSync(join(tmpdir(), "moe-store-deps-"));
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
  });
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
    const directory = mkdtempSync(join(tmpdir(), `moe-store-deps-catalog-${label}-`));
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
      });
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
  const quarantineDirectory = mkdtempSync(join(tmpdir(), "moe-store-deps-quarantine-"));
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
    });
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
  });
  const first = dispatch();
  const second = dispatch();
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
    sameEffect: first.decision?.effectId === second.decision?.effectId,
    second: shapeOf(second),
  });
} catch (error) {
  report({ outcome: "FAILED", code: error?.code ?? "NO_CODE", message: String(error?.message) });
}
`;

it("serves the default provider and its registry bridge under plain Node", { timeout: 180_000 }, async () => {
  const childDirectory = mkdtempSync(join(tmpdir(), "moe-store-deps-child-"));
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
        "affordances", "documentDossiers", "documentIngest", "goalCatalog", "graph",
        "planningRuns", "provide", "reconciliation", "restore", "sessionHandshake", "subscriptions",
      ],
      registerCapability: "project.admin",
      registerHandler: "function",
      registerPayloadKeys: ["owner"],
      // The kind SET, not its size: a bare count lands every registration as an
      // off-by-one naming nothing. A new command writes its own kind here.
      registryKinds: [
        "approval.decide", "approval.decide_intent",
        "effect.activate", "escalation.decide", "events.resume", "foundation.dispatch",
        "foundation.verification",
        "goal.close",
        "goal.create",
        "goal.create_with_source",
        "graph.approve", "graph.prepare_supersession", "graph.release_preparation",
        "graph.request_expansion", "graph.supersede",
        "integration.accept_output", "journal.append",
        "plan.propose", "policy.install",
        "policy.validate", "product_contract.approve_gate_1",
        "project.activate", "project.bind_repository", "project.register",
        "provider.probe", "qualification.replan", "recovery.complete",
        "resource.confirm_released", "resource.reconcile",
        "review.submit",
        "session.close", "session.open", "session.renew",
        "step.checkpoint", "step.finish", "step.start",
        "work.claim", "work.release",
        "work.renew", "work.resume",
      ],
      sameEffect: true,
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
    const freshDirectory = mkdtempSync(join(tmpdir(), "moe-first-boot-"));
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
