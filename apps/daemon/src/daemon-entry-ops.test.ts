import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { startDaemon } from "./daemon-entry.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http/http-test-fixtures.js";

const CSRF = "ops-entry-csrf";

async function post(
  started: { readonly origin: string; readonly port: number }, path: string, body: unknown = {},
): Promise<{ readonly body: unknown; readonly status: number }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        "content-length": Buffer.byteLength(payload), "content-type": "application/json",
        host: `127.0.0.1:${started.port}`, origin: started.origin,
        "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": GOOD_CREDENTIAL,
      },
      host: "127.0.0.1", method: "POST", path, port: started.port, setHost: false,
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

it("resolves and forwards the project-bound policy and health readers", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      health: () => ({
        boundProjectId: "proj-0001",
        readHealth: () => ({ code: "HEALTH_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" as const }),
      }),
      policy: () => ({
        boundProjectId: "proj-0001",
        readPolicy: () => ({ code: "POLICY_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" as const }),
      }),
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.GOAL]) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, "/policy/read")).toEqual({
      body: { code: "POLICY_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" }, status: 200,
    });
    expect(await post(started, "/health/read")).toEqual({
      body: { code: "HEALTH_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" }, status: 200,
    });
  } finally {
    await started.shutdown();
  }
});

it("refuses both routes as unavailable when the provider offers no readers", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.GOAL]) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, "/policy/read")).toMatchObject({ body: { code: "LISTENER_POLICY_UNAVAILABLE" }, status: 503 });
    expect(await post(started, "/health/read")).toMatchObject({ body: { code: "LISTENER_HEALTH_UNAVAILABLE" }, status: 503 });
  } finally {
    await started.shutdown();
  }
});

it("resolves and forwards the project-bound activity and sessions readers", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      activity: () => ({
        boundProjectId: "proj-0001",
        readActivity: () => ({ code: "ACTIVITY_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" as const }),
      }),
      goalSource: () => ({ read: () => ({ code: "GOAL_SOURCE_INVALID", layer: "TEST_READER", ok: false as const }) }),
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.GOAL]) }),
      sessions: () => ({
        boundProjectId: "proj-0001",
        readSessions: () => ({ code: "SESSIONS_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" as const }),
      }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, "/activity/read")).toEqual({
      body: { code: "ACTIVITY_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" }, status: 200,
    });
    expect(await post(started, "/sessions/read")).toEqual({
      body: { code: "SESSIONS_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" }, status: 200,
    });
    expect(await post(started, "/goals/source/read", { goalRef: "goal-1" })).toEqual({
      body: { code: "GOAL_SOURCE_INVALID", layer: "TEST_READER", outcome: "REFUSED" }, status: 200,
    });
  } finally {
    await started.shutdown();
  }
});
