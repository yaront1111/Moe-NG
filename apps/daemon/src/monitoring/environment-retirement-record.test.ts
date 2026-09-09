import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";
import { readDeployLedger, readDeployReceipt, recordDeployReceipt } from "../deployment/deploy-ledger.js";
import type { RecordDeployReceiptInput } from "../deployment/deploy-ledger.js";
import { HEALTH_PROBE_VERSION } from "./health-probe-contracts.js";
import { createHealthProbeRing } from "./health-probe-ring.js";
import { createEnvironmentRetirementRecord } from "./environment-retirement-record.js";

const PROJECT = "retirement-test";
const AGGREGATE = `environment-retirement/${PROJECT}`;
const AT = "2026-09-08T00:00:00.000Z";
const SHA = "a".repeat(40);
const REFUSAL = { code: "DEPLOY_TARGET_MISSING", layer: "DAEMON_DEPLOY_ENGINE", detail: "" } as const;
const refused = (code: string) => ({ ok: false, code, layer: "DAEMON_INGRESS" });
const factory = (store: SqliteEventStore) => createEnvironmentRetirementRecord({ store, projectId: PROJECT, now: () => 0 });

function withFixture(body: (fixture: ReturnType<typeof setup>) => void): void {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "moe-environment-retirement-"));
  const stores = new Set<SqliteEventStore>();
  try { body(setup(directory, stores)); }
  finally {
    for (const store of stores) store.close();
    if (dirname(resolve(directory)) !== temporaryRoot) throw new Error("unsafe retirement fixture cleanup");
    rmSync(directory, { force: true, recursive: true });
  }
}

function setup(directory: string, stores: Set<SqliteEventStore>) {
  const open = (projectId = PROJECT) => {
    const store = SqliteEventStore.openForProject(join(directory, `${projectId}.sqlite`), projectId);
    stores.add(store);
    return store;
  };
  const close = (store: SqliteEventStore) => { store.close(); stores.delete(store); };
  const store = open();
  return { store, open, close, ring: createHealthProbeRing(join(directory, "health.sqlite"), PROJECT) };
}

function deploy(store: SqliteEventStore, decisionId: string, extra: Partial<RecordDeployReceiptInput> = {}) {
  const result = recordDeployReceipt(store, { projectId: PROJECT, environment: "preview", decisionId,
    sha: SHA, imageDigest: `sha256:${"b".repeat(64)}`, refusal: null, releaseDecision: null,
    url: null, decidedAt: AT, ...extra });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.receipt;
}

function append(store: SqliteEventStore, payload: Uint8Array, eventType = "moe.environment.retired"): void {
  store.commit({ aggregateId: AGGREGATE, commandId: randomUUID(), commandBytes: payload,
    committedAt: AT, expectedVersion: store.getAggregateVersion(AGGREGATE),
    events: [{ eventId: randomUUID(), eventType, payload }] });
}

function intercept(store: SqliteEventStore, before: (method: PropertyKey) => void): SqliteEventStore {
  return new Proxy(store, { get(target, method) {
    const value: unknown = Reflect.get(target, method, target);
    return typeof value === "function" ? (...args: unknown[]) => {
      before(method);
      return Reflect.apply(value, target, args) as unknown;
    } : value;
  } });
}

function receiptBytes(store: SqliteEventStore, receiptId: string): Uint8Array {
  const result = readDeployReceipt(store, PROJECT, receiptId);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.decision.resultBytes;
}

it("defaults valid unset and unknown reads to false, without persisting a default", () => withFixture(({ store }) => {
  deploy(store, "first");
  const record = factory(store);
  expect(record.read("preview")).toEqual({ ok: true, value: false });
  expect(record.read("unknown")).toEqual({ ok: true, value: false });
  expect(record.stored()).toEqual({ ok: true, value: new Map() });
  expect(store.readEvents(AGGREGATE)).toEqual([]);
  expect(Object.isFrozen(record)).toBe(true);
  expect(Object.isFrozen(record.read("preview"))).toBe(true);
}));

it("replays retirement after restart without changing any receipt bytes or probe history", () => withFixture((f) => {
  const receipt = deploy(f.store, "first");
  const failed = deploy(f.store, "refused", { refusal: REFUSAL, imageDigest: null });
  const samples = [0, 1].map((latencyMs) => ({ version: HEALTH_PROBE_VERSION, environment: "preview",
    sha: SHA, status: "SUCCESS" as const, latencyMs, at: AT }));
  for (const sample of samples) expect(f.ring.append(sample).ok).toBe(true);
  const ledger = readDeployLedger(f.store, PROJECT);
  const ids = [receipt.receiptId, failed.receiptId];
  const bytes = ids.map((id) => receiptBytes(f.store, id));
  expect(factory(f.store).write("preview")).toEqual({ ok: true, value: true });
  const event = f.store.readEvents(AGGREGATE)[0];
  expect(event?.eventType).toBe("moe.environment.retired");
  expect(JSON.parse(new TextDecoder().decode(event?.payload))).toEqual({ version: 1,
    environment: "preview", retiredThroughReceiptId: receipt.receiptId });
  expect(event?.committedAt).toBe(new Date(0).toISOString());
  expect(readDeployLedger(f.store, PROJECT)).toEqual(ledger);
  expect(ids.map((id) => receiptBytes(f.store, id))).toEqual(bytes);
  expect(f.ring.read("preview")).toEqual({ ok: true, value: samples });
  f.close(f.store);
  const reopened = f.open();
  expect(factory(reopened).read("preview")).toEqual({ ok: true, value: true });
  expect(factory(reopened).stored()).toEqual({ ok: true, value: new Map([["preview", true]]) });
  expect(readDeployLedger(reopened, PROJECT)).toEqual(ledger);
  expect(ids.map((id) => receiptBytes(reopened, id))).toEqual(bytes);
  expect(f.ring.read("preview")).toEqual({ ok: true, value: samples });
}));

it("refreshes two instances, makes repeat writes idempotent, and isolates returned Maps", () => withFixture(({ store }) => {
  deploy(store, "first");
  const left = factory(store), right = factory(store);
  expect(right.read("preview")).toEqual({ ok: true, value: false });
  expect(left.write("preview")).toEqual({ ok: true, value: true });
  expect(right.read("preview")).toEqual({ ok: true, value: true });
  const snapshot = right.stored();
  if (!snapshot.ok) throw new Error(snapshot.code);
  (snapshot.value as Map<string, true>).clear();
  expect(left.stored()).toEqual({ ok: true, value: new Map([["preview", true]]) });
  expect(right.write("preview")).toEqual({ ok: true, value: true });
  expect(store.readEvents(AGGREGATE)).toHaveLength(1);
}));

it("isolates environments and projects", () => withFixture(({ store, open }) => {
  deploy(store, "first");
  deploy(store, "second", { environment: "production" });
  const other = open("other-project");
  deploy(other, "first", { projectId: "other-project" });
  expect(factory(store).write("preview")).toEqual({ ok: true, value: true });
  expect(factory(store).read("production")).toEqual({ ok: true, value: false });
  const record = createEnvironmentRetirementRecord({ store: other, projectId: "other-project" });
  expect(record.read("preview")).toEqual({ ok: true, value: false });
  expect(record.stored()).toEqual({ ok: true, value: new Map() });
  const before = Date.now();
  const written = record.write("preview");
  expect(written).toEqual({ ok: true, value: true });
  expect(Object.isFrozen(written)).toBe(true);
  const at = Date.parse(other.readEvents("environment-retirement/other-project")[0]?.committedAt ?? "");
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());
}));

it("reactivates only for a new successful receipt, including same-SHA redeploys", () => withFixture(({ store, close, open }) => {
  const first = deploy(store, "first");
  const record = factory(store);
  expect(record.write("preview")).toEqual({ ok: true, value: true });
  deploy(store, "failed", { refusal: REFUSAL, imageDigest: null });
  expect(record.read("preview")).toEqual({ ok: true, value: true });
  expect(record.stored()).toEqual({ ok: true, value: new Map([["preview", true]]) });
  expect(deploy(store, "first").receiptId).toBe(first.receiptId);
  expect(record.read("preview")).toEqual({ ok: true, value: true });
  const next = deploy(store, "next", { decidedAt: "2020-01-01T00:00:00.000Z" });
  expect(next.sha).toBe(first.sha);
  expect(next.receiptId).not.toBe(first.receiptId);
  expect(record.read("preview")).toEqual({ ok: true, value: false });
  expect(record.stored()).toEqual({ ok: true, value: new Map() });
  expect(record.write("preview")).toEqual({ ok: true, value: true });
  expect(store.readEvents(AGGREGATE)).toHaveLength(2);
  close(store);
  expect(factory(open()).read("preview")).toEqual({ ok: true, value: true });
}));

it("retires a refused-only environment with a null cutoff until its first success", () => withFixture(({ store }) => {
  deploy(store, "refused", { refusal: REFUSAL, imageDigest: null });
  expect(factory(store).write("preview")).toEqual({ ok: true, value: true });
  const event = store.readEvents(AGGREGATE)[0];
  expect(JSON.parse(new TextDecoder().decode(event?.payload))).toEqual({ version: 1,
    environment: "preview", retiredThroughReceiptId: null });
  expect(factory(store).read("preview")).toEqual({ ok: true, value: true });
  deploy(store, "first");
  expect(factory(store).read("preview")).toEqual({ ok: true, value: false });
  expect(factory(store).stored()).toEqual({ ok: true, value: new Map() });
}));

it.each(["", "Preview", "../preview", "with space", "a".repeat(64)])("rejects invalid name %s before IO", (name) => withFixture(({ store }) => {
  let calls = 0;
  const record = factory(intercept(store, () => { calls++; throw new Error("unretained IO failure"); }));
  expect(record.read(name)).toEqual(refused("ENVIRONMENT_RETIREMENT_ENVIRONMENT_INVALID"));
  expect(record.write(name)).toEqual(refused("ENVIRONMENT_RETIREMENT_ENVIRONMENT_INVALID"));
  expect(calls).toBe(0);
  expect(store.readEvents(AGGREGATE)).toEqual([]);
}));

it("refuses an unknown write without appending", () => withFixture(({ store }) => {
  expect(factory(store).write("unknown")).toEqual(refused("ENVIRONMENT_RETIREMENT_ENVIRONMENT_UNKNOWN"));
  expect(store.readEvents(AGGREGATE)).toEqual([]);
}));

it.each(["json", "utf8", "array", "null", "extra", "missing", "version", "name", "type", "reference", "cutoff-type", "refused", "other-env", "other-project", "unknown-env"])(
  "rejects malformed retirement %s rather than manufacturing state", (kind) => withFixture(({ store, open }) => {
    const success = deploy(store, "first");
    const failed = deploy(store, "failed", { refusal: REFUSAL, imageDigest: null });
    const other = deploy(store, "other", { environment: "production" });
    const foreign = deploy(open("other-project"), "first", { projectId: "other-project" });
    const value: Record<string, unknown> = { version: 1, environment: "preview", retiredThroughReceiptId: success.receiptId };
    if (kind === "extra") value.extra = true;
    if (kind === "missing") delete value.retiredThroughReceiptId;
    if (kind === "version") value.version = 2;
    if (kind === "name") value.environment = "Preview";
    if (kind === "reference") value.retiredThroughReceiptId = "missing";
    if (kind === "cutoff-type") value.retiredThroughReceiptId = 1;
    if (kind === "refused") value.retiredThroughReceiptId = failed.receiptId;
    if (kind === "other-env") value.retiredThroughReceiptId = other.receiptId;
    if (kind === "other-project") value.retiredThroughReceiptId = foreign.receiptId;
    if (kind === "unknown-env") { value.environment = "unknown"; value.retiredThroughReceiptId = null; }
    const payload = kind === "utf8" ? new Uint8Array([255]) : new TextEncoder().encode(
      kind === "json" ? "{" : JSON.stringify(kind === "array" ? [] : kind === "null" ? null : value));
    append(store, payload, kind === "type" ? "other.event" : "moe.environment.retired");
    const record = factory(store), expected = refused("ENVIRONMENT_RETIREMENT_RECORD_INVALID");
    expect(record.read("preview")).toEqual(expected);
    expect(record.stored()).toEqual(expected);
    expect(record.write("preview")).toEqual(expected);
    expect(store.readEvents(AGGREGATE)).toHaveLength(1);
  }),
);

it.each(["readEvents", "readCommandDecisionsAfter", "commit"])("reports %s failure without optimistic retirement", (method) => withFixture(({ store }) => {
  deploy(store, "first");
  let calls = 0;
  const record = factory(intercept(store, (key) => { if (key === method) { calls++; throw new Error("unretained failure"); } }));
  const expected = refused("ENVIRONMENT_RETIREMENT_STORE_FAILED");
  if (method !== "commit") { expect(record.read("preview")).toEqual(expected); expect(record.stored()).toEqual(expected); }
  expect(record.write("preview")).toEqual(expected);
  expect(calls).toBe(method === "commit" ? 1 : 3);
  expect(store.readEvents(AGGREGATE)).toEqual([]);
  expect(factory(store).read("preview")).toEqual({ ok: true, value: false });
}));

it.each([() => Number.NaN, () => { throw new Error("unretained clock failure"); }])("refuses clock failure", (now) => withFixture(({ store }) => {
  deploy(store, "first");
  let calls = 0;
  expect(createEnvironmentRetirementRecord({ store, projectId: PROJECT, now: () => { calls++; return now(); } }).write("preview"))
    .toEqual(refused("ENVIRONMENT_RETIREMENT_STORE_FAILED"));
  expect(calls).toBe(1);
  expect(store.readEvents(AGGREGATE)).toEqual([]);
}));

it("uses local replay version and refuses a concurrent retirement CAS conflict", () => withFixture(({ store }) => {
  deploy(store, "first");
  deploy(store, "second", { environment: "production" });
  let commits = 0;
  const racing = factory(intercept(store, (method) => {
    if (method === "commit") { commits++; expect(factory(store).write("production")).toEqual({ ok: true, value: true }); }
  }));
  expect(racing.write("preview")).toEqual(refused("ENVIRONMENT_RETIREMENT_STORE_FAILED"));
  expect(commits).toBe(1);
  expect(store.readEvents(AGGREGATE)).toHaveLength(1);
  expect(factory(store).stored()).toEqual({ ok: true, value: new Map([["production", true]]) });
}));

it("reads the deployment ledger once per operation", () => withFixture(({ store }) => {
  deploy(store, "first");
  let reads = 0;
  const record = factory(intercept(store, (method) => { if (method === "readCommandDecisionsAfter") reads++; }));
  expect(record.read("preview")).toEqual({ ok: true, value: false });
  expect(record.stored()).toEqual({ ok: true, value: new Map() });
  expect(record.write("preview")).toEqual({ ok: true, value: true });
  expect(reads).toBe(3);
}));

it("retires only the generation observed before a concurrent successful deployment", () => withFixture(({ store }) => {
  const first = deploy(store, "first");
  const record = factory(intercept(store, (method) => { if (method === "commit") deploy(store, "concurrent"); }));
  expect(record.write("preview")).toEqual({ ok: true, value: true });
  expect(factory(store).read("preview")).toEqual({ ok: true, value: false });
  const event = store.readEvents(AGGREGATE)[0];
  expect(JSON.parse(new TextDecoder().decode(event?.payload)).retiredThroughReceiptId).toBe(first.receiptId);
}));
