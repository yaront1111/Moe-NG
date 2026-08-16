import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { startDaemon } from "./daemon-entry.js";
import type { DaemonDependencyProvider } from "./daemon-entry.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";

const CSRF = "dossier-csrf";
const SERVICE_REFUSAL = Object.freeze({
  advisoryOnly: true, authority: "NONE", code: "DOCUMENT_WORK_DOSSIER_MISSING",
  layer: "DAEMON_READ_MODEL", ok: false, outcome: "REFUSED",
} as const);

async function readDossier(endpoint: {
  readonly origin: string; readonly port: number;
}): Promise<{ readonly body: unknown; readonly status: number }> {
  const payload = "{}";
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        "content-length": Buffer.byteLength(payload), "content-type": "application/json",
        host: `127.0.0.1:${endpoint.port}`, origin: endpoint.origin,
        "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": "sess-good",
      },
      host: "127.0.0.1", method: "POST", path: "/documents/dossier/read",
      port: endpoint.port, setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

it("resolves the optional dossier factory through the daemon entry point", async () => {
  const projects: string[] = [];
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      documentDossiers: () => ({ readLatest: (projectId: string) => {
        projects.push(projectId); return SERVICE_REFUSAL;
      } }),
      provide: fixtureDependencies,
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await readDossier(started)).toStrictEqual({ body: SERVICE_REFUSAL, status: 200 });
    expect(projects).toStrictEqual(["proj-0001"]);
  } finally {
    await started.shutdown();
  }
});

it("refuses a malformed optional dossier port before binding", async () => {
  const result = await startDaemon({
    dependencies: {
      documentDossiers: () => ({}), provide: fixtureDependencies,
    } as unknown as DaemonDependencyProvider,
  });
  if (result.ok) await result.shutdown();
  expect(result).toStrictEqual({
    code: "DAEMON_ENTRY_DEPENDENCIES_INVALID", layer: "DAEMON_ENTRY", ok: false,
  });
});

it("keeps a non-callable optional factory as DEPENDENCIES_INVALID", async () => {
  expect(await startDaemon({ dependencies: {
    documentDossiers: 7, provide: fixtureDependencies,
  } as unknown as DaemonDependencyProvider })).toStrictEqual({
    code: "DAEMON_ENTRY_DEPENDENCIES_INVALID", layer: "DAEMON_ENTRY", ok: false,
  });
});

it.each(["affordances", "documentDossiers", "subscriptions"] as const)(
  "preserves PROVIDER_THREW when the optional %s factory throws",
  async (factory) => {
    const result = await startDaemon({ dependencies: {
      [factory]: (): never => { throw new Error("optional factory exploded"); },
      provide: fixtureDependencies,
    } as DaemonDependencyProvider });
    expect(result).toStrictEqual({
      code: "DAEMON_ENTRY_PROVIDER_THREW", layer: "DAEMON_ENTRY", ok: false,
    });
  },
);

it("preserves PROVIDER_THREW when an optional factory accessor throws", async () => {
  const provider = new Proxy({ provide: fixtureDependencies }, {
    get: (target, property, receiver): unknown => {
      if (property === "documentDossiers") throw new Error("optional accessor exploded");
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as DaemonDependencyProvider;
  expect(await startDaemon({ dependencies: provider })).toStrictEqual({
    code: "DAEMON_ENTRY_PROVIDER_THREW", layer: "DAEMON_ENTRY", ok: false,
  });
});

it("keeps a throwing port-method accessor as DEPENDENCIES_INVALID", async () => {
  const hostilePort = new Proxy({}, {
    get: (): never => { throw new Error("port method accessor exploded"); },
  });
  expect(await startDaemon({ dependencies: {
    provide: fixtureDependencies,
    subscriptions: () => hostilePort as never,
  } })).toStrictEqual({
    code: "DAEMON_ENTRY_DEPENDENCIES_INVALID", layer: "DAEMON_ENTRY", ok: false,
  });
});

it("preserves optional-port order and stops at the first malformed port", async () => {
  const calls: string[] = [];
  const result = await startDaemon({ dependencies: {
    affordances: () => { calls.push("affordances"); return {} as never; },
    documentDossiers: () => { calls.push("documentDossiers"); return {} as never; },
    provide: fixtureDependencies,
    subscriptions: () => { calls.push("subscriptions"); return {} as never; },
  } });
  expect(result).toStrictEqual({
    code: "DAEMON_ENTRY_DEPENDENCIES_INVALID", layer: "DAEMON_ENTRY", ok: false,
  });
  expect(calls).toStrictEqual(["subscriptions"]);
});

it("resolves dossier after the two existing optional factories", async () => {
  const calls: string[] = [];
  const started = await startDaemon({ dependencies: {
    affordances: () => { calls.push("affordances"); return { readSurface: () => ({}) } as never; },
    documentDossiers: () => {
      calls.push("documentDossiers"); return { readLatest: () => SERVICE_REFUSAL };
    },
    provide: fixtureDependencies,
    subscriptions: () => {
      calls.push("subscriptions");
      return { acknowledge: () => ({}), readPage: () => ({}), reseat: () => ({}) } as never;
    },
  } });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  await started.shutdown();
  expect(calls).toStrictEqual(["subscriptions", "affordances", "documentDossiers"]);
});
