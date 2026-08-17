import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { documentWorkAggregateId } from "./documents/document-work-service.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import {
  STORE_DEPENDENCIES_ENV_MISSING,
  createStoreDependencies,
  readStoreDependencyEnv,
} from "./daemon-store-dependencies.js";
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
});

describe("createStoreDependencies", () => {
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
        payload: {
          budgetAccountRef: "budget-1", goalId: "goal-1",
          planningRunRef: "run-1", witness: {},
        },
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
          payload: {
            budgetAccountRef: "budget-1", goalId: "goal-2",
            planningRunRef: "run-1", witness: {},
          },
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
      depsKeys: ["authenticator", "decisions", "registry"],
      first: {
        commandId: "cmd-child-register", disposition: "DECIDED",
        outcome: "ACCEPTED", resultCode: "EFFECTS_COMMITTED",
      },
      providerKeys: [
        "affordances", "documentDossiers", "provide", "reconciliation", "restore", "subscriptions",
      ],
      registerCapability: "project.admin",
      registerHandler: "function",
      registerPayloadKeys: ["owner"],
      // The kind SET, not its size: a bare count lands every registration as an
      // off-by-one naming nothing. A new command writes its own kind here.
      registryKinds: [
        "approval.decide", "effect.activate", "escalation.decide", "goal.close",
        "goal.create", "integration.accept_output", "journal.append",
        "plan.propose", "policy.install",
        "policy.validate", "project.activate", "project.bind_repository", "project.register",
        "provider.probe", "qualification.replan", "recovery.complete", "review.submit",
        "session.close", "session.open", "session.renew", "work.claim", "work.release",
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
