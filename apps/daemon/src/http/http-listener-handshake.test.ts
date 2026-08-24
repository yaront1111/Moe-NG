import { request as httpRequest } from "node:http";
import { afterAll, expect, it } from "vitest";

import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { CommandAdapterDeps } from "./http-contract.js";
import {
  CONTROL_ROOM_LISTENER_LAYER,
  LISTENER_REFUSAL_CODES,
  startControlRoomListener,
} from "./http-listener.js";
import type { ControlRoomListener, StartListenerOptions } from "./http-listener.js";
import {
  CAPABILITY, authenticator as fixtureAuthenticator, decisionPort, recordingHandler, registryOf,
} from "./http-test-fixtures.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import { closeStores, openStore, PROJECT_ID } from "../identity/session-test-fixtures.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";

/**
 * Every case drives the REAL listener over a real socket, the browser shape the
 * handshake exists to serve. The pairing route opens a session in a real store
 * through the shipped `createOperatorSessionHandshakePort`, and the credential it
 * mints is then handed back to the SAME store-backed authenticator the daemon
 * wires - so "a valid token mints a credential that authenticates" is proved
 * end to end rather than mocked.
 */

const CSRF = "csrf-token-for-handshake-test";
const OPERATOR_PRINCIPAL = "operator-local";

afterAll(() => { closeStores(); });

/** The JSON command surface's own fixture deps, unrelated to the handshake mint. */
function fixtureDeps(): CommandAdapterDeps {
  return {
    authenticator: fixtureAuthenticator([CAPABILITY]),
    decisions: decisionPort(),
    registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
  };
}

const affordancePort = {
  boundProjectId: PROJECT_ID,
  readSurface: () => ({ nextAllowedCommands: [], outcome: "SURFACE" as const, steps: [] }),
};

/**
 * A listener whose authenticator and pairing mint share ONE store, so a minted
 * credential is authenticated by the very fold the mint wrote into.
 */
function storeBackedOptions(
  overrides: Partial<StartListenerOptions> = {},
): { readonly handshake: SessionHandshakePort; readonly options: StartListenerOptions } {
  const store = openStore();
  const authenticator = createSessionAuthenticator(store, {
    clock: () => Date.now(),
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: "operator-credential-unused-in-pairing",
    operatorPrincipalId: OPERATOR_PRINCIPAL,
    projectId: PROJECT_ID,
  });
  const handshake = createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => Date.now(),
    operatorPrincipalId: OPERATOR_PRINCIPAL,
    projectId: PROJECT_ID,
    reservedPrincipalIds: [OPERATOR_PRINCIPAL],
    sessionTtlMs: 60_000,
    store,
  });
  return {
    handshake,
    options: {
      affordances: affordancePort,
      csrfToken: CSRF,
      deps: { authenticator, decisions: decisionPort(), registry: registryOf(
        "goal.create", recordingHandler().handler, ["title"],
      ) },
      pairing: handshake,
      pairingToken: "the-one-time-pairing-token-abc123",
      ...overrides,
    },
  };
}

interface Reply {
  readonly body: Record<string, unknown>;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly raw: string;
  readonly status: number;
}

async function call(
  listener: ControlRoomListener,
  init: {
    readonly body?: string;
    readonly csrf?: string | null;
    readonly host?: string;
    readonly method?: string;
    readonly origin?: string | null;
    readonly path: string;
    readonly protocolVersion?: string | null;
    readonly credential?: string | null;
  },
): Promise<Reply> {
  const headers: Record<string, string> = { host: init.host ?? `127.0.0.1:${listener.port}` };
  if (init.origin !== null && init.origin !== undefined) headers.origin = init.origin;
  if (init.csrf !== null && init.csrf !== undefined) headers["x-moe-csrf"] = init.csrf;
  if (init.protocolVersion !== null && init.protocolVersion !== undefined) {
    headers["x-moe-protocol-version"] = init.protocolVersion;
  }
  if (init.credential !== null && init.credential !== undefined) {
    headers["x-moe-session-credential"] = init.credential;
  }
  const payload = init.body ?? "";
  if (payload !== "") headers["content-type"] = "application/json";
  return await new Promise<Reply>((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { ...headers, "content-length": Buffer.byteLength(payload) },
        host: "127.0.0.1",
        method: init.method ?? "GET",
        path: init.path,
        port: listener.port,
        setHost: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: (raw === "" ? {} : JSON.parse(raw)) as Record<string, unknown>,
            headers: response.headers,
            raw,
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

async function withListener(
  options: StartListenerOptions,
  run: (listener: ControlRoomListener) => Promise<void>,
): Promise<void> {
  const started = await startControlRoomListener(options);
  if (!started.ok) throw new Error(`listener refused to start: ${started.code}`);
  try {
    await run(started);
  } finally {
    await started.close();
  }
}

function expectRefusal(reply: Reply, code: string, status: number): void {
  expect(reply.body).toEqual({ code, layer: CONTROL_ROOM_LISTENER_LAYER });
  expect(reply.status).toBe(status);
  expect((LISTENER_REFUSAL_CODES as readonly string[]).includes(code)).toBe(true);
}

function expectPolicyHeaders(reply: Reply): void {
  expect(reply.headers["content-security-policy"])
    .toBe("default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  expect(reply.headers["x-frame-options"]).toBe("DENY");
  expect(reply.headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(reply.headers["referrer-policy"]).toBe("no-referrer");
  expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  expect(reply.headers["cache-control"]).toBe("no-cache");
}

const pairBody = (token: string): string => JSON.stringify({ pairingToken: token });

it("answers /bootstrap with no credential and the policy headers, and cross-origin is irrelevant", async () => {
  const { options } = storeBackedOptions();
  await withListener(options, async (listener) => {
    // No Origin, no CSRF, no credential - the top-level navigation shape.
    const reply = await call(listener, { path: "/bootstrap" });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      csrfToken: CSRF, projectId: PROJECT_ID, protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expectPolicyHeaders(reply);

    // A FOREIGN Origin changes nothing: /bootstrap does not check Origin, and the
    // same-origin CORP header is what keeps a foreign origin from READING this.
    const foreign = await call(listener, { origin: "http://evil.example.com", path: "/bootstrap" });
    expect(foreign.status).toBe(200);
    expect(foreign.body).toEqual({
      csrfToken: CSRF, projectId: PROJECT_ID, protocolVersion: WIRE_PROTOCOL_VERSION,
    });
  });
});

it("refuses /bootstrap on a foreign Host and a wrong method", async () => {
  const { options } = storeBackedOptions();
  await withListener(options, async (listener) => {
    const rebound = await call(listener, { host: "evil.example.com", path: "/bootstrap" });
    expectRefusal(rebound, "LISTENER_HOST_INVALID", 403);
    expectPolicyHeaders(rebound);
    const posted = await call(listener, { method: "POST", body: "{}", path: "/bootstrap" });
    expectRefusal(posted, "LISTENER_PAIRING_METHOD_INVALID", 405);
  });
});

it("refuses /bootstrap and /session/pair when no handshake is configured", async () => {
  // The daemon-started-without-hosting shape: no pairing port, no token. Both
  // routes refuse UNAVAILABLE rather than answering or 404-ing.
  await withListener({
    csrfToken: CSRF, deps: fixtureDeps(),
  }, async (listener) => {
    expectRefusal(await call(listener, { path: "/bootstrap" }), "LISTENER_PAIRING_UNAVAILABLE", 503);
    const pair = await call(listener, {
      body: pairBody("x"), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expectRefusal(pair, "LISTENER_PAIRING_UNAVAILABLE", 503);
  });
});

it("with the port wired but NO token (hosting off) refuses /session/pair yet still answers /bootstrap", async () => {
  // The exact shape a daemon started without an asset root produces: the provider
  // always wires the mint, but the entry minted no pairing token, so the pair
  // route has nothing to pair against while /bootstrap still hands out the token.
  // Drop the token key entirely (not set it to undefined): exactOptionalPropertyTypes
  // forbids an explicit `pairingToken: undefined`.
  const { pairingToken: _noToken, ...options } = storeBackedOptions().options;
  await withListener(options, async (listener) => {
    const pair = await call(listener, {
      body: pairBody("anything"), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expectRefusal(pair, "LISTENER_PAIRING_UNAVAILABLE", 503);

    const bootstrap = await call(listener, { path: "/bootstrap" });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body["projectId"]).toBe(PROJECT_ID);
  });
});

it("refuses /session/pair for a wrong Origin, a missing CSRF, and a bad protocol", async () => {
  const { options } = storeBackedOptions();
  await withListener(options, async (listener) => {
    const wrongOrigin = await call(listener, {
      body: pairBody(options.pairingToken ?? ""), csrf: CSRF, method: "POST",
      origin: "http://evil.example.com", path: "/session/pair",
      protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expectRefusal(wrongOrigin, "LISTENER_ORIGIN_INVALID", 403);

    const noCsrf = await call(listener, {
      body: pairBody(options.pairingToken ?? ""), csrf: null, method: "POST",
      origin: listener.origin, path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expectRefusal(noCsrf, "LISTENER_CSRF_INVALID", 403);

    const badProtocol = await call(listener, {
      body: pairBody(options.pairingToken ?? ""), csrf: CSRF, method: "POST",
      origin: listener.origin, path: "/session/pair", protocolVersion: "incompatible-build",
    });
    expectRefusal(badProtocol, "LISTENER_PAIRING_PROTOCOL_UNSUPPORTED", 400);
  });
});

it("refuses a malformed /session/pair body with its own code, before the token check", async () => {
  const { options } = storeBackedOptions();
  await withListener(options, async (listener) => {
    for (const body of ["{not json", JSON.stringify({}), JSON.stringify({ pairingToken: 7 }),
      JSON.stringify({ pairingToken: "x", extra: 1 })]) {
      const reply = await call(listener, {
        body, csrf: CSRF, method: "POST", origin: listener.origin,
        path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
      });
      expectRefusal(reply, "LISTENER_PAIRING_REQUEST_INVALID", 400);
    }
  });
});

it("mints a credential from a valid token that then authenticates on /affordances/read", async () => {
  const { options } = storeBackedOptions();
  const token = options.pairingToken ?? "";
  await withListener(options, async (listener) => {
    const paired = await call(listener, {
      body: pairBody(token), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expect(paired.status).toBe(200);
    const credential = paired.body["sessionCredential"];
    expect(typeof credential).toBe("string");
    expect(credential).not.toBe(token);
    expect(paired.body["projectId"]).toBe(PROJECT_ID);
    expect(paired.body["protocolVersion"]).toBe(WIRE_PROTOCOL_VERSION);
    expect(paired.body["capabilities"]).toEqual([...OPERATOR_CAPABILITIES]);
    expect(typeof paired.body["expiresAt"]).toBe("string");
    expectPolicyHeaders(paired);

    // The minted credential authenticates on a real authenticated route.
    const surface = await call(listener, {
      body: "{}", credential: credential as string, csrf: CSRF, method: "POST",
      origin: listener.origin, path: "/affordances/read", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expect(surface.status).toBe(200);
    expect(surface.body).toMatchObject({ outcome: "SURFACE" });
  });
});

it("consumes the token exactly once under a concurrent burst: one credential, the rest refused", async () => {
  // The consume-once guarantee rests on there being NO await between the
  // consumed-check and the reservation in serveSessionPair. A future refactor
  // that slipped an await into that window would double-mint from one token and
  // no sequential test would notice. Fire the same valid token at the mint from
  // many sockets at once and require exactly one 200 with one distinct credential.
  const { options } = storeBackedOptions();
  const token = options.pairingToken ?? "";
  await withListener(options, async (listener) => {
    const replies = await Promise.all(Array.from({ length: 24 }, async () =>
      call(listener, {
        body: pairBody(token), csrf: CSRF, method: "POST", origin: listener.origin,
        path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
      })));
    const minted = replies.filter((reply) => reply.status === 200);
    const rejected = replies.filter((reply) => reply.status === 401);
    expect(minted).toHaveLength(1);
    expect(rejected).toHaveLength(replies.length - 1);
    rejected.forEach((reply) => { expect(reply.body["code"]).toBe("LISTENER_PAIRING_TOKEN_REJECTED"); });
    const credentials = new Set(minted.map((reply) => reply.body["sessionCredential"]));
    expect(credentials.size).toBe(1);
    expect(typeof [...credentials][0]).toBe("string");
  });
});

it("refuses a reused and an unknown token with the SAME code and status, no oracle", async () => {
  const { options } = storeBackedOptions();
  const token = options.pairingToken ?? "";
  await withListener(options, async (listener) => {
    const first = await call(listener, {
      body: pairBody(token), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expect(first.status).toBe(200);

    // Second use of the same, now-consumed token.
    const reused = await call(listener, {
      body: pairBody(token), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expectRefusal(reused, "LISTENER_PAIRING_TOKEN_REJECTED", 401);

    // A token that was never valid: identical shape, so wrong and used are one.
    const unknown = await call(listener, {
      body: pairBody("a-token-never-minted"), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expectRefusal(unknown, "LISTENER_PAIRING_TOKEN_REJECTED", 401);
    expect(reused.status).toBe(unknown.status);
    expect(reused.body).toEqual(unknown.body);
  });
});

it("an unknown token before any valid use refuses with TOKEN_REJECTED and mints nothing", async () => {
  const { options } = storeBackedOptions();
  const token = options.pairingToken ?? "";
  await withListener(options, async (listener) => {
    const wrong = await call(listener, {
      body: pairBody("not-the-token"), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expectRefusal(wrong, "LISTENER_PAIRING_TOKEN_REJECTED", 401);
    // The real token still works afterwards: a wrong presentation does not consume it.
    const paired = await call(listener, {
      body: pairBody(token), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expect(paired.status).toBe(200);
    expect(typeof paired.body["sessionCredential"]).toBe("string");
  });
});

it("expires the pairing token after one minute and never reopens it after clock rollback", async () => {
  let monotonicNow = 10_000;
  let mintCalls = 0;
  const seeded = storeBackedOptions({ pairingMonotonicNow: () => monotonicNow });
  const token = seeded.options.pairingToken ?? "";
  const options: StartListenerOptions = {
    ...seeded.options,
    pairing: {
      boundProjectId: seeded.handshake.boundProjectId,
      mint: () => {
        mintCalls += 1;
        return seeded.handshake.mint();
      },
    },
  };
  await withListener(options, async (listener) => {
    // The deadline is exclusive: at exactly one minute the token is no longer a bearer.
    monotonicNow += 60_000;
    const expired = await call(listener, {
      body: pairBody(token), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expectRefusal(expired, "LISTENER_PAIRING_TOKEN_REJECTED", 401);
    expect(mintCalls).toBe(0);

    // A bad injected clock must not turn an already-observed expiry back into authority.
    monotonicNow = 10_001;
    const rolledBack = await call(listener, {
      body: pairBody(token), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expectRefusal(rolledBack, "LISTENER_PAIRING_TOKEN_REJECTED", 401);
    expect(rolledBack.body).toEqual(expired.body);
    expect(mintCalls).toBe(0);
  });
});

it("never puts the pairing token in a response body or a listener log line", async () => {
  const lines: string[] = [];
  const { options } = storeBackedOptions({ log: (line: string) => lines.push(line) });
  const token = options.pairingToken ?? "";
  await withListener(options, async (listener) => {
    const paired = await call(listener, {
      body: pairBody(token), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expect(paired.status).toBe(200);
    const reused = await call(listener, {
      body: pairBody(token), csrf: CSRF, method: "POST", origin: listener.origin,
      path: "/session/pair", protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expect(reused.status).toBe(401);
    for (const raw of [paired.raw, reused.raw]) expect(raw).not.toContain(token);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(token);
  });
});
