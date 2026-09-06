import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { isDependencyProvider, startDaemon } from "./daemon-entry.js";
import type { DaemonDependencyProvider, StartedDaemon } from "./daemon-entry.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { recordPreviewReceipt } from "./preview/preview-ledger.js";
import { previewCaptureDirectory } from "./preview/preview-receipt-contracts.js";

const PROJECT = "project-preview-entry";
const GOAL = "goal-preview-entry";
const SHA = "a".repeat(40);
const CSRF = "preview-entry-csrf";
const CREDENTIAL = "preview-entry-operator";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
const CAPTURE_PATH = `/preview/capture/${GOAL}/${SHA}/journey-home.png`;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function world() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "moe-entry-preview-")));
  directories.push(directory);
  // Product captures and the store deliberately live in different directories.
  const workspace = join(directory, "product");
  const storePath = join(directory, "store.db");
  const relativePath = `${previewCaptureDirectory(GOAL, SHA)}/journey-home.png`;
  mkdirSync(dirname(join(workspace, relativePath)), { recursive: true });
  writeFileSync(join(workspace, relativePath), PNG);
  const store = SqliteEventStore.openForProject(storePath, PROJECT);
  installTestRecoveryBinding(store);
  const result = recordPreviewReceipt(store, { projectId: PROJECT, goalId: GOAL, sha: SHA,
    code: null, decidedAt: "2026-09-06T12:00:00.000Z", pid: 1234, url: "http://127.0.0.1:4173",
    screenshots: [{ journeyRef: "journey-home", path: relativePath }] });
  store.close();
  if (!result.ok) throw new Error(result.code);
  return { directory, workspace, storePath, receiptId: result.receipt.receiptId, relativePath };
}

function call(started: StartedDaemon, path: string, method = "POST", credential = CREDENTIAL) {
  const payload = method === "POST" ? JSON.stringify({ goalId: GOAL }) : "";
  return new Promise<{ status: number; bytes: Buffer }>((resolveReply, reject) => {
    const outbound = httpRequest({ host: "127.0.0.1", port: started.port, method, path, setHost: false,
      headers: { host: `127.0.0.1:${started.port}`, origin: started.origin,
        "content-type": "application/json", "content-length": Buffer.byteLength(payload),
        "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": credential } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolveReply({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
    });
    outbound.on("error", reject); outbound.end(payload);
  });
}

it("serves durable preview receipts and product capture bytes through real daemon production startup", async () => {
  const fixture = world();
  const composed = createStoreDependencies({ projectId: PROJECT, principalId: "operator-local",
    credential: CREDENTIAL, storePath: fixture.storePath, repositoryWorkspace: fixture.workspace });
  const started = await startDaemon({ csrfToken: CSRF, dependencies: composed });
  try {
    if (!started.ok) throw new Error(started.code);
    const read = await call(started, "/preview/read");
    expect(read.status).toBe(200);
    expect(JSON.parse(read.bytes.toString("utf8"))).toMatchObject({ kind: "PRESENT", preview: {
      goalId: GOAL, sha: SHA, receiptId: fixture.receiptId,
      screenshots: [{ journeyRef: "journey-home", path: fixture.relativePath }] } });
    const capture = await call(started, CAPTURE_PATH, "GET");
    expect(capture.status).toBe(200); expect(capture.bytes).toEqual(PNG);
    for (const [path, method] of [["/preview/read", "POST"], [CAPTURE_PATH, "GET"]] as const) {
      const refused = await call(started, path, method, "invalid-session");
      expect(refused.status).toBe(401);
      expect(refused.bytes.equals(PNG)).toBe(false);
    }
  } finally { if (started.ok) await started.shutdown(); composed.close(); }
});

it.each([null, ""])("keeps captures unavailable when the bound workspace is %s", async (workspace) => {
  const fixture = world();
  const composed = createStoreDependencies({ projectId: PROJECT, principalId: "operator-local",
    credential: CREDENTIAL, storePath: fixture.storePath, repositoryWorkspace: workspace });
  const started = await startDaemon({ csrfToken: CSRF, dependencies: composed });
  try {
    if (!started.ok) throw new Error(started.code);
    const read = await call(started, "/preview/read");
    expect(read.status).toBe(200);
    expect(JSON.parse(read.bytes.toString("utf8"))).toMatchObject({ kind: "PRESENT" });
    const capture = await call(started, CAPTURE_PATH, "GET");
    expect(capture.status).toBe(503);
    expect(JSON.parse(capture.bytes.toString("utf8"))).toMatchObject({ code: "LISTENER_PREVIEW_UNAVAILABLE" });
  } finally { if (started.ok) await started.shutdown(); composed.close(); }
});

it.each(["previewReads", "previewCaptures"])("validates the %s factory and its resolved port", async (name) => {
  const base = { provide: fixtureDependencies };
  const port = name === "previewReads" ? { read: () => ({ kind: "ABSENT", goalId: GOAL }) }
    : { projectDirectory: () => "/bound-product" };
  expect(isDependencyProvider({ ...base, [name]: () => port })).toBe(true);
  expect(isDependencyProvider({ ...base, [name]: port })).toBe(false);
  for (const [factory, code] of [[() => ({}), "DAEMON_ENTRY_DEPENDENCIES_INVALID"],
    [() => { throw new Error("reader unavailable"); }, "DAEMON_ENTRY_PROVIDER_THREW"]] as const) {
    const started = await startDaemon({ dependencies: { ...base, [name]: factory } as DaemonDependencyProvider });
    if (started.ok) await started.shutdown();
    expect(started).toMatchObject({ ok: false, code });
  }
});

// A child Node process follows the shipped .js bridges and the cached from-env facade.
const CHILD_SOURCE = String.raw`
const provider = (await import("./src/daemon-store-dependencies.ts")).default;
const { startDaemon } = await import("./src/daemon-entry.js");
const { WIRE_PROTOCOL_VERSION } = await import("./src/http/http-contract.js");
const csrfToken = "preview-entry-csrf";
const started = await startDaemon({ csrfToken, dependencies: provider });
if (!started.ok) throw new Error(started.code);
try {
  const headers = { origin: started.origin, "x-moe-csrf": csrfToken,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
    "x-moe-session-credential": process.env.MOE_DAEMON_CREDENTIAL };
  const read = await fetch(started.origin + "/preview/read", { method: "POST", headers: {
    ...headers, "content-type": "application/json" }, body: JSON.stringify({ goalId: "goal-preview-entry" }) });
  const capture = await fetch(started.origin + "/preview/capture/goal-preview-entry/"
    + "a".repeat(40) + "/journey-home.png", { headers });
  process.stdout.write(JSON.stringify({ readStatus: read.status, read: await read.json(),
    captureStatus: capture.status, capture: Buffer.from(await capture.arrayBuffer()).toString("base64") }));
} finally { await started.shutdown(); }
`;

it("forwards preview reads through the shipped default provider and physical Node bridges", async () => {
  const fixture = world();
  const result = await promisify(execFile)(process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", CHILD_SOURCE], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."), shell: false, windowsHide: true,
      env: { ...process.env, MOE_STORE_PATH: fixture.storePath, MOE_PROJECT_ID: PROJECT,
        MOE_DAEMON_CREDENTIAL: CREDENTIAL, MOE_NODE_WORKSPACE: fixture.workspace }, timeout: 30_000,
    });
  expect(JSON.parse(result.stdout)).toMatchObject({ readStatus: 200, read: { kind: "PRESENT",
    preview: { goalId: GOAL, receiptId: fixture.receiptId } }, captureStatus: 200, capture: PNG.toString("base64") });
}, 40_000);
