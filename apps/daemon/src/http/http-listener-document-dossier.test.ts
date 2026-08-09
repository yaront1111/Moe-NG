import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { startDaemon } from "../daemon-entry.js";
import type { DaemonDependencyProvider } from "../daemon-entry.js";
import { fixtureDependencies } from "../daemon-entry-fixtures.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener, StartListenerOptions } from "./http-listener.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { AuthenticationResult, CommandAdapterDeps } from "./http-contract.js";

const CSRF = "dossier-csrf";
const CREDENTIAL = "dossier-session";
const PROJECT = "project-from-authentication";

const SERVICE_REFUSAL = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  code: "DOCUMENT_WORK_DOSSIER_MISSING",
  layer: "DAEMON_READ_MODEL",
  ok: false,
  outcome: "REFUSED",
} as const);

interface Harness {
  readonly authCalls: { count: number };
  readonly decisionCalls: { count: number };
  readonly portCalls: string[];
  readonly registryCalls: { count: number };
  readonly listener: ControlRoomListener;
}

function authentication(credential: string | null): AuthenticationResult {
  if (credential !== CREDENTIAL) return { verdict: "UNAUTHENTICATED" };
  return {
    principal: { capabilities: [], principalId: "session-dossier", projectId: PROJECT },
    verdict: "AUTHENTICATED",
  };
}

async function start(options: {
  readonly withPort?: boolean;
} = {}): Promise<Harness> {
  const authCalls = { count: 0 };
  const decisionCalls = { count: 0 };
  const registryCalls = { count: 0 };
  const portCalls: string[] = [];
  const deps: CommandAdapterDeps = {
    authenticator: {
      authenticate: (credential) => {
        authCalls.count += 1;
        return authentication(credential);
      },
    },
    decisions: {
      decide: (): never => {
        decisionCalls.count += 1;
        throw new Error("dossier read must not enter the decision port");
      },
    },
    registry: {
      get: (): never => {
        registryCalls.count += 1;
        throw new Error("dossier read must not enter the command registry");
      },
    } as unknown as CommandAdapterDeps["registry"],
  };
  const candidate = await startControlRoomListener({
    csrfToken: CSRF,
    deps,
    ...(options.withPort === false ? {} : {
      documentDossiers: {
        readLatest: (projectId: string) => {
          portCalls.push(projectId);
          return SERVICE_REFUSAL;
        },
      },
    }),
  } as StartListenerOptions);
  if (!candidate.ok) throw new Error(`listener failed: ${candidate.code}`);
  return { authCalls, decisionCalls, listener: candidate, portCalls, registryCalls };
}

interface Reply {
  readonly body: Record<string, unknown>;
  readonly status: number;
}

interface Endpoint {
  readonly origin: string;
  readonly port: number;
}

async function send(
  listener: Endpoint,
  options: {
    readonly body?: Buffer | string;
    readonly credential?: string | null;
    readonly method?: string;
    readonly path?: string;
    readonly protocol?: string;
  } = {},
): Promise<Reply> {
  const payload = options.body ?? "{}";
  const headers: Record<string, string | number> = {
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json",
    host: `127.0.0.1:${listener.port}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": options.protocol ?? WIRE_PROTOCOL_VERSION,
  };
  if (options.credential !== null) {
    headers["x-moe-session-credential"] = options.credential ?? CREDENTIAL;
  }
  return await new Promise<Reply>((resolve, reject) => {
    const request = httpRequest({
      headers,
      host: "127.0.0.1",
      method: options.method ?? "POST",
      path: options.path ?? "/documents/dossier/read",
      port: listener.port,
      setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

it("reads the dossier for the authenticated project and forwards its refusal at HTTP 200", async () => {
  const harness = await start();
  try {
    const reply = await send(harness.listener);
    expect(reply).toStrictEqual({ body: SERVICE_REFUSAL, status: 200 });
    expect(harness.portCalls).toStrictEqual([PROJECT]);
    expect(harness.authCalls.count).toBe(1);
    expect(harness.decisionCalls.count).toBe(0);
    expect(harness.registryCalls.count).toBe(0);
  } finally {
    await harness.listener.close();
  }
});

it.each([null, "wrong-credential", "stale-session"])(
  "authenticates %s before decoding hostile bytes and never calls the read port",
  async (credential) => {
    const harness = await start();
    try {
      const reply = await send(harness.listener, {
        body: Buffer.from([0x7b, 0xff, 0xfe]),
        credential,
      });
      expect(reply.status).toBe(401);
      expect(reply.body).toMatchObject({
        error: { code: "AUTHENTICATION_FAILED" },
        ok: false,
        outcome: "REFUSED",
        stage: "AUTHENTICATE",
      });
      expect(harness.portCalls).toStrictEqual([]);
    } finally {
      await harness.listener.close();
    }
  },
);

it("checks protocol compatibility before decoding the body", async () => {
  const harness = await start();
  try {
    const reply = await send(harness.listener, {
      body: Buffer.from([0x7b, 0xff, 0xfe]),
      protocol: "wrong-protocol",
    });
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({
      error: { code: "DISTRIBUTION_MISMATCH" },
      ok: false,
      outcome: "REFUSED",
      stage: "COMPATIBILITY",
    });
    expect(harness.portCalls).toStrictEqual([]);
  } finally {
    await harness.listener.close();
  }
});

it.each(["{", "[]", "null", '{"extra":true}', '{"projectId":"attacker"}'])(
  "refuses non-empty or malformed dossier request %s without calling the port",
  async (body) => {
    const harness = await start();
    try {
      const reply = await send(harness.listener, { body });
      expect(reply).toStrictEqual({
        body: {
          code: "LISTENER_DOCUMENT_DOSSIER_REQUEST_INVALID",
          layer: "CONTROL_ROOM_LISTENER",
        },
        status: 400,
      });
      expect(harness.portCalls).toStrictEqual([]);
    } finally {
      await harness.listener.close();
    }
  },
);

it("does not let a query-string project replace the authenticated project", async () => {
  const harness = await start();
  try {
    const reply = await send(harness.listener, {
      path: "/documents/dossier/read?projectId=attacker",
    });
    expect(reply.status).toBe(200);
    expect(harness.portCalls).toStrictEqual([PROJECT]);
  } finally {
    await harness.listener.close();
  }
});

it("refuses an absent dossier port only after successful authentication", async () => {
  const harness = await start({ withPort: false });
  try {
    const absent = await send(harness.listener);
    expect(absent).toStrictEqual({
      body: {
        code: "LISTENER_DOCUMENT_DOSSIER_UNAVAILABLE",
        layer: "CONTROL_ROOM_LISTENER",
      },
      status: 503,
    });
    const unauthenticated = await send(harness.listener, { credential: null });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toMatchObject({ stage: "AUTHENTICATE" });
  } finally {
    await harness.listener.close();
  }
});

it("accepts the dossier route only as POST", async () => {
  const harness = await start();
  try {
    expect(await send(harness.listener, { method: "GET" })).toStrictEqual({
      body: {
        code: "LISTENER_DOCUMENT_DOSSIER_REQUEST_INVALID",
        layer: "CONTROL_ROOM_LISTENER",
      },
      status: 400,
    });
    expect(harness.authCalls.count).toBe(0);
    expect(harness.portCalls).toStrictEqual([]);
  } finally {
    await harness.listener.close();
  }
});

it("resolves the optional dossier factory through the daemon entry point", async () => {
  const projects: string[] = [];
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      documentDossiers: () => ({
        readLatest: (projectId: string) => {
          projects.push(projectId);
          return SERVICE_REFUSAL;
        },
      }),
      provide: fixtureDependencies,
    } as DaemonDependencyProvider,
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await send(started, { credential: "sess-good" })).toStrictEqual({
      body: SERVICE_REFUSAL,
      status: 200,
    });
    expect(projects).toStrictEqual(["proj-0001"]);
  } finally {
    await started.shutdown();
  }
});

it("refuses a malformed optional dossier port before binding", async () => {
  const result = await startDaemon({
    dependencies: {
      documentDossiers: () => ({}),
      provide: fixtureDependencies,
    } as unknown as DaemonDependencyProvider,
  });
  if (result.ok) await result.shutdown();
  expect(result).toStrictEqual({
    code: "DAEMON_ENTRY_DEPENDENCIES_INVALID",
    layer: "DAEMON_ENTRY",
    ok: false,
  });
});

it.each(["affordances", "documentDossiers", "subscriptions"] as const)(
  "preserves PROVIDER_THREW when the optional %s factory throws",
  async (factory) => {
    const result = await startDaemon({
      dependencies: {
        [factory]: (): never => { throw new Error("optional factory exploded"); },
        provide: fixtureDependencies,
      } as DaemonDependencyProvider,
    });
    expect(result).toStrictEqual({
      code: "DAEMON_ENTRY_PROVIDER_THREW",
      layer: "DAEMON_ENTRY",
      ok: false,
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
    code: "DAEMON_ENTRY_PROVIDER_THREW",
    layer: "DAEMON_ENTRY",
    ok: false,
  });
});
