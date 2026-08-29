import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import {
  CAPABILITY, authenticator, decisionPort, recordingHandler, registryOf,
} from "./http-test-fixtures.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";

const CSRF = "csrf-handshake-tombstone";

interface CallOptions {
  readonly body?: string;
  readonly csrf?: string;
  readonly host?: string;
  readonly method?: string;
  readonly origin?: string;
  readonly path: string;
  readonly protocolVersion?: string;
}

interface Reply {
  readonly body: Record<string, unknown>;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly status: number;
}

async function call(listener: ControlRoomListener, options: CallOptions): Promise<Reply> {
  return await new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const request = httpRequest(listener.origin + options.path, {
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        host: options.host ?? `127.0.0.1:${listener.port}`,
        origin: options.origin ?? listener.origin,
        "x-moe-csrf": options.csrf ?? CSRF,
        "x-moe-protocol-version": options.protocolVersion ?? WIRE_PROTOCOL_VERSION,
      },
      method: options.method ?? "GET",
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        headers: response.headers,
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end(options.body ?? "");
  });
}

async function listener(options: {
  readonly pairing?: boolean;
  readonly mint?: SessionHandshakePort["mint"];
} = {}): Promise<{
  readonly listener: ControlRoomListener;
  readonly mint: SessionHandshakePort["mint"];
}> {
  const mint = options.mint ?? vi.fn(() => {
    throw new Error("legacy bearer route reached the credential mint");
  });
  const handler = recordingHandler();
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps: {
      authenticator: authenticator([CAPABILITY]),
      decisions: decisionPort(),
      registry: registryOf("goal.create", handler.handler, ["title"]),
    },
    ...(options.pairing === false ? {} : { pairing: {
      boundProjectId: "project-handshake",
      mint,
    } }),
  });
  if (!started.ok) throw new Error(started.code);
  return { listener: started, mint };
}

function expectPolicyHeaders(reply: Reply, cacheControl = "no-cache"): void {
  expect(reply.headers["content-security-policy"])
    .toBe("default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  expect(reply.headers["x-frame-options"]).toBe("DENY");
  expect(reply.headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(reply.headers["referrer-policy"]).toBe("no-referrer");
  expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  expect(reply.headers["cache-control"]).toBe(cacheControl);
}

describe("control-room bootstrap and removed bearer route", () => {
  it("answers bootstrap without authority and preserves browser policy headers", async () => {
    const { listener: started } = await listener();
    try {
      const response = await call(started, { path: "/bootstrap" });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        csrfToken: CSRF, projectId: "project-handshake", protocolVersion: WIRE_PROTOCOL_VERSION,
      });
      expect(JSON.stringify(response.body)).not.toMatch(/credential|requestId|confirmationLabel/iu);
      expectPolicyHeaders(response);

      const foreignOrigin = await call(started, {
        origin: "http://evil.example.com", path: "/bootstrap",
      });
      expect(foreignOrigin.status).toBe(200);
      expect(foreignOrigin.body).toEqual(response.body);
      expectPolicyHeaders(foreignOrigin);
    } finally { await started.close(); }
  });

  it("refuses bootstrap on a foreign Host and a state-changing method", async () => {
    const { listener: started } = await listener();
    try {
      const rebound = await call(started, { host: "evil.example.com", path: "/bootstrap" });
      expect(rebound.status).toBe(403);
      expect(rebound.body).toEqual({
        code: "LISTENER_HOST_INVALID", layer: "CONTROL_ROOM_LISTENER",
      });
      expectPolicyHeaders(rebound);

      const posted = await call(started, {
        body: "{}", method: "POST", path: "/bootstrap",
      });
      expect(posted.status).toBe(405);
      expect(posted.body).toEqual({
        code: "LISTENER_PAIRING_METHOD_INVALID", layer: "CONTROL_ROOM_LISTENER",
      });
      expectPolicyHeaders(posted);
    } finally { await started.close(); }
  });

  it("keeps /session/pair as a non-minting tombstone", async () => {
    const { listener: started, mint } = await listener();
    try {
      const created = await call(started, {
        body: "{}", method: "POST", path: "/session/pair/request",
      });
      expect(created.status).toBe(200);
      expect(started.approvePairing(created.body["confirmationLabel"])).toEqual({
        ok: true, state: "APPROVED",
      });

      const response = await call(started, {
        body: JSON.stringify({ pairingToken: "legacy-bearer-must-never-mint" }),
        method: "POST",
        path: "/session/pair",
      });
      expect(response.status).not.toBe(200);
      expect(response.body).toEqual({
        code: "LISTENER_PAIRING_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER",
      });
      expect(response.body).not.toHaveProperty("sessionCredential");
      expect(mint).not.toHaveBeenCalled();
      expectPolicyHeaders(response, "no-store");
    } finally { await started.close(); }
  });

  it("refuses bootstrap, request, and claim when pairing authority is absent", async () => {
    const { listener: started, mint } = await listener({ pairing: false });
    try {
      const replies = await Promise.all([
        call(started, { path: "/bootstrap" }),
        call(started, { body: "{}", method: "POST", path: "/session/pair/request" }),
        call(started, {
          body: JSON.stringify({ requestId: "a".repeat(64) }),
          method: "POST",
          path: "/session/pair/claim",
        }),
      ]);
      expect(replies).toHaveLength(3);
      for (const reply of replies) {
        expect(reply.status).toBe(503);
        expect(reply.body).toEqual({
          code: "LISTENER_PAIRING_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER",
        });
      }
      expectPolicyHeaders(replies[0] as Reply);
      expectPolicyHeaders(replies[1] as Reply, "no-store");
      expectPolicyHeaders(replies[2] as Reply, "no-store");
      expect(mint).not.toHaveBeenCalled();
    } finally { await started.close(); }
  });
});
