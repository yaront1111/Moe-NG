import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { CommandAuthorityPlanePort } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import {
  CAPABILITY, GOOD_CREDENTIAL, authenticator, decisionPort, recordingHandler, registryOf,
} from "./http-test-fixtures.js";

const CSRF = "csrf-handshake-tombstone";

interface CallOptions {
  readonly body?: string;
  readonly credential?: string;
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
        ...(options.credential === undefined
          ? {}
          : { "x-moe-session-credential": options.credential }),
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
  readonly capabilities?: readonly string[];
  readonly pairing?: boolean;
  readonly mint?: SessionHandshakePort["mint"];
  readonly plane?: CommandAuthorityPlanePort;
  readonly projectId?: string;
  /** Whether a `/2` registry is composed beside the plane reader (default: yes). */
  readonly v2?: boolean;
} = {}): Promise<{
  readonly listener: ControlRoomListener;
  readonly mint: SessionHandshakePort["mint"];
}> {
  const mint = options.mint ?? vi.fn(() => {
    throw new Error("legacy bearer route reached the credential mint");
  });
  const handler = recordingHandler();
  const deps = {
    authenticator: authenticator(options.capabilities ?? [CAPABILITY]),
    decisions: decisionPort(),
    registry: registryOf("goal.create", handler.handler, ["title"]),
  };
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps,
    ...(options.pairing === false ? {} : { pairing: {
      boundProjectId: options.projectId ?? "project-handshake",
      mint,
    } }),
    ...(options.plane === undefined ? {} : { commandAuthorityPlane: options.plane }),
    ...(options.plane !== undefined && options.v2 !== false ? { v2Deps: deps } : {}),
  });
  if (!started.ok) throw new Error(started.code);
  return { listener: started, mint };
}

function expectPolicyHeaders(reply: Reply, cacheControl = "no-cache"): void {
  expect(reply.headers["content-security-policy"])
    .toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
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
      // EXACT keys: a browser admits this body by roster, so a key added here without
      // the client learning it is a dead handshake (see the principalId claim break).
      expect(response.body).toEqual({
        commandAuthorityPlane: "V1", csrfToken: CSRF, projectId: "project-handshake",
        protocolVersion: WIRE_PROTOCOL_VERSION,
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

  it("states the plane its composed reader answers, read again on every bootstrap", async () => {
    const answers: Array<"V1" | "V2"> = ["V1", "V2"];
    let reads = 0;
    const { listener: started } = await listener({ plane: {
      boundProjectId: "project-handshake",
      readPlane: () => { reads += 1; return answers.shift() ?? "V2"; },
    } });
    try {
      const first = await call(started, { path: "/bootstrap" });
      const second = await call(started, { path: "/bootstrap" });
      expect(first.body["commandAuthorityPlane"]).toBe("V1");
      expect(second.body["commandAuthorityPlane"]).toBe("V2");
      expect(reads).toBe(2);
      expect(Object.keys(second.body).toSorted()).toEqual(
        ["commandAuthorityPlane", "csrfToken", "projectId", "protocolVersion"]);
    } finally { await started.close(); }
  });

  it("refuses to state V2 when no /2 registry is composed, with the route's own unavailable code", async () => {
    const { listener: started } = await listener({
      plane: { boundProjectId: "project-handshake", readPlane: () => "V2" }, v2: false,
    });
    try {
      const response = await call(started, { path: "/bootstrap" });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: "LISTENER_V2_COMMAND_UNAVAILABLE" });
      expect(response.body).not.toHaveProperty("commandAuthorityPlane");
      expect(response.body).not.toHaveProperty("csrfToken");
    } finally { await started.close(); }
  });

  it("fails the request on a plane outside the roster instead of coercing it to V1", async () => {
    const { listener: started } = await listener({
      plane: { boundProjectId: "project-handshake", readPlane: () => "V3" as never },
    });
    try {
      const response = await call(started, { path: "/bootstrap" });
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: "LISTENER_REQUEST_FAILED" });
      expect(JSON.stringify(response.body)).not.toContain("V1");
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

  // task-82c28bf1: there is no authenticated HTTP approval route any more. ADMIN is a
  // REACH capability, so an ADMIN-only gate on approval never asked WHO was approving and
  // a scoped agent could approve its own label. Approval is now terminal-only, through the
  // in-process approvePairing the operator's own stdin line reaches, and the HTTP path is
  // simply unknown - to every caller, credential or not.
  it("answers the retired approval path as an unknown route without minting", async () => {
    const { listener: started, mint } = await listener({
      capabilities: [CAPABILITIES.ADMIN], projectId: "proj-0001",
    });
    try {
      const requested = await call(started, {
        body: "{}", method: "POST", path: "/session/pair/request",
      });
      const confirmationLabel = requested.body["confirmationLabel"];
      expect(typeof confirmationLabel).toBe("string");

      const approved = await call(started, {
        body: JSON.stringify({ confirmationLabel }),
        credential: GOOD_CREDENTIAL,
        method: "POST",
        path: "/session/pair/approve",
      });
      expect(approved.body).toEqual({
        code: "LISTENER_ROUTE_UNKNOWN", layer: "CONTROL_ROOM_LISTENER",
      });
      expect(mint).not.toHaveBeenCalled();

      // The request route it sits beside is untouched, so the arm still witnesses a live
      // pairing surface rather than a listener that answers nothing.
      expect(requested.status).toBe(200);
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
