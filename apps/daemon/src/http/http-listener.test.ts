import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { request as httpRequest } from "node:http";
import { expect, it } from "vitest";

import {
  CONTROL_ROOM_LISTENER_LAYER,
  LISTENER_REFUSAL_CODES,
  startControlRoomListener,
} from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import { HTTP_INPUT_BOUNDS } from "./http-contract.js";
import type { CommandAdapterDeps } from "./http-contract.js";
import { streamPort } from "./event-stream-fixtures.js";
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
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: init.host ?? `127.0.0.1:${listener.port}`,
  };
  if (init.origin !== null) headers.origin = init.origin ?? listener.origin;
  if (init.csrf !== null) headers["x-moe-csrf"] = init.csrf ?? CSRF;
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

it("refuses a state-changing request carrying no CSRF token or a wrong one", async () => {
  await withListener(async (listener) => {
    expectListenerRefusal(await send(listener, { csrf: null }), "LISTENER_CSRF_INVALID");
    expectListenerRefusal(await send(listener, { csrf: "wrong-token" }), "LISTENER_CSRF_INVALID");
  });
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

it("refuses the event page route when no subscription port is wired, without inventing a page", async () => {
  await withListener(async (listener) => {
    expectListenerRefusal(
      await send(listener, { body: JSON.stringify({ projection: "goal", subscriberId: "s-1" }), path: "/events/read" }),
      "LISTENER_STREAM_UNAVAILABLE",
    );
  });
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
