/**
 * THE COMPOSITION TEST: can the SHIPPED daemon actually answer `graph.get`?
 *
 * Every other suite in this directory injects a `GraphQueryPort` into the
 * listener or the dispatch port directly. That proves the handler works and
 * proves nothing about whether production wires it — and the difference is not
 * academic: `createStoreDependencies` built and returned a `graph` factory while
 * the module's frozen DEFAULT PROVIDER, which is the object `daemon-main` loads,
 * omitted it. Every injected-port test stayed green while a real authenticated
 * `POST /graph/get` answered `GRAPH_QUERY_UNAVAILABLE@GRAPH_QUERY`.
 *
 * So this file injects nothing. A child process imports the default provider by
 * the same specifier the CLI uses, hands it to the real `startDaemon`, and POSTs
 * the real route over a real socket. The store is a real file, seeded here by
 * the real reducer and the real body writer.
 *
 * THE DISCRIMINATOR IS THE CODE, NOT THE STATUS. On an EMPTY store the daemon
 * must answer the durable reader's own `ACTIVE_GRAPH_ABSENT` — proof the request
 * reached the projection — and never the handler's `GRAPH_QUERY_UNAVAILABLE`,
 * which is what an unwired port answers. Those two are both "ok: false", so any
 * assertion coarser than the exact code would have blessed the omission. On a
 * SEEDED store the answer is compared field by field against what
 * `readCurrentActiveGraph` returns for the same durable file in this process:
 * those values can only come from the projection folding this store's history.
 *
 * EACH CHILD ALSO SPOOFS, at no extra process cost. The second POST on the same
 * live daemon names another project, and the guard that refuses it is the
 * production one rather than a listener a test composed.
 *
 * A CHILD PROCESS, not a vitest import: the provider caches its environment in a
 * module-level singleton on first use, so the MOE_* variables have to be set
 * before the module is ever loaded. Under plain Node this also proves the
 * shipped module graph loads outside vitest's resolver.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { readCurrentActiveGraph } from "./active-graph-projection.js";
import type { ActiveGraphAccepted } from "./active-graph-projection.js";
import { PROJECT_ID, installBinding, seedActive } from "./graph-query-test-fixtures.js";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CREDENTIAL = "production-route-operator-credential";
const FOREIGN_PROJECT = "proj-somebody-else";

const CHILD_SOURCE = `
const report = (value) => { process.stdout.write(JSON.stringify(value)); };
try {
  const provider = (await import("./src/daemon-store-dependencies.ts")).default;
  const { startDaemon } = await import("./src/daemon-entry.ts");
  const { WIRE_PROTOCOL_VERSION } = await import("./src/http/http-contract.ts");
  const { request } = await import("node:http");

  // OWN CALLABLE KEY on the shipped object, checked before anything starts: a
  // provider that merely inherits or lazily grows one is not what the CLI loads.
  const graphFactoryKind = Object.hasOwn(provider, "graph") ? typeof provider.graph : "ABSENT";

  const started = await startDaemon({ dependencies: provider, host: "127.0.0.1", port: 0 });
  if (!started.ok) {
    report({ outcome: "START_REFUSED", code: started.code, graphFactoryKind });
  } else {
    const post = (body) => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const outgoing = request({
        headers: {
          "content-length": String(Buffer.byteLength(payload)),
          "content-type": "application/json",
          host: "127.0.0.1:" + started.port,
          origin: started.origin,
          "x-moe-csrf": started.csrfToken,
          "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
          "x-moe-session-credential": process.env.MOE_DAEMON_CREDENTIAL,
        },
        host: "127.0.0.1", method: "POST", path: "/graph/get",
        port: started.port, setHost: false,
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          status: response.statusCode,
        }));
      });
      outgoing.on("error", reject);
      outgoing.end(payload);
    });

    // The request that names no project, then the one that names somebody
    // else's — both against the same live daemon.
    let answers;
    try {
      const answer = await post({});
      const spoofed = await post({ projectId: process.env.MOE_FOREIGN_PROJECT });
      answers = { answer, spoofed };
    } finally {
      await started.shutdown();
    }
    report({ outcome: "ANSWERED", graphFactoryKind, ...answers });
  }
} catch (error) {
  report({ outcome: "FAILED", code: error?.code ?? "NO_CODE", message: String(error?.message) });
}
`;

interface ChildReply {
  readonly body: Record<string, unknown>;
  readonly status: number;
}

interface ChildAnswer {
  readonly answer?: ChildReply;
  readonly code?: string;
  readonly graphFactoryKind?: string;
  readonly message?: string;
  readonly outcome: string;
  readonly spoofed?: ChildReply;
}

async function driveProductionRoute(storePath: string): Promise<ChildAnswer> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", CHILD_SOURCE],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        MOE_DAEMON_CREDENTIAL: CREDENTIAL,
        MOE_FOREIGN_PROJECT: FOREIGN_PROJECT,
        MOE_PROJECT_ID: PROJECT_ID,
        MOE_STORE_PATH: storePath,
      },
      maxBuffer: 1_000_000,
      shell: false,
      timeout: 150_000,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as ChildAnswer;
}

/**
 * Prepares the durable file the child will serve from, then CLOSES it. Windows
 * keeps a SQLite file locked while a handle lives, and the child opens the same
 * path.
 */
function prepareStore(directory: string, seed: boolean): ActiveGraphAccepted | null {
  const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
  try {
    installBinding(store);
    if (!seed) return null;
    seedActive(store);
    const reader = readCurrentActiveGraph(store, PROJECT_ID);
    if (!reader.ok) throw new Error(`fixture did not reach ACTIVE: ${reader.code}`);
    return reader;
  } finally {
    store.close();
  }
}

/**
 * The same assertion on both probes: a request naming another project is refused
 * by THIS module, and the refusal is not the unavailable arm wearing a different
 * hat — so the spoof case cannot be satisfied by an unwired port.
 */
function expectSpoofRefused(spoofed: ChildReply | undefined): void {
  expect(spoofed?.status).toBe(200);
  expect(spoofed?.body["ok"]).toBe(false);
  expect(spoofed?.body["code"]).toBe("GRAPH_QUERY_PROJECT_MISMATCH");
  expect(spoofed?.body["layer"]).toBe("GRAPH_QUERY");
  expect(spoofed?.body["code"]).not.toBe("GRAPH_QUERY_UNAVAILABLE");
  expectNoGraphAuthority(spoofed?.body);
}

function expectNoGraphAuthority(body: Record<string, unknown> | undefined): void {
  expect(body?.["revisionId"]).toBeUndefined();
  expect(body?.["graphEpoch"]).toBeUndefined();
  expect(body?.["planHash"]).toBeUndefined();
  expect(body?.["provenance"]).toBeUndefined();
  expect(body?.["graphContentHash"]).toBeUndefined();
  expect(body?.["snapshotIdentity"]).toBeUndefined();
  expect(body?.["snapshot"]).toBeUndefined();
}

describe("the shipped daemon serves graph.get from its default provider", () => {
  it("reaches the durable reader on an empty store, not the unavailable arm",
    { timeout: 180_000 }, async () => {
      const directory = mkdtempSync(join(tmpdir(), "moe-graph-route-empty-"));
      try {
        prepareStore(directory, false);
        const answered = await driveProductionRoute(join(directory, "store.sqlite"));

        expect(answered.outcome, JSON.stringify(answered)).toBe("ANSWERED");
        // The omission this test exists to catch: a default provider without a
        // `graph` key still starts, still routes, and still answers.
        expect(answered.graphFactoryKind).toBe("function");
        const answer = answered.answer;
        expect(answer?.status).toBe(200);
        expect(answer?.body["ok"]).toBe(false);
        // THE DURABLE READER ANSWERED. `GRAPH_QUERY_UNAVAILABLE` here would mean
        // the request never left the handler, and `ACTIVE_GRAPH_ABSENT` can only
        // come from the projection folding this store's real history.
        expect(answer?.body["code"], JSON.stringify(answer?.body)).toBe("ACTIVE_GRAPH_ABSENT");
        expect(answer?.body["layer"]).toBe("ACTIVE_GRAPH_PROJECTION");
        expect(answer?.body["code"]).not.toBe("GRAPH_QUERY_UNAVAILABLE");
        expect(answer?.body["sourceCode"]).toBeNull();
        expect(answer?.body["sourceLayer"]).toBeNull();
        expectNoGraphAuthority(answer?.body);
        expectSpoofRefused(answered.spoofed);
      } finally {
        rmSync(directory, { force: true, maxRetries: 5, recursive: true });
      }
    });

  it("answers the seeded durable graph with both identities unequated",
    { timeout: 180_000 }, async () => {
      const directory = mkdtempSync(join(tmpdir(), "moe-graph-route-seeded-"));
      try {
        const reader = prepareStore(directory, true);
        if (reader === null) throw new Error("the seeded fixture returned no reader answer");
        const answered = await driveProductionRoute(join(directory, "store.sqlite"));

        expect(answered.outcome, JSON.stringify(answered)).toBe("ANSWERED");
        expect(answered.graphFactoryKind).toBe("function");
        const answer = answered.answer;
        expect(answer?.status).toBe(200);
        expect(answer?.body["ok"], JSON.stringify(answer?.body)).toBe(true);
        // Compared against the READER's own values, read from the same durable
        // file in this process. Hard-coded hex on both sides would agree with
        // itself no matter what the daemon returned.
        expect(answer?.body["revisionId"]).toBe(reader.revisionId);
        expect(answer?.body["graphEpoch"]).toBe(reader.graphEpoch);
        expect(answer?.body["planHash"]).toBe(reader.planHash);
        expect(answer?.body["provenance"]).toEqual(reader.provenance);
        expect(answer?.body["snapshot"]).toEqual(reader.snapshot);
        expect(answer?.body["graphContentHash"]).toBe(reader.graphContentHash);
        expect(answer?.body["snapshotIdentity"]).toBe(reader.snapshotIdentity);
        // dec-64b2391c survives the whole production path, socket included.
        expect(answer?.body["graphContentHash"]).not.toBe(answer?.body["snapshotIdentity"]);
        expectSpoofRefused(answered.spoofed);
      } finally {
        rmSync(directory, { force: true, maxRetries: 5, recursive: true });
      }
    });
});
