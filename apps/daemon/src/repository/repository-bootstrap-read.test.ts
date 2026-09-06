import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import type { BootstrapCode, BootstrapDetail, BootstrapReceiptV1 } from "./repository-bootstrap-contracts.js";
import { readBootstrapReceipt } from "./repository-bootstrap-read.js";
import type { BootstrapReceiptView } from "./repository-bootstrap-read.js";

const PROJECT = "bootstrap-read-test";
const NOW = "2026-09-05T12:00:00.000Z";
const encoder = new TextEncoder();
const stores: SqliteEventStore[] = [];
const absent = { outcome: "BOOTSTRAP_READ", receipt: null };
const unreadable = { ...absent, unreadable: true };
const refusal = { code: "BOOTSTRAP_GH_UNAVAILABLE", detail: "GH_EXECUTABLE_ABSENT", refusedBy: "DAEMON_INGRESS" };
const receiptKeys = ["decidedAt", "dir", "githubRefusal", "outcome", "refusal", "remoteUrl", "sha", "version"];

function open(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
  stores.push(store);
  return store;
}

function receipt(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { version: "moe-bootstrap-receipt/1", decidedAt: NOW, dir: "D:/product",
    outcome: "BOOTSTRAPPED", sha: "a".repeat(40), remoteUrl: null,
    refusal: null, githubRefusal: null, ...overrides };
}

function seed(store: SqliteEventStore, value: unknown, target = `${PROJECT}-bootstrap`): void {
  const version = store.getAggregateVersion(target);
  const commandId = `seed-${target}-${version}`;
  const written = store.commitExpectedVersionDecision({
    commandKind: "repository.bootstrap", correlationId: commandId, decidedAt: NOW,
    committedResultBytes: value instanceof Uint8Array ? value : encoder.encode(JSON.stringify(value)),
    events: [{ eventId: `${commandId}-event`, eventType: "RepositoryBootstrapped", payload: encoder.encode("{}") }],
    expectedVersion: version, key: { commandId, principalId: "operator", projectId: PROJECT },
    requestBytes: encoder.encode("{}"), targetAggregateId: target,
  });
  if (written.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error("fixture seed failed");
}

afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe("bootstrap receipt disclosure reader", () => {
  it("publishes the actual receipt reader", async () => {
    const path = "./repository-bootstrap-read.js";
    const module: unknown = await import(/* @vite-ignore */ path).catch(() => null);
    expect(module).toEqual(expect.objectContaining({ readBootstrapReceipt: expect.any(Function) }));
    expectTypeOf<BootstrapReceiptView>().toEqualTypeOf<BootstrapReceiptV1>();
  });

  it("distinguishes an absent aggregate from other project state", () => {
    const store = open();
    seed(store, receipt(), "other-project-bootstrap");
    expect(readBootstrapReceipt(store, PROJECT)).toEqual(absent);
    expect(Object.isFrozen(readBootstrapReceipt(store, PROJECT))).toBe(true);
  });

  it.each([
    {}, { remoteUrl: "https://github.com/Owner/product" }, { githubRefusal: refusal },
    { outcome: "REFUSED", sha: null, refusal, dir: "" },
    { outcome: "REFUSED", sha: null, refusal, githubRefusal: refusal, dir: "../product" },
    { sha: "b".repeat(64), decidedAt: "2026-09-05T12:00:00Z" },
  ])("copies a valid receipt without adding or dropping its declared facts (%j)", (overrides) => {
    const store = open();
    const value = receipt(overrides);
    seed(store, value);
    const view = readBootstrapReceipt(store, PROJECT);
    expect(view).toEqual({ outcome: "BOOTSTRAP_READ", receipt: value });
    expect(Object.keys(view.receipt ?? {}).sort()).toEqual(receiptKeys);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.receipt)).toBe(true);
    expect(view.receipt).not.toBe(value);
  });

  it("re-reads a newer decision through the same store and detaches nested refusals", () => {
    const store = open();
    seed(store, receipt());
    const first = readBootstrapReceipt(store, PROJECT);
    const secondValue = receipt({ githubRefusal: refusal, dir: "D:/new-product" });
    seed(store, secondValue);
    const second = readBootstrapReceipt(store, PROJECT);
    expect(second).toEqual({ outcome: "BOOTSTRAP_READ", receipt: secondValue });
    expect(first.receipt?.dir).toBe("D:/product");
    expect(second.receipt?.githubRefusal).not.toBe(refusal);
    expect(Object.isFrozen(second.receipt?.githubRefusal)).toBe(true);
    expect(Object.keys(second.receipt?.githubRefusal ?? {}).sort()).toEqual(["code", "detail", "refusedBy"]);
    expect(readBootstrapReceipt(store, PROJECT).receipt).not.toBe(second.receipt);
  });

  it.each([null, false, 7, "text", [], {}, encoder.encode("{")].map((value, index) => ({ value, index })))
    ("marks present malformed state unreadable ($index)", ({ value }) => {
    const store = open();
    seed(store, value);
    expect(readBootstrapReceipt(store, PROJECT)).toEqual(unreadable);
  });

  it("does not resurrect an older receipt after newer malformed bytes", () => {
    const store = open();
    seed(store, receipt());
    seed(store, encoder.encode("{"));
    expect(readBootstrapReceipt(store, PROJECT)).toEqual(unreadable);
  });

  it("returns only the unreadable marker when the real store is closed", () => {
    const store = open();
    stores.splice(stores.indexOf(store), 1);
    store.close();
    expect(readBootstrapReceipt(store, PROJECT)).toEqual(unreadable);
  });
});

const invalidFields: readonly [string, unknown][] = [
  ["version", "future"], ["version", null], ["outcome", "UNKNOWN"],
  ["sha", null], ["sha", "a".repeat(39)], ["sha", "a".repeat(41)], ["sha", "A".repeat(40)],
  ["sha", 1], ["sha", "a".repeat(65)], ["refusal", refusal],
  ["decidedAt", ""], ["decidedAt", "tomorrow"], ["decidedAt", "2026-02-30T12:00:00Z"],
  ["decidedAt", "2026-09-05T12:00:00Z\n"], ["decidedAt", "x".repeat(65)],
  ["dir", null], ["dir", "x".repeat(4097)], ["dir", "path\nother"], ["dir", "path\0other"],
  ["remoteUrl", "http://github.com/owner/name"], ["remoteUrl", "https://example.com/owner/name"],
  ["remoteUrl", "https://user@github.com/owner/name"], ["remoteUrl", "https://github.com:443/owner/name"],
  ["remoteUrl", "https://github.com/owner/name?query=1"], ["remoteUrl", "https://github.com/owner/name#fragment"],
  ["remoteUrl", "https://github.com/owner/name/"], ["remoteUrl", "https://github.com/owner/%6eame"],
  ["remoteUrl", " https://github.com/owner/name"], ["remoteUrl", "https://github.com/owner/name\n"],
  ["remoteUrl", "https://github.com/owner/name/../other"], ["remoteUrl", 1],
  ["githubRefusal", {}], ["githubRefusal", { ...refusal, code: "UNKNOWN" }],
  ["githubRefusal", { ...refusal, code: "toString" }],
  ["githubRefusal", { ...refusal, detail: "UNKNOWN" }],
  ["githubRefusal", { ...refusal, detail: "toString" }],
  ["githubRefusal", { ...refusal, refusedBy: "CORE_REDUCER" }],
  ["githubRefusal", { ...refusal, extra: true }],
];

describe("closed bootstrap receipt validation", () => {
  it.each(["dir-token", "dir-userinfo", "remote-token"])("withholds a credential-shaped declared field (%s)", (kind) => {
    const value = kind === "dir-userinfo" ? "https://user@example.com/product" : "ghp_" + "a".repeat(20);
    const fields = kind === "remote-token" ? { remoteUrl: `https://github.com/owner/${value}` } : { dir: value };
    const store = open();
    seed(store, receipt(fields));
    const view = readBootstrapReceipt(store, PROJECT);
    // Fail value-free: neither the synthetic marker nor a future real credential enters evidence.
    expect(view.receipt === null).toBe(true);
    expect(view).toEqual(unreadable);
  });

  it.each(invalidFields)("rejects invalid %s without forwarding input", (field, value) => {
    const store = open();
    seed(store, receipt({ [field]: value }));
    expect(readBootstrapReceipt(store, PROJECT)).toEqual(unreadable);
  });

  it.each(receiptKeys)("requires own field %s", (key) => {
    const store = open();
    const value = receipt();
    delete value[key];
    seed(store, value);
    expect(readBootstrapReceipt(store, PROJECT)).toEqual(unreadable);
  });

  it("rejects undeclared top-level fields", () => {
    const store = open();
    seed(store, receipt({ extra: true }));
    expect(readBootstrapReceipt(store, PROJECT)).toEqual(unreadable);
  });

  it.each([{ sha: "a".repeat(40), refusal }, { sha: null, refusal: null },
    { sha: null, refusal, remoteUrl: "https://github.com/owner/name" }])("enforces refused outcome null pairs (%j)", (fields) => {
    const store = open();
    seed(store, receipt({ outcome: "REFUSED", ...fields }));
    expect(readBootstrapReceipt(store, PROJECT)).toEqual(unreadable);
  });
});

const codes = ["BOOTSTRAP_PROFILE_VERSION_UNKNOWN", "BOOTSTRAP_PRODUCT_NAME_INVALID", "BOOTSTRAP_DIR_NOT_EMPTY",
  "BOOTSTRAP_GIT_UNAVAILABLE", "BOOTSTRAP_GH_UNAVAILABLE", "BOOTSTRAP_DIR_INVALID", "BOOTSTRAP_TREE_PATH_INVALID",
  "BOOTSTRAP_TREE_WRITE_FAILED", "BOOTSTRAP_PAYLOAD_INVALID", "BOOTSTRAP_BIND_FAILED", "BOOTSTRAP_CATALOG_FAILED",
  "MIGRATION_TOOL_MISSING"] as const;
const details = ["PROFILE_UNKNOWN", "PRODUCT_NAME_INVALID", "DIRECTORY_NOT_EMPTY", "DIRECTORY_INVALID", "TREE_PATH_INVALID",
  "TREE_WRITE_FAILED", "GIT_EXECUTABLE_UNAVAILABLE", "GIT_COMMAND_FAILED", "GIT_SHA_INVALID", "GH_EXECUTABLE_ABSENT",
  "GITHUB_REFUSED", "GH_EXECUTION_FAILED", "REMOTE_URL_REJECTED", "GITHUB_REQUEST_INVALID",
  "BIND_FAILED_LOCAL_REPOSITORY_RETAINED", "CATALOG_FAILED_LOCAL_REPOSITORY_RETAINED"] as const;

describe("complete closed diagnostic rosters", () => {
  it("pins both directions of the producer type unions", () => {
    expectTypeOf<(typeof codes)[number]>().toEqualTypeOf<BootstrapCode>();
    expectTypeOf<(typeof details)[number]>().toEqualTypeOf<BootstrapDetail>();
    expect(codes).toHaveLength(12);
    expect(details).toHaveLength(16);
  });

  it.each(codes)("admits the known code %s", (code) => {
    const store = open();
    const value = receipt({ githubRefusal: { ...refusal, code } });
    seed(store, value);
    expect(readBootstrapReceipt(store, PROJECT)).toEqual({ outcome: "BOOTSTRAP_READ", receipt: value });
  });

  it.each(details)("admits the known detail %s", (detail) => {
    const store = open();
    const value = receipt({ githubRefusal: { ...refusal, detail } });
    seed(store, value);
    expect(readBootstrapReceipt(store, PROJECT)).toEqual({ outcome: "BOOTSTRAP_READ", receipt: value });
  });
});
