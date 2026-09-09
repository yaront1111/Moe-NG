import type { JsonObject } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";
import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import type { BootstrapRequest } from "../bootstrap/bootstrap-contracts.js";
import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { CommandHandler, HandlerContext } from "../bootstrap/bootstrap-ledger.js";
import { runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { closeStores, driveThrough, openStore, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { GOAL_HANDLERS } from "../goals/goal-services.js";
import { decodeDeployTarget, deployTargetAggregateId } from "./deploy-target-contracts.js";

const modulePath = "./deploy-target-command.js";
const candidate: unknown = await import(/* @vite-ignore */ modulePath).catch(() => null);
const KIND = "deployment.set_target", PROJECT = "target-command-test";
const stores: SqliteEventStore[] = [];
const encoder = new TextEncoder();
const target = { network: "product-net", sshTarget: "operator@host.example", url: "https://product.example" };
const payload: JsonObject = { environment: "preview", ...target };
afterEach(() => { for (const store of stores.splice(0)) store.close(); closeStores(); });

function handler(): CommandHandler {
  const value = candidate !== null && typeof candidate === "object"
    ? (candidate as Record<string, unknown>)["setDeployTarget"] : undefined;
  expect(typeof value).toBe("function");
  if (typeof value !== "function") throw new Error("setter export missing");
  return value as CommandHandler;
}

function open(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
  stores.push(store);
  return store;
}

function request(id: string, value: JsonObject = payload, expectedVersion = 0, projectId = PROJECT): BootstrapRequest {
  return { commandId: id, correlationId: "target-correlation", decidedAt: "2026-09-06T11:00:00.000Z",
    expectedVersion, kind: KIND, payload: value, principalId: "operator", projectId,
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION };
}

function context(store: SqliteEventStore, input: BootstrapRequest): HandlerContext {
  return { store, request: input, ledger: readDurableLedger(store, input.projectId) };
}

function targets(store: SqliteEventStore, projectId = PROJECT) {
  const prefix = `deploy-target:${projectId}:`;
  return [...readDurableLedger(store, projectId).aggregates]
    .filter(([id]) => id.startsWith(prefix)).map(([id, row]) => ({ id, target: decodeDeployTarget(row.result) }));
}

describe("deployment target handler", () => {
  it("writes one exact durable event and round-trips every target member synchronously", () => {
    const store = open(), input = request("remote");
    const outcome = handler()(context(store, input));
    expect(outcome).not.toBeInstanceOf(Promise);
    expect(outcome).toMatchObject({ ok: true, authority: "DURABLE_DECISION", disposition: "DECIDED" });
    expect(targets(store)).toStrictEqual([{ id: "deploy-target:target-command-test:preview", target }]);
    const events = store.readEvents(deployTargetAggregateId(PROJECT, "preview"));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("EnvironmentDeployTargetBound");
    const bytes = events[0]?.payload;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toStrictEqual(target);
    expect(readDurableLedger(store, PROJECT).decisionCount).toBe(1);
  });

  it("preserves explicit nulls for a local daemon without a public URL", () => {
    const store = open();
    expect(handler()(context(store, request("local", { ...payload, sshTarget: null, url: null })))).toMatchObject({ ok: true });
    expect(targets(store)[0]?.target).toStrictEqual({ network: "product-net", sshTarget: null, url: null });
  });

  it("replaces one environment binding rather than duplicating it", () => {
    const store = open();
    expect(handler()(context(store, request("first"))).ok).toBe(true);
    expect(handler()(context(store, request("second", { ...payload, network: "replacement" }, 1))).ok).toBe(true);
    expect(targets(store)).toHaveLength(1);
    expect(targets(store)[0]?.target).toStrictEqual({ ...target, network: "replacement" });
    expect(store.readEvents(deployTargetAggregateId(PROJECT, "preview"))).toHaveLength(2);
  });

  it("keeps two environments isolated and never overwrites the project aggregate", () => {
    const store = open();
    expect(handler()(context(store, request("preview"))).ok).toBe(true);
    expect(handler()(context(store, request("production", { ...payload, environment: "production", network: "production-net" }))).ok).toBe(true);
    expect(targets(store)).toStrictEqual([
      { id: "deploy-target:target-command-test:preview", target },
      { id: "deploy-target:target-command-test:production", target: { ...target, network: "production-net" } },
    ]);
    expect(stateOf(readDurableLedger(store, PROJECT), PROJECT)).toBeUndefined();
  });

  it("honors the caller fence and preserves the target on stale-version refusal", () => {
    const store = open();
    expect(handler()(context(store, request("first"))).ok).toBe(true);
    const result = handler()(context(store, request("stale", { ...payload, network: "stale-net" })));
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toMatchObject({ ok: false, code: "EXPECTED_VERSION_CONFLICT", refusedBy: "DURABLE_STORE" });
    expect(targets(store)[0]?.target).toStrictEqual(target);
    expect(store.readEvents(deployTargetAggregateId(PROJECT, "preview"))).toHaveLength(1);
  });

  it("replays through the production bootstrap pipeline without a second event", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const bytes = encoder.encode(JSON.stringify(request("replay", payload, 0, PROJECT_ID)));
    const handlers = { [KIND]: handler() };
    expect(runBootstrapCommand(store, bytes, handlers)).toMatchObject({ ok: true, disposition: "DECIDED" });
    expect(runBootstrapCommand(store, bytes, handlers)).toMatchObject({ ok: true, disposition: "REPLAYED" });
    expect(store.readEvents(deployTargetAggregateId(PROJECT_ID, "preview"))).toHaveLength(1);
  });
});

const hostile = [
  { label: "URL userinfo", field: "url", value: "https://user:password@product.example" },
  ...["network", "sshTarget"].flatMap((field) => [
    { label: `${field} whitespace`, field, value: "host name" },
    { label: `${field} shell metacharacter`, field, value: "host;whoami" },
    { label: `${field} newline`, field, value: "host\nname" },
    { label: `${field} trailing newline`, field, value: "host\n" },
    { label: `${field} trailing carriage return`, field, value: "host\r" },
    { label: `${field} trailing line separator`, field, value: "host\u2028" },
    { label: `${field} trailing paragraph separator`, field, value: "host\u2029" },
    { label: `${field} NUL`, field, value: "host\0name" },
  ]),
  { label: "invalid environment", field: "environment", value: "../production" },
  { label: "network leading option", field: "network", value: "--network" },
  { label: "ssh leading option", field: "sshTarget", value: "-oProxyCommand=x" },
];

describe("deployment target admission", () => {
  it.each(hostile)("refuses $label at ingress with no durable record", ({ field, value }) => {
    const store = open(), input = request("invalid", { ...payload, [field]: value });
    const result = handler()(context(store, input));
    // Fail value-free before any matcher could display a credential-bearing accepted decision.
    expect(result.ok).toBe(false);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toMatchObject({ code: "DEPLOY_TARGET_INVALID", refusedBy: "DAEMON_INGRESS" });
    expect(readDurableLedger(store, PROJECT).decisionCount).toBe(0);
    expect(targets(store)).toHaveLength(0);
    expect(store.getCommandDecision({ commandId: input.commandId, principalId: input.principalId, projectId: PROJECT })).toBeNull();
    expect(store.readEvents(deployTargetAggregateId(PROJECT, "preview"))).toHaveLength(0);
    expect(/:\/\/[^/@\s"]+@/u.test(JSON.stringify(result))).toBe(false);
  });

  it.each(["sshTarget", "url"])("requires the explicitly nullable %s field", (field) => {
    const store = open(), value: Record<string, JsonObject[string]> = { ...payload };
    delete value[field];
    expect(handler()(context(store, request("missing", value)))).toMatchObject({
      ok: false, code: "DEPLOY_TARGET_INVALID", refusedBy: "DAEMON_INGRESS",
    });
    expect(readDurableLedger(store, PROJECT).decisionCount).toBe(0);
  });

  it("uses a positive control for the credential detector", () => {
    expect(/:\/\/[^/@\s"]+@/u.test("https://" + "user:password" + "@product.example")).toBe(true);
    expect(hostile.length).toBe(20);
  });
});

describe("deployment target registration", () => {
  it("registers the same synchronous handler in the production GOAL table", () => {
    expect(GOAL_HANDLERS[KIND]).toBe(handler());
  });
});
