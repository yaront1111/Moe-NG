import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { startDaemon } from "../daemon-entry.js";
import type { StartedDaemon } from "../daemon-entry.js";
import { handleCommandRequest } from "./http-adapter.js";
import {
  HTTP_INPUT_BOUNDS,
  HTTP_REFUSAL_STAGES,
  MAX_COMMAND_PAYLOAD_FIELDS,
  WIRE_PROTOCOL_VERSION,
} from "./http-contract.js";
import type { CommandAdapterDeps, CommandDecisionPort } from "./http-contract.js";
import { CONTROL_ROOM_LISTENER_LAYER } from "./http-listener.js";
import {
  CAPABILITY,
  GOOD_CREDENTIAL,
  authenticator,
  bytes,
  decisionPort,
  envelopeObject,
  envelopeOfExactByteLength,
  nestedPayload,
  payloadWithFieldCount,
  recordingHandler,
  refusingDecisionPort,
  registryOf,
} from "./http-test-fixtures.js";

const CSRF = "forwarding-csrf";
const encoder = new TextEncoder();

interface Reply {
  readonly body: Record<string, unknown>;
  readonly status: number;
}

interface SocketTarget {
  readonly csrfToken: string;
  readonly origin: string;
  readonly port: number;
}

interface Wiring {
  readonly authCalls: { count: number };
  readonly deps: CommandAdapterDeps;
  readonly handlerCalls: { count: number };
}

function wiring(options: {
  readonly capabilities?: readonly string[];
  readonly decisions?: CommandDecisionPort;
  readonly payloadKeys?: readonly string[];
} = {}): Wiring {
  const baseAuthenticator = authenticator(options.capabilities ?? [CAPABILITY]);
  const authCalls = { count: 0 };
  const recorded = recordingHandler();
  return {
    authCalls,
    deps: {
      authenticator: {
        authenticate: (credential) => {
          authCalls.count += 1;
          return baseAuthenticator.authenticate(credential);
        },
      },
      decisions: options.decisions ?? decisionPort(),
      registry: registryOf(
        "goal.create",
        recorded.handler,
        options.payloadKeys ?? ["title"],
      ),
    },
    handlerCalls: recorded.calls,
  };
}

async function withDaemon(wired: Wiring, run: (daemon: StartedDaemon) => Promise<void>): Promise<void> {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: { provide: () => wired.deps },
  });
  if (!started.ok) throw new Error(`daemon refused: ${started.code}`);
  try {
    await run(started);
  } finally {
    await started.shutdown();
  }
}

async function post(
  daemon: SocketTarget,
  body: Uint8Array = bytes(envelopeObject()),
  headers: { readonly credential?: string | null; readonly protocol?: string | null } = {},
): Promise<Reply> {
  const requestHeaders: Record<string, string | number> = {
    "content-length": body.byteLength,
    "content-type": "application/json",
    "x-moe-csrf": daemon.csrfToken,
    host: `127.0.0.1:${daemon.port}`,
    origin: daemon.origin,
  };
  if (headers.credential !== null) {
    requestHeaders["x-moe-session-credential"] = headers.credential ?? GOOD_CREDENTIAL;
  }
  if (headers.protocol !== null) {
    requestHeaders["x-moe-protocol-version"] = headers.protocol ?? WIRE_PROTOCOL_VERSION;
  }

  return await new Promise<Reply>((resolve, reject) => {
    const request = httpRequest(
      { headers: requestHeaders, host: "127.0.0.1", method: "POST", path: "/command", port: daemon.port, setHost: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          status: response.statusCode ?? 0,
        }));
      },
    );
    request.on("error", reject);
    request.end(Buffer.from(body));
  });
}

interface StageCase {
  readonly body?: Uint8Array;
  readonly code: string;
  readonly credential?: string | null;
  readonly layer?: string;
  readonly protocol?: string | null;
  readonly stage: (typeof HTTP_REFUSAL_STAGES)[number];
  readonly status: number;
  readonly wired: Wiring;
}

function stageCases(): readonly StageCase[] {
  const fieldKeys = Array.from({ length: MAX_COMMAND_PAYLOAD_FIELDS + 1 }, (_, i) => `f${String(i)}`);
  return [
    { code: "AUTHENTICATION_FAILED", credential: null, stage: "AUTHENTICATE", status: 401, wired: wiring() },
    { code: "DISTRIBUTION_MISMATCH", protocol: "incompatible", stage: "COMPATIBILITY", status: 422, wired: wiring() },
    { body: encoder.encode("{"), code: "INPUT_INVALID", stage: "DECODE", status: 400, wired: wiring() },
    { body: bytes(envelopeObject({ commandKind: "goal.cancel" })), code: "INPUT_INVALID", stage: "REGISTRY", status: 400, wired: wiring() },
    { code: "CAPABILITY_DENIED", stage: "AUTHORIZE", status: 403, wired: wiring({ capabilities: [] }) },
    { body: bytes(envelopeObject({ payload: payloadWithFieldCount(MAX_COMMAND_PAYLOAD_FIELDS + 1) })), code: "INPUT_LIMIT_EXCEEDED", stage: "PAYLOAD_SHAPE", status: 413, wired: wiring({ payloadKeys: fieldKeys }) },
    { code: "IDEMPOTENCY_CONFLICT", layer: "DURABLE_DECISION", stage: "DISPATCH", status: 409, wired: wiring({ decisions: refusingDecisionPort() }) },
  ];
}

it("forwards every adapter refusal code, stage, layer and status over a real socket", async () => {
  const cases = stageCases();
  expect(cases).toHaveLength(HTTP_REFUSAL_STAGES.length);
  expect([...new Set(cases.map(({ stage }) => stage))].sort()).toEqual([...HTTP_REFUSAL_STAGES].sort());

  for (const subject of cases) {
    await withDaemon(subject.wired, async (daemon) => {
      const body = subject.body ?? bytes(envelopeObject());
      const credential = subject.credential === undefined ? GOOD_CREDENTIAL : subject.credential;
      const protocolVersion = subject.protocol === undefined
        ? WIRE_PROTOCOL_VERSION
        : subject.protocol;
      const expected = handleCommandRequest(subject.wired.deps, {
        body,
        credential,
        protocolVersion,
      });
      const reply = await post(daemon, body, {
        ...(subject.credential === undefined ? {} : { credential: subject.credential }),
        ...(subject.protocol === undefined ? {} : { protocol: subject.protocol }),
      });
      expect(reply.status).toBe(subject.status);
      expect(reply.body).toEqual(JSON.parse(JSON.stringify(expected)) as Record<string, unknown>);
      expect(reply.body).toMatchObject({ httpStatus: subject.status, stage: subject.stage });
      if (subject.stage === "DISPATCH") {
        expect(reply.body).toMatchObject({
          outcome: "PORT_REFUSED",
          refusal: { code: subject.code, layer: subject.layer },
        });
      } else {
        expect(reply.body).toMatchObject({ error: { code: subject.code }, outcome: "REFUSED" });
      }
    });
    expect(subject.wired.handlerCalls.count).toBe(0);
  }
});

it("dispatches one accepted socket request exactly once", async () => {
  const wired = wiring();
  await withDaemon(wired, async (daemon) => {
    const reply = await post(daemon);
    expect(reply).toMatchObject({ body: { httpStatus: 200, ok: true, outcome: "ACCEPTED" }, status: 200 });
  });
  expect(wired.handlerCalls.count).toBe(1);
});

async function expectBound(
  wired: Wiring,
  admitted: Uint8Array,
  refused: Uint8Array,
  stage: "DECODE" | "PAYLOAD_SHAPE",
  limitName: string,
): Promise<void> {
  await withDaemon(wired, async (daemon) => {
    expect((await post(daemon, admitted)).status).toBe(200);
    const before = { auth: wired.authCalls.count, handler: wired.handlerCalls.count };
    const over = await post(daemon, refused);
    expect(over.status).toBe(413);
    expect(over.body).toMatchObject({
      error: { code: "INPUT_LIMIT_EXCEEDED", details: { limitName } },
      stage,
    });
    expect(wired.handlerCalls.count).toBe(before.handler);
  });
}

it("enforces every production input bound at N and N+1 over the socket", async () => {
  const bodyWiring = wiring({ payloadKeys: ["p0", "p1", "p2", "p3", "p4", "p5"] });
  await withDaemon(bodyWiring, async (daemon) => {
    expect((await post(daemon, envelopeOfExactByteLength(HTTP_INPUT_BOUNDS.maxBodyBytes))).status).toBe(200);
    const before = { auth: bodyWiring.authCalls.count, handler: bodyWiring.handlerCalls.count };
    const over = await post(daemon, envelopeOfExactByteLength(HTTP_INPUT_BOUNDS.maxBodyBytes + 1));
    expect(over).toMatchObject({
      body: { code: "LISTENER_BODY_TOO_LARGE", layer: CONTROL_ROOM_LISTENER_LAYER },
      status: 413,
    });
    expect(bodyWiring.authCalls.count).toBe(before.auth);
    expect(bodyWiring.handlerCalls.count).toBe(before.handler);
  });

  await expectBound(
    wiring({ payloadKeys: ["deep"] }),
    bytes(envelopeObject({ payload: nestedPayload(HTTP_INPUT_BOUNDS.maxDepth - 2) })),
    bytes(envelopeObject({ payload: nestedPayload(HTTP_INPUT_BOUNDS.maxDepth - 1) })),
    "DECODE",
    "JSON_DEPTH",
  );
  await expectBound(
    wiring(),
    bytes(envelopeObject({ payload: { title: "a".repeat(HTTP_INPUT_BOUNDS.maxStringUtf8Bytes) } })),
    bytes(envelopeObject({ payload: { title: "a".repeat(HTTP_INPUT_BOUNDS.maxStringUtf8Bytes + 1) } })),
    "DECODE",
    "JSON_STRING_UTF8_BYTES",
  );
  const fieldKeys = Array.from({ length: HTTP_INPUT_BOUNDS.maxPayloadFields + 1 }, (_, i) => `f${String(i)}`);
  await expectBound(
    wiring({ payloadKeys: fieldKeys }),
    bytes(envelopeObject({ payload: payloadWithFieldCount(HTTP_INPUT_BOUNDS.maxPayloadFields) })),
    bytes(envelopeObject({ payload: payloadWithFieldCount(HTTP_INPUT_BOUNDS.maxPayloadFields + 1) })),
    "PAYLOAD_SHAPE",
    "COMMAND_PAYLOAD_FIELDS",
  );
});

it("normalizes an unexpected dependency throw to the listener-owned refusal", async () => {
  const wired = wiring();
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: { provide: () => wired.deps },
  });
  if (!started.ok) throw new Error(`daemon refused: ${started.code}`);
  await started.shutdown();

  const exploding = await import("./http-listener.js");
  const listener = await exploding.startControlRoomListener({
    csrfToken: CSRF,
    deps: wired.deps,
    onRequest: () => { throw new Error("secret dependency failure"); },
  });
  if (!listener.ok) throw new Error(`listener refused: ${listener.code}`);
  try {
    const daemonView = { csrfToken: CSRF, origin: listener.origin, port: listener.port };
    const reply = await post(daemonView);
    expect(reply).toEqual({
      body: { code: "LISTENER_REQUEST_FAILED", layer: CONTROL_ROOM_LISTENER_LAYER },
      status: 500,
    });
    expect(JSON.stringify(reply)).not.toContain("secret dependency failure");
  } finally {
    await listener.close();
  }
});
