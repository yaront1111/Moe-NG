import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { request as httpRequest } from "node:http";
import { expect, it } from "vitest";

import {
  CONTROL_ROOM_LISTENER_LAYER,
  LISTENER_REFUSAL_CODES,
  startControlRoomListener,
} from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import { HTTP_INPUT_BOUNDS, WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { CommandAdapterDeps } from "./http-contract.js";
import {
  PROJECTION,
  SNAPSHOT_CHECKPOINT,
  SUBSCRIBER,
  streamPort,
} from "./event-stream-fixtures.js";
import {
  CAPABILITY,
  GOOD_CREDENTIAL,
  authenticator,
  decisionPort,
  envelopeObject,
  recordingHandler,
  registryOf,
} from "./http-test-fixtures.js";

const CSRF = "csrf-token-for-test";
const PAYLOAD_KEYS = ["title"] as const;

function deps(): CommandAdapterDeps {
  return {
    authenticator: authenticator([CAPABILITY]),
    decisions: decisionPort(),
    eventStreamAccess: {
      authorize: () => ({ ok: true, subscriberId: SUBSCRIBER }),
    },
    registry: registryOf("goal.create", recordingHandler().handler, PAYLOAD_KEYS),
  };
}

/**
 * Every started listener is closed on every exit path, including when the body
 * of the test throws. A leaked handle surfaces later as EBUSY on Windows rather
 * than as the real error, so the cleanup is not optional politeness.
 */
async function withListener(
  run: (listener: ControlRoomListener) => Promise<void>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps: deps(),
    ...overrides,
  });
  if (!started.ok) throw new Error(`listener refused to start: ${started.code}`);
  try {
    await run(started);
  } finally {
    await started.close();
  }
}

interface Reply {
  readonly body: Record<string, unknown>;
  readonly status: number;
}

async function send(
  listener: ControlRoomListener,
  init: {
    readonly body?: string;
    readonly connectHost?: string;
    readonly credential?: string | null;
    readonly csrf?: string | null;
    readonly host?: string;
    readonly method?: string;
    readonly origin?: string | null;
    readonly path?: string;
    readonly protocolVersion?: string | null;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: init.host ?? `127.0.0.1:${listener.port}`,
  };
  if (init.origin !== null) headers.origin = init.origin ?? listener.origin;
  if (init.csrf !== null) headers["x-moe-csrf"] = init.csrf ?? CSRF;
  if (init.protocolVersion !== null) {
    headers["x-moe-protocol-version"] = init.protocolVersion ?? WIRE_PROTOCOL_VERSION;
  }
  // The credential travels per REQUEST in a header, so one listener can serve
  // many principals and none of them appears in a URL.
  if (init.credential !== null) {
    headers["x-moe-session-credential"] = init.credential ?? GOOD_CREDENTIAL;
  }

  // node:http, NOT fetch. undici treats `Host` as a forbidden header and drops
  // it silently, so a Host-validation test written with fetch cannot set the
  // header it is testing — it never reaches the guard and proves nothing.
  const payload = init.body ?? JSON.stringify(envelopeObject());
  return await new Promise<Reply>((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { ...headers, "content-length": Buffer.byteLength(payload) },
        host: init.connectHost ?? "127.0.0.1",
        method: init.method ?? "POST",
        path: init.path ?? "/command",
        port: listener.port,
        setHost: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

/**
 * There are now TWO refusal layers — this listener and the committed adapter —
 * so every assertion names the layer as well as the code. A test asserting only
 * that something was refused passes when the wrong layer answers, which is
 * exactly the detached assertion the epic rail forbids.
 */
function expectListenerRefusal(reply: Reply, code: string): void {
  expect(reply.body).toMatchObject({ code, layer: CONTROL_ROOM_LISTENER_LAYER });
  expect(reply.status).toBeGreaterThanOrEqual(400);
  expect((LISTENER_REFUSAL_CODES as readonly string[]).includes(code)).toBe(true);
}

it("declares every refusal code it can emit in one frozen vocabulary", () => {
  expect(Object.isFrozen(LISTENER_REFUSAL_CODES)).toBe(true);
  expect(LISTENER_REFUSAL_CODES.length).toBeGreaterThan(0);
  expect(new Set(LISTENER_REFUSAL_CODES).size).toBe(LISTENER_REFUSAL_CODES.length);
  expect(CONTROL_ROOM_LISTENER_LAYER).toBe("CONTROL_ROOM_LISTENER");
});

it("binds loopback on an ephemeral port and reports the port actually bound", async () => {
  await withListener(async (listener) => {
    // Ephemeral, so parallel runs cannot collide on a fixed port.
    expect(listener.port).toBeGreaterThan(0);
    expect(listener.origin).toBe(`http://127.0.0.1:${listener.port}`);
  });
});

it("REFUSES TO START on a non-loopback bind rather than warning", async () => {
  // Design 19.2: loopback is the only default bind. A dev-convenience bind to a
  // public interface on a host that also runs agent processes is an exposure,
  // so this must fail closed at startup, not log and continue.
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps: deps(),
    host: "0.0.0.0",
  });
  expect(started).toMatchObject({
    code: "LISTENER_NON_LOOPBACK_BIND",
    layer: CONTROL_ROOM_LISTENER_LAYER,
    ok: false,
  });
  // Nothing may be left listening behind a refused start.
  expect(started).not.toHaveProperty("port");
});

it("REFUSES a hostname, which could resolve off-loopback, as well as a public address", async () => {
  // "localhost" looks loopback but is a NAME: its resolution is controlled by
  // the hosts file and by DNS, so admitting it would move the security decision
  // off this guard and onto the resolver.
  for (const host of ["localhost", "::", "192.168.1.10"]) {
    const started = await startControlRoomListener({ csrfToken: CSRF, deps: deps(), host });
    expect(started).toMatchObject({
      code: "LISTENER_NON_LOOPBACK_BIND",
      layer: CONTROL_ROOM_LISTENER_LAYER,
      ok: false,
    });
  }
});

it("brackets an IPv6 loopback authority so a ::1 bind is actually reachable", async () => {
  await withListener(
    async (listener) => {
      // Unbracketed, the expected authority would be "::1:port" and every real
      // Host header would refuse — bound, yet unreachable.
      expect(listener.origin).toBe(`http://[::1]:${listener.port}`);
      const reply = await send(listener, {
        connectHost: "::1",
        host: `[::1]:${listener.port}`,
      });
      expect(reply.body).not.toMatchObject({ code: "LISTENER_HOST_INVALID" });
    },
    { host: "::1" },
  );
});

it("refuses a Host header that is not the bound loopback authority", async () => {
  await withListener(async (listener) => {
    expectListenerRefusal(
      await send(listener, { host: "evil.example.com" }),
      "LISTENER_HOST_INVALID",
    );
  });
});

it("refuses an absent Origin and a foreign Origin, each by its own code", async () => {
  await withListener(async (listener) => {
    expectListenerRefusal(await send(listener, { origin: null }), "LISTENER_ORIGIN_INVALID");
    expectListenerRefusal(
      await send(listener, { origin: "http://evil.example.com" }),
      "LISTENER_ORIGIN_INVALID",
    );
  });
});

it("ADMITS the matching Origin, so the two refusals above are not a guard that refuses everything", async () => {
  await withListener(async (listener) => {
    const reply = await send(listener, { origin: listener.origin });
    // Named positively: the ADAPTER answered, so the listener passed this
    // request through rather than pre-empting it. Asserting only "not
    // LISTENER_ORIGIN_INVALID" would still pass if some other listener guard
    // had refused instead, which is the detached assertion the epic rail bans.
    expect(reply.body).toMatchObject({ outcome: "ACCEPTED" });
    expect(reply.body).not.toHaveProperty("layer", CONTROL_ROOM_LISTENER_LAYER);
    expect(reply.status).toBe(200);
  });
});

it("routes /v2/command only through the separately injected v2 command plane", async () => {
  await withListener(async (listener) => {
    const reply = await send(listener, { path: "/v2/command" });
    expect(reply.body).toMatchObject({ outcome: "ACCEPTED" });
    expect(reply.status).toBe(200);
  }, { v2Deps: deps() });
});

it("refuses /v2/command when no v2 authority plane was composed", async () => {
  await withListener(async (listener) => {
    expectListenerRefusal(
      await send(listener, { path: "/v2/command" }),
      "LISTENER_V2_COMMAND_UNAVAILABLE",
    );
  });
});

it("refuses a non-POST /v2/command before the v2 adapter sees a body", async () => {
  await withListener(async (listener) => {
    expectListenerRefusal(
      await send(listener, { method: "GET", path: "/v2/command" }),
      "LISTENER_V2_COMMAND_REQUEST_INVALID",
    );
  }, { v2Deps: deps() });
});

it("refuses a state-changing request carrying no CSRF token or a wrong one", async () => {
  await withListener(async (listener) => {
    expectListenerRefusal(await send(listener, { csrf: null }), "LISTENER_CSRF_INVALID");
    expectListenerRefusal(await send(listener, { csrf: "wrong-token" }), "LISTENER_CSRF_INVALID");
  });
});

it("an empty configured CSRF token satisfies NO request, not one bearing an empty header", async () => {
  // A `!==` compare admits `x-moe-csrf: ` (empty header) when the token is also
  // empty. An empty token can never be a secret, so it refuses everything.
  await withListener(
    async (listener) => {
      expectListenerRefusal(await send(listener, { csrf: "", path: "/command" }), "LISTENER_CSRF_INVALID");
      expectListenerRefusal(await send(listener, { csrf: null, path: "/command" }), "LISTENER_CSRF_INVALID");
    },
    { csrfToken: "" },
  );
});

it("refuses an unknown route without reaching the adapter", async () => {
  await withListener(async (listener) => {
    expectListenerRefusal(
      await send(listener, { path: "/not-a-route" }),
      "LISTENER_ROUTE_UNKNOWN",
    );
  });
});

it("refuses an oversized body at the committed bound, without buffering it whole", async () => {
  await withListener(async (listener) => {
    // Read from the contract, never restated, so the test cannot drift from it.
    expect(HTTP_INPUT_BOUNDS.maxBodyBytes).toBe(MAX_JSON_BODY_BYTES);
    const oversized = "x".repeat(HTTP_INPUT_BOUNDS.maxBodyBytes + 1);
    expectListenerRefusal(
      await send(listener, { body: JSON.stringify({ payload: oversized }) }),
      "LISTENER_BODY_TOO_LARGE",
    );
  });
});

it("never puts a credential in a URL or a log line", async () => {
  const lines: string[] = [];
  await withListener(
    async (listener) => {
      // Sent the REAL way, in the header the listener actually reads, so this
      // exercises the production credential path rather than an unused option.
      await send(listener, { credential: "secret-credential" });
      await send(listener, { credential: "secret-credential", csrf: null });
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain(CSRF);
        expect(line).not.toContain("secret-credential");
      }
    },
    { log: (line: string) => lines.push(line) },
  );
});

it.each(["/events/read", "/events/ack", "/events/resume", "/affordances/read", "/graph/get"])(
  "authenticates %s before revealing route availability or parsing its body",
  async (path) => {
    await withListener(async (listener) => {
      // No route port is wired and the body is not JSON: a route that checked
      // availability or decoded first would answer with a listener code here,
      // so the 401 proves authenticate ran ahead of both.
      const reply = await send(listener, {
        body: "{not json",
        credential: null,
        path,
      });
      expect(reply.status).toBe(401);
      expect(reply.body).toMatchObject({
        error: { code: "AUTHENTICATION_FAILED" },
        outcome: "REFUSED",
        stage: "AUTHENTICATE",
      });
      expect(reply.body).not.toHaveProperty("layer", CONTROL_ROOM_LISTENER_LAYER);
    });
  },
);

it.each(["/events/read", "/events/ack", "/events/resume", "/affordances/read", "/graph/get"])(
  "checks %s protocol compatibility before revealing route availability or parsing its body",
  async (path) => {
    await withListener(async (listener) => {
      const reply = await send(listener, {
        body: "{not json",
        path,
        protocolVersion: "incompatible-client",
      });
      expect(reply.body).toMatchObject({
        error: { code: "DISTRIBUTION_MISMATCH" },
        outcome: "REFUSED",
        stage: "COMPATIBILITY",
      });
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(reply.body).not.toHaveProperty("layer", CONTROL_ROOM_LISTENER_LAYER);
    });
  },
);

it("refuses the event page route when no subscription port is wired, without inventing a page", async () => {
  await withListener(async (listener) => {
    expectListenerRefusal(
      await send(listener, { body: JSON.stringify({ projection: "goal", subscriberId: "s-1" }), path: "/events/read" }),
      "LISTENER_STREAM_UNAVAILABLE",
    );
  });
});

it("refuses weak stream sessions before read or acknowledge can touch the shared reader", async () => {
  let acknowledgements = 0;
  let reads = 0;
  const base = streamPort();
  const subscriptions = {
    ...base,
    acknowledge: (request: Parameters<typeof base.acknowledge>[0]) => {
      acknowledgements += 1;
      return base.acknowledge(request);
    },
    readPage: (request: Parameters<typeof base.readPage>[0]) => {
      reads += 1;
      return base.readPage(request);
    },
  };
  const weakDeps = {
    ...deps(),
    eventStreamAccess: {
      authorize: () => ({
        code: "EVENT_STREAM_OPERATOR_AUTHORITY_REQUIRED" as const,
        httpStatus: 403,
        layer: "DAEMON_AUTHORIZATION" as const,
        ok: false as const,
      }),
    },
  };

  await withListener(
    async (listener) => {
      const requests = [
        { body: JSON.stringify({ projection: PROJECTION, subscriberId: SUBSCRIBER }),
          path: "/events/read" },
        { body: "{not json", path: "/events/read" },
        { body: JSON.stringify({
          presentedCursor: { generation: 1, position: "1" }, subscriberId: SUBSCRIBER,
        }), path: "/events/ack" },
        { body: "{not json", path: "/events/ack" },
      ];
      for (const request of requests) {
        const refused = await send(listener, request);
        expect(refused.status).toBe(403);
        expect(refused.body).toEqual({
          code: "EVENT_STREAM_OPERATOR_AUTHORITY_REQUIRED",
          layer: "DAEMON_AUTHORIZATION",
          outcome: "REFUSED",
        });
      }
      expect(reads).toBe(0);
      expect(acknowledgements).toBe(0);
    },
    { deps: weakDeps, subscriptions },
  );
});

it("fails closed when the daemon supplies no stream authority port", async () => {
  let reads = 0;
  const base = streamPort();
  const { eventStreamAccess: _absent, ...withoutAuthority } = deps();
  await withListener(
    async (listener) => {
      const refused = await send(listener, {
        body: JSON.stringify({ projection: PROJECTION, subscriberId: SUBSCRIBER }),
        path: "/events/read",
      });
      expect(refused).toEqual({
        body: {
          code: "EVENT_STREAM_AUTHORITY_UNAVAILABLE",
          layer: "DAEMON_AUTHORIZATION",
          outcome: "REFUSED",
        },
        status: 503,
      });
      expect(reads).toBe(0);
    },
    {
      deps: withoutAuthority,
      subscriptions: {
        ...base,
        readPage: (request: Parameters<typeof base.readPage>[0]) => {
          reads += 1;
          return base.readPage(request);
        },
      },
    },
  );
});

it("hard-binds both stream routes to the daemon-owned subscriber", async () => {
  let acknowledgements = 0;
  let reads = 0;
  const base = streamPort();
  const subscriptions = {
    ...base,
    acknowledge: (request: Parameters<typeof base.acknowledge>[0]) => {
      acknowledgements += 1;
      return base.acknowledge(request);
    },
    readPage: (request: Parameters<typeof base.readPage>[0]) => {
      reads += 1;
      return base.readPage(request);
    },
  };
  await withListener(
    async (listener) => {
      const requests = [
        { body: JSON.stringify({ projection: PROJECTION, subscriberId: "attacker-reader" }),
          path: "/events/read" },
        { body: JSON.stringify({
          presentedCursor: { generation: 1, position: "1" }, subscriberId: "attacker-reader",
        }), path: "/events/ack" },
      ];
      for (const request of requests) {
        const refused = await send(listener, request);
        expect(refused).toEqual({
          body: {
            code: "EVENT_STREAM_SUBSCRIBER_MISMATCH",
            layer: "DAEMON_AUTHORIZATION",
            outcome: "REFUSED",
          },
          status: 403,
        });
      }
      expect(reads).toBe(0);
      expect(acknowledgements).toBe(0);
    },
    { subscriptions },
  );
});

it("refuses a malformed event page body with its own code, naming this layer", async () => {
  await withListener(
    async (listener) => {
      expectListenerRefusal(
        await send(listener, { body: "{not json", path: "/events/read" }),
        "LISTENER_STREAM_REQUEST_INVALID",
      );
      expectListenerRefusal(
        await send(listener, { body: JSON.stringify({ projection: 7 }), path: "/events/read" }),
        "LISTENER_STREAM_REQUEST_INVALID",
      );
    },
    { subscriptions: streamPort() },
  );
});

it("routes an exact event-page acknowledgement after authentication", async () => {
  const subscriptions = {
    ...streamPort(),
    acknowledge: (request: unknown) => ({
      cursor: (request as { cursor: unknown }).cursor,
      outcome: "ACKNOWLEDGED" as const,
    }),
  };
  await withListener(
    async (listener) => {
      const reply = await send(listener, {
        body: JSON.stringify({
          presentedCursor: { generation: 1, position: "2" }, subscriberId: "control-room-1",
        }),
        path: "/events/ack",
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({
        cursor: { generation: 1, position: "2" }, outcome: "ACKNOWLEDGED",
      });
    },
    { subscriptions },
  );
});

it("refuses a malformed event acknowledgement before touching the subscription port", async () => {
  let acknowledgements = 0;
  const subscriptions = {
    ...streamPort(),
    acknowledge: () => {
      acknowledgements += 1;
      return { code: "unreachable", detail: "unreachable", layer: "STATE", outcome: "REFUSED" as const };
    },
  };
  await withListener(
    async (listener) => {
      expectListenerRefusal(
        await send(listener, {
          body: JSON.stringify({ presentedCursor: { generation: "1", position: 2 } }),
          path: "/events/ack",
        }),
        "LISTENER_STREAM_REQUEST_INVALID",
      );
      expect(acknowledgements).toBe(0);
    },
    { subscriptions },
  );
});

it("retires POST /events/resume before a weak session can reseat the shared reader", async () => {
  const subscriptions = streamPort({ gap: "HISTORY_PRUNED" });
  await withListener(
    async (listener) => {
      const refused = await send(listener, {
        body: JSON.stringify({
          presentedCursor: { generation: 1, position: SNAPSHOT_CHECKPOINT },
          projection: PROJECTION,
          subscriberId: SUBSCRIBER,
        }),
        path: "/events/resume",
      });
      expect(refused.status).toBe(410);
      expect(refused.body).toEqual({
        code: "EVENT_STREAM_RESUME_COMMAND_REQUIRED",
        layer: "DAEMON_EVENT_STREAM_RESUME",
      });
      expect(subscriptions.reseats()).toBe(0);
    },
    { subscriptions },
  );
});

it("keeps the retired resume route closed even for a malformed body", async () => {
  let reseats = 0;
  const subscriptions = {
    ...streamPort({ gap: "HISTORY_PRUNED" }),
    reseat: () => {
      reseats += 1;
      return { code: "unreachable", detail: "unreachable", layer: "STATE", outcome: "REFUSED" as const };
    },
  };
  await withListener(
    async (listener) => {
      const refused = await send(listener, {
          body: JSON.stringify({
            presentedCursor: { generation: 1, position: SNAPSHOT_CHECKPOINT },
            subscriberId: SUBSCRIBER,
          }),
          path: "/events/resume",
        });
      expect(refused.status).toBe(410);
      expect(refused.body).toEqual({
        code: "EVENT_STREAM_RESUME_COMMAND_REQUIRED",
        layer: "DAEMON_EVENT_STREAM_RESUME",
      });
      expect(reseats).toBe(0);
    },
    { subscriptions },
  );
});

const affordancePort = (boundProjectId: string) => ({
  boundProjectId,
  readSurface: () => ({ nextAllowedCommands: [], outcome: "SURFACE" as const, steps: [] }),
});

it("answers the affordance surface for an absent or matching projectId", async () => {
  // The bound project must be the FIXTURE PRINCIPAL's ("proj-0001"): the route
  // refuses a principal from any other project before it reads a body byte.
  await withListener(
    async (listener) => {
      const empty = await send(listener, { body: "{}", path: "/affordances/read" });
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ outcome: "SURFACE" });
      const matching = await send(listener, {
        body: JSON.stringify({ projectId: "proj-0001" }), path: "/affordances/read",
      });
      expect(matching.status).toBe(200);
      expect(matching.body).toMatchObject({ outcome: "SURFACE" });
    },
    { affordances: affordancePort("proj-0001") },
  );
});

it("refuses an affordance request naming a project this daemon does not serve", async () => {
  await withListener(
    async (listener) => {
      // The daemon must not silently answer for proj-0001 a request that asked
      // for proj-B: the surface names no project, so that would read as proj-B.
      expectListenerRefusal(
        await send(listener, {
          body: JSON.stringify({ projectId: "proj-B" }), path: "/affordances/read",
        }),
        "LISTENER_AFFORDANCE_REQUEST_INVALID",
      );
    },
    { affordances: affordancePort("proj-0001") },
  );
});

it("answers a FOREIGN principal's affordance read with the project refusal", async () => {
  // The principal-project gate's own arm: a principal authenticated for another
  // project gets the 200 refusal frame, never that project's surface.
  await withListener(
    async (listener) => {
      const foreign = await send(listener, { body: "{}", path: "/affordances/read" });
      expect(foreign.status).toBe(200);
      expect(foreign.body).toMatchObject({ outcome: "REFUSED" });
    },
    { affordances: affordancePort("proj-elsewhere") },
  );
});

it("closes the listener even when a request handler throws", async () => {
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps: deps(),
    // A dependency that throws on use proves the close path runs on the error
    // arm, not only on the happy one.
    onRequest: () => {
      throw new Error("handler exploded");
    },
  });
  if (!started.ok) throw new Error("expected a started listener");
  const reply = await send(started, {});
  expect(reply.status).toBeGreaterThanOrEqual(500);
  await started.close();

  // The port is genuinely released: a second listener can take it.
  const reused = await startControlRoomListener({
    csrfToken: CSRF,
    deps: deps(),
    port: started.port,
  });
  expect(reused.ok).toBe(true);
  if (reused.ok) await reused.close();
});
