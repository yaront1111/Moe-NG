import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject, RuntimeCommandKind } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { handleAsyncCommandRequest, handleCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { ensureGenesisRecoveryBinding } from "../identity/genesis-recovery-binding.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { CONTROLLED_PROFILE_VERSION } from "./controlled-profile/controlled-profile-generator.js";
import { readBootstrapReceipt } from "./repository-bootstrap-read.js";

const PROJECT = "bootstrap-authorization";
const OPERATOR = "bootstrap-operator";
const OPERATOR_CREDENTIAL = "bootstrap-test-operator";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.(); });

function wire(kind: RuntimeCommandKind, credential: string, payload: JsonObject) {
  return {
    body: new TextEncoder().encode(JSON.stringify({
      commandId: kind, commandKind: kind, correlationId: "bootstrap-authorization",
      expectedVersion: 0, payload, requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: credential,
      targetAggregateId: PROJECT,
    })),
    credential, protocolVersion: WIRE_PROTOCOL_VERSION,
  };
}

function harness(capabilities: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), "moe-bootstrap-authorization-"));
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }); });
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
  cleanups.push(() => { store.close(); });
  const clock = (): string => new Date().toISOString();
  ensureGenesisRecoveryBinding(store, { clock, projectId: PROJECT });
  const minted = createOperatorSessionHandshakePort({
    capabilities, clock: Date.now, operatorPrincipalId: OPERATOR, projectId: PROJECT,
    reservedPrincipalIds: [OPERATOR], sessionTtlMs: 60_000, store,
  }).mint();
  if (!minted.ok) throw new Error(`PAIRING_FAILED:${minted.code}`);
  // Production pairing mint, not a synthetic principal or an authenticator double.
  expect(isDurableHumanPrincipal(store, minted.principalId)).toBe(true);
  const authenticator = createSessionAuthenticator(store, {
    clock: Date.now, operatorCapabilities: ["project.admin"],
    operatorCredential: OPERATOR_CREDENTIAL, operatorPrincipalId: OPERATOR, projectId: PROJECT,
  });
  const registered: string[] = [];
  const deps = { authenticator, ...createDaemonCommandPorts({
    clock, operatorPrincipalId: OPERATOR, projectId: PROJECT, store,
    repositoryBootstrap: { catalog: async (request) => { registered.push(request.root); } },
  }) };
  expect(handleCommandRequest(deps,
    wire("project.register", OPERATOR_CREDENTIAL, { owner: "bootstrap-owner" }),
    "HTTP_LISTENER")).toMatchObject({ outcome: "ACCEPTED" });
  const dir = join(root, "product");
  const bootstrap = (credential = minted.credential) => handleAsyncCommandRequest(deps,
    wire("repository.bootstrap", credential, {
      dir, productName: "paired-product", profileVersion: CONTROLLED_PROFILE_VERSION,
    }), "HTTP_LISTENER");
  return { authenticator, bootstrap, dir, minted, registered, store };
}

function expectBootstrap(h: ReturnType<typeof harness>): void {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.dir, encoding: "utf8" }).trim();
  expect(readBootstrapReceipt(h.store, PROJECT)).toMatchObject({
    receipt: { outcome: "BOOTSTRAPPED", dir: h.dir, sha, refusal: null },
  });
  expect(h.registered).toEqual([h.dir]);
  expect(readDurableLedger(h.store, PROJECT).kinds.has("project.bind_repository")).toBe(true);
}

describe("repository.bootstrap authorization through registered HTTP ingress", () => {
  it("admits a paired durable HUMAN with ADMIN and commits and binds a real repository", async () => {
    const h = harness(["project.admin"]);
    expect(await h.bootstrap()).toMatchObject({ outcome: "ACCEPTED" });
    expectBootstrap(h);
  });

  it("refuses a paired HUMAN without ADMIN at AUTHORIZE, before any effect", async () => {
    const h = harness(["goal.write"]);
    expect(await h.bootstrap()).toMatchObject({
      outcome: "REFUSED", httpStatus: 403, stage: "AUTHORIZE", error: { code: "CAPABILITY_DENIED" },
    });
    expect(existsSync(h.dir)).toBe(false);
    expect(h.registered).toEqual([]);
    expect(readBootstrapReceipt(h.store, PROJECT).receipt).toBe(null);
  });

  it("retains the operator credential identity and successful bootstrap path", async () => {
    const h = harness(["project.admin"]);
    expect(h.authenticator.authenticate(OPERATOR_CREDENTIAL)).toMatchObject({
      verdict: "AUTHENTICATED", principal: { principalId: OPERATOR, capabilities: ["project.admin"] },
    });
    expect(await h.bootstrap(OPERATOR_CREDENTIAL)).toMatchObject({ outcome: "ACCEPTED" });
    expectBootstrap(h);
  });

  it("refuses an unpaired credential at AUTHENTICATE, before any effect", async () => {
    const h = harness(["project.admin"]);
    expect(await h.bootstrap("unpaired-test-credential")).toMatchObject({
      outcome: "REFUSED", httpStatus: 401, stage: "AUTHENTICATE", error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(existsSync(h.dir)).toBe(false);
    expect(h.registered).toEqual([]);
  });

  it("preserves the non-empty-directory refusal for a paired ADMIN human", async () => {
    const h = harness(["project.admin"]);
    mkdirSync(h.dir);
    const occupant = join(h.dir, "existing-work.txt");
    writeFileSync(occupant, "preserve existing work\n");
    const before = createHash("sha256").update(readFileSync(occupant)).digest("hex");
    expect(await h.bootstrap()).toMatchObject({
      outcome: "PORT_REFUSED", httpStatus: 422, stage: "DISPATCH",
      refusal: { code: "BOOTSTRAP_DIR_NOT_EMPTY", layer: "DAEMON_INGRESS" },
    });
    expect(createHash("sha256").update(readFileSync(occupant)).digest("hex")).toBe(before);
    expect(existsSync(join(h.dir, ".git"))).toBe(false);
    expect(h.registered).toEqual([]);
    expect(readBootstrapReceipt(h.store, PROJECT)).toMatchObject({
      receipt: { outcome: "REFUSED", refusal: {
        code: "BOOTSTRAP_DIR_NOT_EMPTY", refusedBy: "DAEMON_INGRESS",
      } },
    });
  });
});

// Admission-only boundary change: pin raw bytes of the engine at task-claim ff5c51ac.
it.each([
  ["service", "ac37118bc82aa1eead544bcf66299fee2c96c62d1fd8ce20322546a83978be44"],
  ["ports", "e69f2f493a6427f175578e9b14555f6654cb9d4066c15b1baceffc80a1de0f8a"],
  ["contracts", "eb133eafec0cca669eb00830262e51a1250ecb5e6aa24823553ec4e0d59efb61"],
])("preserves the bootstrap %s engine bytes", (suffix, hash) => {
  const bytes = readFileSync(new URL(`./repository-bootstrap-${suffix}.ts`, import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
});
