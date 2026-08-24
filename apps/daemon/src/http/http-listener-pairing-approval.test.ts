import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { CommandAdapterDeps } from "./http-contract.js";
import {
  PAIRING_CLAIM_PATH,
  PAIRING_REQUEST_PATH,
} from "./pairing-approval-handshake.js";
import { PAIRING_APPROVAL_LAYER } from "./pairing-approval-window.js";
import {
  CONTROL_ROOM_LISTENER_LAYER,
  startControlRoomListener,
} from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import {
  CAPABILITY,
  authenticator,
  decisionPort,
  recordingHandler,
  registryOf,
} from "./http-test-fixtures.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";

const CSRF = "pairing-approval-csrf";
const CREDENTIAL = "credential-returned-only-to-the-winning-claim";
const PROJECT_ID = "project-pairing-approval";

function deps(): CommandAdapterDeps {
  return {
    authenticator: authenticator([CAPABILITY]),
    decisions: decisionPort(),
    registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
  };
}

function pairing(mintCalls: { value: number }): SessionHandshakePort {
  return Object.freeze({
    boundProjectId: PROJECT_ID,
    mint: () => {
      mintCalls.value += 1;
      return Object.freeze({
        capabilities: Object.freeze(["project.admin"]),
        credential: CREDENTIAL,
        expiresAt: "2026-08-25T00:00:00.000Z",
        ok: true as const,
      });
    },
  });
}

interface Reply {
  readonly body: Record<string, unknown>;
  readonly cacheControl: string | undefined;
  readonly status: number;
}

interface RequestOverrides {
  readonly csrf?: string | null;
  readonly host?: string;
  readonly method?: string;
  readonly origin?: string | null;
  readonly protocolVersion?: string | null;
}

async function post(
  listener: ControlRoomListener,
  path: string,
  body: unknown,
  overrides: RequestOverrides = {},
): Promise<Reply> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-length": String(Buffer.byteLength(payload)),
    "content-type": "application/json",
    host: overrides.host ?? `127.0.0.1:${listener.port}`,
  };
  if (overrides.origin !== null) headers.origin = overrides.origin ?? listener.origin;
  if (overrides.csrf !== null) headers["x-moe-csrf"] = overrides.csrf ?? CSRF;
  if (overrides.protocolVersion !== null) {
    headers["x-moe-protocol-version"] = overrides.protocolVersion ?? WIRE_PROTOCOL_VERSION;
  }
  return await new Promise<Reply>((resolve, reject) => {
    const request = httpRequest({
      headers,
      host: "127.0.0.1",
      method: overrides.method ?? "POST",
      path,
      port: listener.port,
      setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
          cacheControl: typeof response.headers["cache-control"] === "string"
            ? response.headers["cache-control"]
            : undefined,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

async function started(log: string[], mintCalls: { value: number }): Promise<ControlRoomListener> {
  const result = await startControlRoomListener({
    csrfToken: CSRF,
    deps: deps(),
    log: (line) => log.push(line),
    pairing: pairing(mintCalls),
  });
  if (!result.ok) throw new Error(`listener refused: ${result.code}`);
  return result;
}

it("pairs from a plain unhosted origin only after in-process operator approval", async () => {
  const log: string[] = [];
  const mintCalls = { value: 0 };
  const listener = await started(log, mintCalls);
  try {
    const requested = await post(listener, PAIRING_REQUEST_PATH, {});
    expect(requested.status).toBe(200);
    expect(requested.cacheControl).toBe("no-store");
    expect(requested.body).toMatchObject({ ok: true });
    expect(requested.body["requestId"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(requested.body["confirmationLabel"]).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u);
    expect(requested.body).not.toHaveProperty("sessionCredential");

    const requestId = requested.body["requestId"] as string;
    const confirmationLabel = requested.body["confirmationLabel"] as string;
    expect(await post(listener, "/session/pair/approve", { confirmationLabel })).toEqual({
      body: { code: "LISTENER_ROUTE_UNKNOWN", layer: CONTROL_ROOM_LISTENER_LAYER },
      cacheControl: undefined,
      status: 404,
    });
    const pending = await post(listener, PAIRING_CLAIM_PATH, { requestId });
    expect(pending).toMatchObject({
      body: { code: "PAIRING_APPROVAL_REQUIRED", layer: PAIRING_APPROVAL_LAYER },
      cacheControl: "no-store",
      status: 409,
    });
    expect(listener.approvePairing(confirmationLabel)).toEqual({ ok: true, state: "APPROVED" });

    const claims = await Promise.all([
      post(listener, PAIRING_CLAIM_PATH, { requestId }),
      post(listener, PAIRING_CLAIM_PATH, { requestId }),
    ]);
    const winner = claims.find((reply) => reply.status === 200);
    const loser = claims.find((reply) => reply.status !== 200);
    expect(winner?.cacheControl).toBe("no-store");
    expect(loser?.cacheControl).toBe("no-store");
    expect(winner?.body).toEqual({
      capabilities: ["project.admin"],
      expiresAt: "2026-08-25T00:00:00.000Z",
      ok: true,
      projectId: PROJECT_ID,
      protocolVersion: WIRE_PROTOCOL_VERSION,
      sessionCredential: CREDENTIAL,
    });
    expect(loser).toEqual({
      body: { code: "PAIRING_REQUEST_ALREADY_CLAIMED", layer: PAIRING_APPROVAL_LAYER },
      cacheControl: "no-store",
      status: 410,
    });
    expect(mintCalls.value).toBe(1);
    expect(log.join("\n")).not.toContain(requestId);
    expect(log.join("\n")).not.toContain(confirmationLabel);
    expect(log.join("\n")).not.toContain(CREDENTIAL);
  } finally {
    await listener.close();
  }
});

it("refuses non-exact request and claim bodies at the pairing approval layer", async () => {
  const listener = await started([], { value: 0 });
  try {
    expect(await post(listener, PAIRING_REQUEST_PATH, { extra: true })).toEqual({
      body: { code: "PAIRING_CREATE_REQUEST_INVALID", layer: PAIRING_APPROVAL_LAYER },
      cacheControl: "no-store",
      status: 400,
    });
    expect(await post(listener, PAIRING_CLAIM_PATH, { requestId: "../request" })).toEqual({
      body: { code: "PAIRING_CLAIM_REQUEST_INVALID", layer: PAIRING_APPROVAL_LAYER },
      cacheControl: "no-store",
      status: 400,
    });
    expect(await post(listener, PAIRING_REQUEST_PATH, { padding: "x".repeat(200) })).toEqual({
      body: { code: "LISTENER_BODY_TOO_LARGE", layer: CONTROL_ROOM_LISTENER_LAYER },
      cacheControl: "no-store",
      status: 413,
    });
  } finally {
    await listener.close();
  }
});

it("applies Host, Origin, CSRF, method, protocol, and exact-path guards in order", async () => {
  const listener = await started([], { value: 0 });
  try {
    const cases = [
      [{ host: "evil.example", method: "GET" }, "LISTENER_HOST_INVALID", 403],
      [{ origin: "http://evil.example", method: "GET" }, "LISTENER_ORIGIN_INVALID", 403],
      [{ csrf: "wrong", method: "GET" }, "LISTENER_CSRF_INVALID", 403],
      [{ method: "GET" }, "LISTENER_PAIRING_METHOD_INVALID", 405],
      [{ protocolVersion: "future-wire" }, "LISTENER_PAIRING_PROTOCOL_UNSUPPORTED", 400],
    ] as const;
    for (const [overrides, code, status] of cases) {
      expect(await post(listener, PAIRING_REQUEST_PATH, {}, overrides)).toEqual({
        body: { code, layer: CONTROL_ROOM_LISTENER_LAYER }, cacheControl: "no-store", status,
      });
    }
    expect(await post(listener, `${PAIRING_REQUEST_PATH}?requestId=forbidden`, {})).toEqual({
      body: { code: "LISTENER_ROUTE_UNKNOWN", layer: CONTROL_ROOM_LISTENER_LAYER },
      cacheControl: "no-store",
      status: 404,
    });
    expect(await post(
      listener,
      `${PAIRING_REQUEST_PATH}?requestId=forbidden`,
      {},
      { host: "evil.example" },
    )).toEqual({
      body: { code: "LISTENER_HOST_INVALID", layer: CONTROL_ROOM_LISTENER_LAYER },
      cacheControl: "no-store",
      status: 403,
    });
  } finally {
    await listener.close();
  }
});

it("revokes the in-process approval capability when the listener closes", async () => {
  const listener = await started([], { value: 0 });
  await listener.close();
  expect(listener.approvePairing("abcd-ef01-2345")).toEqual({
    code: "LISTENER_PAIRING_UNAVAILABLE",
    layer: CONTROL_ROOM_LISTENER_LAYER,
    ok: false,
  });
});
