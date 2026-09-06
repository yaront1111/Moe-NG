import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createRepositoryWorkflowWiring } from "../daemon-repository-workflow-wiring.js";
import { handleAsyncCommandRequest, handleCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import type { Authenticator, CommandAdapterDeps } from "../http/http-contract.js";
import { startControlRoomListener } from "../http/http-listener.js";
import type { ControlRoomListener } from "../http/http-listener.js";
import type { RepositoryWorkflowReadPort } from "../http/repository-workflow-read.js";
import { CONTROLLED_PROFILE_VERSION } from "./controlled-profile/controlled-profile-generator.js";
import type { BootstrapGhPort } from "./repository-bootstrap-contracts.js";

// Every receipt assertion crosses the real HTTP listener; no ledger/receipt reader shortcut.
const PROJECT = "project-bootstrap-disclosure", OPERATOR = "operator", CSRF = "disclosure-csrf";
const NOW = "2026-09-06T09:00:00.000Z", PATH = "/repository/bootstrap/read";
const encoder = new TextEncoder();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "disclosure fixture cleanup failed");
});

const authenticator: Authenticator = { authenticate(credential) {
  if (!["operator", "reader", "no-capability", "foreign"].includes(credential ?? ""))
    return { verdict: "UNAUTHENTICATED" };
  return { verdict: "AUTHENTICATED", principal: {
    principalId: credential === "operator" ? OPERATOR : "reader",
    projectId: credential === "foreign" ? "foreign-project" : PROJECT,
    capabilities: credential === "no-capability" ? [] : credential === "operator"
      ? [CAPABILITIES.ADMIN, CAPABILITIES.GOAL] : [CAPABILITIES.GOAL],
  } };
} };

function command(commandId: string, commandKind: string, payload: unknown) {
  return { credential: "operator", protocolVersion: WIRE_PROTOCOL_VERSION,
    body: encoder.encode(JSON.stringify({ commandId, commandKind, payload, expectedVersion: 0,
      correlationId: "disclosure-correlation", requestDigest: "b".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: "operator",
      targetAggregateId: "disclosure-command" })) };
}

function harness(gh?: BootstrapGhPort) {
  const temp = mkdtempSync(join(tmpdir(), "moe-bootstrap-disclosure-"));
  cleanups.push(() => rmSync(temp, { recursive: true, force: true }));
  const storePath = join(temp, "store.sqlite");
  const store = SqliteEventStore.openForProject(storePath, PROJECT);
  cleanups.push(() => store.close());
  const ports = createDaemonCommandPorts({ store, projectId: PROJECT, operatorPrincipalId: OPERATOR,
    clock: () => NOW, repositoryBootstrap: { catalog: async () => {}, ...(gh ? { gh } : {}) } });
  const deps: CommandAdapterDeps = { authenticator, registry: ports.registry, decisions: ports.decisions };
  expect(handleCommandRequest(deps, command("register", "project.register", { owner: OPERATOR }),
    "HTTP_LISTENER").outcome).toBe("ACCEPTED");
  const wiring = createRepositoryWorkflowWiring({ store, projectId: PROJECT, storePath,
    workspace: null, clock: () => NOW });
  return { temp, store, deps, wiring };
}
type Harness = ReturnType<typeof harness>;

async function start(h: Harness, port: RepositoryWorkflowReadPort | null = h.wiring.repositoryWorkflows()) {
  const listener = await startControlRoomListener({ csrfToken: CSRF, deps: h.deps,
    ...(port === null ? {} : { repositoryWorkflows: port }) });
  if (!listener.ok) throw new Error(`listener refused: ${listener.code}`);
  cleanups.push(() => listener.close());
  return listener;
}

async function post(listener: ControlRoomListener, body: unknown = {}, credential = "operator", method = "POST") {
  const response = await fetch(listener.origin + PATH, { method, headers: {
    "content-type": "application/json", origin: listener.origin, "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION, "x-moe-session-credential": credential,
  }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  const value: unknown = await response.json();
  return { status: response.status, body: value };
}

function object(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
}

async function bootstrap(h: Harness, payload: Readonly<Record<string, unknown>> = {}) {
  return handleAsyncCommandRequest(h.deps, command("bootstrap", "repository.bootstrap", {
    dir: join(h.temp, "product"), productName: "disclosure-product", profileVersion: CONTROLLED_PROFILE_VERSION,
    github: { owner: "disclosure-owner", name: "disclosure-product", visibility: "private" }, ...payload,
  }), "HTTP_LISTENER");
}

function seed(h: Harness, ordinal: number, resultBytes: Uint8Array) {
  const id = `bootstrap-seed-${ordinal}`, targetAggregateId = `${PROJECT}-bootstrap`;
  const result = h.store.commitExpectedVersionDecision({ commandKind: "repository.bootstrap",
    committedResultBytes: resultBytes, correlationId: `${id}-correlation`, decidedAt: NOW,
    events: [{ eventId: `${id}-receipt`, eventType: "RepositoryBootstrapped", payload: encoder.encode("{}") }],
    expectedVersion: h.store.getAggregateVersion(targetAggregateId),
    key: { commandId: id, principalId: OPERATOR, projectId: PROJECT },
    requestBytes: encoder.encode('{"kind":"repository.bootstrap","payload":{}}'), targetAggregateId });
  expect(result.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

const tokenPatterns = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /:\/\/[^/@\s"]+@/];
const throwGh: BootstrapGhPort = { create: async () => { throw new Error("injected gh failure"); } };

describe("repository bootstrap disclosure over HTTP", () => {
  it("A-D: discloses partial GitHub failure verbatim while preserving local success and git SHA", async () => {
    const h = harness(throwGh), listener = await start(h);
    expect(await bootstrap(h)).toMatchObject({ ok: true, outcome: "ACCEPTED" });
    const response = await post(listener);
    expect(response.status).toBe(200);
    const view = object(response.body), receipt = object(view["receipt"]);
    expect(view["outcome"]).toBe("BOOTSTRAP_READ");
    expect(receipt["githubRefusal"]).toStrictEqual({ code: "BOOTSTRAP_GH_UNAVAILABLE",
      detail: "GH_EXECUTION_FAILED", refusedBy: "DAEMON_INGRESS" });
    expect(receipt["outcome"]).toBe("BOOTSTRAPPED");
    expect(receipt["refusal"]).toBeNull();
    expect(receipt["dir"]).toBe(join(h.temp, "product"));
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: join(h.temp, "product"), encoding: "utf8", windowsHide: true }).trim();
    expect(receipt["sha"]).toBe(sha);
    for (const pattern of tokenPatterns) expect(pattern.test(JSON.stringify(response.body))).toBe(false);
  });

  it("B: preserves REMOTE_URL_REJECTED rather than hard-coding the thrown-port detail", async () => {
    const h = harness({ create: async () => ({ ok: true, remoteUrl: "https://user@github.com/owner/repo" }) });
    const listener = await start(h);
    expect(await bootstrap(h)).toMatchObject({ ok: true, outcome: "ACCEPTED" });
    const response = await post(listener);
    expect(object(object(response.body)["receipt"])["githubRefusal"]).toStrictEqual({
      code: "BOOTSTRAP_GH_UNAVAILABLE", detail: "REMOTE_URL_REJECTED", refusedBy: "DAEMON_INGRESS" });
    for (const pattern of tokenPatterns) expect(pattern.test(JSON.stringify(response.body))).toBe(false);
  });

  it("E: secret detection has a positive control for each shape", () => {
    const controls = ["ghp_" + "a".repeat(20), "github_pat_" + "b".repeat(20), "https://user@example.com"];
    expect(controls.length).toBe(tokenPatterns.length);
    tokenPatterns.forEach((pattern, index) => expect(pattern.test(controls[index] ?? "")).toBe(true));
  });

  it("E: withholds userinfo preserved inside a hard-refused directory", async () => {
    const h = harness(), listener = await start(h);
    expect(await bootstrap(h, { dir: "https://user@example.com/product", profileVersion: "unknown" }))
      .toMatchObject({ outcome: "PORT_REFUSED", stage: "DISPATCH",
        refusal: { code: "BOOTSTRAP_PROFILE_VERSION_UNKNOWN", layer: "DAEMON_INGRESS" } });
    const response = await post(listener);
    expect(tokenPatterns.some((pattern) => pattern.test(JSON.stringify(response.body)))).toBe(false);
    expect(response).toStrictEqual({ status: 200,
      body: { outcome: "BOOTSTRAP_READ", receipt: null, unreadable: true } });
  });

  it("F: production wiring supplies the optional bootstrap reader", () => {
    expect(typeof harness().wiring.repositoryWorkflows().readBootstrap).toBe("function");
  });

  it.each([
    ["no-capability", {}, "REPOSITORY_WORKFLOW_READ_CAPABILITY_DENIED"],
    ["foreign", {}, "REPOSITORY_WORKFLOW_READ_PROJECT_MISMATCH"],
    ["operator", { extra: true }, "REPOSITORY_BOOTSTRAP_READ_REQUEST_INVALID"],
    ["operator", [], "REPOSITORY_BOOTSTRAP_READ_REQUEST_INVALID"],
  ])("G: %s body %j answers %s at the workflow layer", async (credential, body, code) => {
    const response = await post(await start(harness()), body, String(credential));
    expect(response).toStrictEqual({ status: 200,
      body: { outcome: "REFUSED", code, layer: "REPOSITORY_WORKFLOW_READ" } });
  });

  it.each(["missing method", "missing port"])("G: %s refuses unavailable", async (mode) => {
    const h = harness(), port = h.wiring.repositoryWorkflows();
    const legacyPort = { boundProjectId: port.boundProjectId, readCriteria: port.readCriteria, readRecovery: port.readRecovery };
    const response = await post(await start(h, mode === "missing port" ? null : legacyPort));
    expect(response).toStrictEqual({ status: 200, body: { outcome: "REFUSED",
      code: "REPOSITORY_BOOTSTRAP_READ_UNAVAILABLE", layer: "REPOSITORY_WORKFLOW_READ" } });
  });

  it("rejects non-POST at the bootstrap workflow layer", async () => {
    expect(await post(await start(harness()), {}, "operator", "GET")).toStrictEqual({ status: 200,
      body: { outcome: "REFUSED", code: "REPOSITORY_BOOTSTRAP_READ_REQUEST_INVALID", layer: "REPOSITORY_WORKFLOW_READ" } });
  });

  it("H: distinguishes no committed bootstrap from an unreadable committed value", async () => {
    const h = harness(), listener = await start(h);
    expect(await post(listener, {}, "reader")).toStrictEqual({ status: 200,
      body: { outcome: "BOOTSTRAP_READ", receipt: null } });
    seed(h, 1, encoder.encode("{"));
    expect(await post(listener)).toStrictEqual({ status: 200,
      body: { outcome: "BOOTSTRAP_READ", receipt: null, unreadable: true } });
  });

  it("reads the latest committed receipt on the same listener", async () => {
    const h = harness(), listener = await start(h);
    const receipt = { version: "moe-bootstrap-receipt/1", decidedAt: NOW, dir: "first",
      outcome: "BOOTSTRAPPED", sha: "a".repeat(40), remoteUrl: null, refusal: null, githubRefusal: null };
    seed(h, 1, encoder.encode(JSON.stringify(receipt)));
    expect(object(object((await post(listener)).body)["receipt"])["dir"]).toBe("first");
    seed(h, 2, encoder.encode(JSON.stringify({ ...receipt, dir: "second", sha: "b".repeat(40) })));
    expect(object(object((await post(listener)).body)["receipt"])).toMatchObject({ dir: "second", sha: "b".repeat(40) });
  });

  it("discloses a hard refusal agreeing with the command's code and layer", async () => {
    const h = harness(), listener = await start(h);
    expect(await bootstrap(h, { profileVersion: "unknown" })).toMatchObject({ outcome: "PORT_REFUSED",
      stage: "DISPATCH", refusal: { code: "BOOTSTRAP_PROFILE_VERSION_UNKNOWN", layer: "DAEMON_INGRESS" } });
    expect(object(object((await post(listener)).body)["receipt"])).toMatchObject({ outcome: "REFUSED",
      sha: null, remoteUrl: null, refusal: { code: "BOOTSTRAP_PROFILE_VERSION_UNKNOWN",
        detail: "PROFILE_UNKNOWN", refusedBy: "DAEMON_INGRESS" } });
  });
});
