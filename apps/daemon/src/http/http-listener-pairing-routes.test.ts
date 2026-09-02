import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, expect, it } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { handleCommandRequest } from "./http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { ControlRoomListener } from "./http-listener.js";
import { startControlRoomListener } from "./http-listener.js";
import {
  CAPABILITY,
  authenticator,
  bytes,
  decisionPort,
  envelopeObject,
  recordingHandler,
  registryOf,
} from "./http-test-fixtures.js";
import type { CommandAdapterDeps } from "./http-contract.js";

/**
 * task-82c28bf1afa249319bc376fb8f462bd9 (R3-1).
 *
 * The reviewer's escalation: a scoped ADMIN agent requests pairing, approves its OWN
 * confirmation label over the authenticated HTTP route, claims it, and receives the five
 * operator capabilities for twelve hours. ADMIN is a REACH capability - the vocabulary
 * says so - so an ADMIN-only gate on approval never asked WHO was approving.
 *
 * This arm drives that chain through PRODUCTION surfaces on a real socket: a real store
 * from `createStoreDependencies`, a real `session.open` under the configured operator
 * credential, the provider's own authenticator, and the provider's own session-handshake
 * mint wrapped only by a counter. The http-test-fixtures principal helper is deliberately
 * NOT used here: it hardcodes one principal id and so cannot witness an identity fence.
 *
 * Every downstream fence the chain would otherwise trip is cleared on purpose - valid
 * Host, Origin, CSRF, protocol version, exact body, same project, a live pending label
 * and an unexpired OPEN agent session - so the ONLY thing that can refuse the approve
 * call is the admission this row changes.
 */

const CSRF = "pairing-routes-csrf";
const PROJECT_ID = "proj-pairing-routes";
const OPERATOR_CREDENTIAL = "operator-credential-pairing-routes";
const OPERATOR_PRINCIPAL = "operator-local";
const AGENT_SECRET = "agent-session-credential-pairing-routes";
const CLOCK = (): string => "2026-08-09T12:00:00.000Z";

const HOSTILE_APPROVAL_CASES = Object.freeze([
  "an ADMIN-holding agent session cannot approve its own pairing over HTTP",
] as const);

const executed: string[] = [];

afterAll(() => {
  // A roster that generated nothing would let every assertion below pass by absence.
  expect(executed).toEqual([...HOSTILE_APPROVAL_CASES]);
});

it("pins the hostile approval roster exact, nonzero, and unique", () => {
  expect(HOSTILE_APPROVAL_CASES).toHaveLength(1);
  expect(HOSTILE_APPROVAL_CASES.length).toBeGreaterThan(0);
  expect(new Set(HOSTILE_APPROVAL_CASES).size).toBe(HOSTILE_APPROVAL_CASES.length);
});

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly raw: string;
  readonly status: number;
}

async function post(
  listener: ControlRoomListener, path: string, body: unknown, credential?: string,
): Promise<Reply> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-length": String(Buffer.byteLength(payload)),
    "content-type": "application/json",
    host: `127.0.0.1:${String(listener.port)}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
    ...(credential === undefined ? {} : { "x-moe-session-credential": credential }),
  };
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest(listener.origin + path, { headers, method: "POST" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: (raw === "" ? {} : JSON.parse(raw)) as Readonly<Record<string, unknown>>,
          raw,
          status: response.statusCode ?? 0,
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

function openSessionCount(storePath: string): number {
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    return store.readEvents(`session/${AGENT_SESSION_ID}`).length;
  } finally {
    store.close();
  }
}

const AGENT_SESSION_ID = "session-pairing-routes-agent";

it(HOSTILE_APPROVAL_CASES[0], async () => {
  executed.push(HOSTILE_APPROVAL_CASES[0]);
  const directory = mkdtempSync(join(tmpdir(), "moe-pairing-routes-"));
  const storePath = join(directory, "store.db");
  const setup = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  installTestRecoveryBinding(setup);
  setup.close();

  const provider = createStoreDependencies({
    clock: CLOCK,
    credential: OPERATOR_CREDENTIAL,
    principalId: OPERATOR_PRINCIPAL,
    projectId: PROJECT_ID,
    storePath,
  });
  const logs: string[] = [];
  let listener: ControlRoomListener | null = null;
  try {
    const deps = provider.provide();
    // A REAL agent session: opened through the production command path under the
    // operator credential, exactly as the wrapper opens one for an agent.
    const opened = handleCommandRequest(deps, {
      body: bytes({
        ...envelopeObject({
          commandId: "cmd-session-open-pairing-routes",
          commandKind: "session.open",
          payload: {
            capabilities: [CAPABILITIES.ADMIN, CAPABILITIES.WORK],
            credentialSha256: createHash("sha256").update(AGENT_SECRET, "utf8").digest("hex"),
            // Far future on the REAL clock the authenticator reads: an expired session
            // would be refused by the session authority and this arm would never reach
            // the route it is about.
            expiresAt: "2099-01-01T00:00:00.000Z",
            sessionId: AGENT_SESSION_ID,
          },
          targetAggregateId: `session/${AGENT_SESSION_ID}`,
        }),
        expectedVersion: 0,
        sessionCredential: OPERATOR_CREDENTIAL,
      }),
      credential: OPERATOR_CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "HTTP_LISTENER");
    expect(opened).toMatchObject({
      decision: { resultCode: "EFFECTS_COMMITTED" }, ok: true, outcome: "ACCEPTED",
    });

    const sessionHandshake = provider.sessionHandshake;
    if (sessionHandshake === undefined) throw new Error("the provider wires no handshake");
    const handshake = sessionHandshake();
    let mintCalls = 0;
    listener = await startAgentListener(deps, handshake, () => { mintCalls += 1; }, logs);

    const requested = await post(listener, "/session/pair/request", {});
    expect(requested.status).toBe(200);
    const confirmationLabel = String(requested.body["confirmationLabel"]);
    const requestId = String(requested.body["requestId"]);

    // The escalation attempt: the agent's own credential, everything else valid.
    const approved = await post(
      listener, "/session/pair/approve", { confirmationLabel }, AGENT_SECRET,
    );
    expect(approved.body).toEqual({
      code: "LISTENER_ROUTE_UNKNOWN", layer: "CONTROL_ROOM_LISTENER",
    });

    const claimed = await post(listener, "/session/pair/claim", { requestId });
    expect(claimed.body).toEqual({
      code: "PAIRING_APPROVAL_REQUIRED", layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    });
    expect(mintCalls).toBe(0);

    // Secrets are summarised as BOOLEANS before assertion, so a mutant that leaks one
    // never prints it into the report.
    //
    // The REQUEST reply is the one place the label and request id belong - it is how the
    // browser shows the operator a label to type and how it later names its own claim - so
    // it is checked for credentials and capabilities only. Everything else (the refusals
    // this chain produces, and every log line) must carry none of the six.
    const refusals = `${approved.raw}${claimed.raw}${logs.join("\n")}`;
    expect({
      capabilities: refusals.includes("capabilities"),
      credential: refusals.includes(AGENT_SECRET),
      expiresAt: refusals.includes("expiresAt"),
      label: refusals.includes(confirmationLabel),
      operatorCredential: refusals.includes(OPERATOR_CREDENTIAL),
      requestId: refusals.includes(requestId),
    }).toEqual({
      capabilities: false, credential: false, expiresAt: false, label: false,
      operatorCredential: false, requestId: false,
    });
    expect({
      capabilities: requested.raw.includes("capabilities"),
      credential: requested.raw.includes(AGENT_SECRET),
      expiresAt: requested.raw.includes("expiresAt"),
      operatorCredential: requested.raw.includes(OPERATOR_CREDENTIAL),
      sessionCredential: requested.raw.includes("sessionCredential"),
    }).toEqual({
      capabilities: false, credential: false, expiresAt: false,
      operatorCredential: false, sessionCredential: false,
    });

    // The agent session is exactly the one event session.open wrote: no second OPEN row
    // carrying the operator capability set was minted anywhere in the chain.
    expect(openSessionCount(storePath)).toBe(1);
  } finally {
    if (listener !== null) await listener.close();
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

async function startAgentListener(
  deps: Parameters<typeof handleCommandRequest>[0],
  handshake: SessionHandshakePort,
  onMint: () => void,
  logs: string[],
): Promise<ControlRoomListener> {
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps,
    log: (line) => logs.push(line),
    pairing: {
      boundProjectId: handshake.boundProjectId,
      mint: (...args: Parameters<typeof handshake.mint>) => {
        onMint();
        return handshake.mint(...args);
      },
    },
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  return started;
}

/**
 * THE HANDSHAKE INGRESS, PINNED AT ITS NEW HOME.
 *
 * `serveBootstrap`, `serveSessionPair` and the retired-approve tombstone moved out of
 * `http-listener.ts` into this module. Their guard ORDER is the behaviour, and order is
 * exactly what a per-route arm cannot see unless it drives each guard with every LATER
 * guard also failing - so each case below breaks the guard under test AND everything
 * after it, and passes only if the EARLIER code is the one that answers.
 */

const INGRESS_CSRF = "pairing-ingress-csrf";

function ingressDeps(): CommandAdapterDeps {
  return {
    authenticator: authenticator([CAPABILITY]),
    decisions: decisionPort(),
    registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
  };
}

const ingressPairing: SessionHandshakePort = Object.freeze({
  boundProjectId: PROJECT_ID,
  mint: () => Object.freeze({
    capabilities: Object.freeze(["project.admin"]),
    credential: "credential-ingress",
    expiresAt: "2099-01-01T00:00:00.000Z",
    principalId: "principal-ingress",
    ok: true as const,
  }),
});

interface ProbeInit {
  readonly csrf?: string | null;
  readonly host?: string;
  readonly method?: string;
  readonly origin?: string | null;
  readonly path: string;
  readonly protocolVersion?: string | null;
}

/** Full control of every header the ingress guards read, including omitting them. */
async function probe(listener: ControlRoomListener, init: ProbeInit): Promise<Reply> {
  const headers: Record<string, string> = {
    host: init.host ?? `127.0.0.1:${String(listener.port)}`,
  };
  if (init.origin !== null) headers.origin = init.origin ?? listener.origin;
  if (init.csrf !== null) headers["x-moe-csrf"] = init.csrf ?? INGRESS_CSRF;
  if (init.protocolVersion !== null) {
    headers["x-moe-protocol-version"] = init.protocolVersion ?? WIRE_PROTOCOL_VERSION;
  }
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      listener.origin + init.path,
      { headers, method: init.method ?? "POST" },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          // Defensive on PURPOSE: this probe also fetches the hosted index, which is
          // HTML. A bare JSON.parse throws inside the response handler, the promise
          // never settles, and the arm dies of a 30s timeout instead of reporting what
          // it actually saw. `raw` carries the unparsed bytes for the non-JSON cases.
          let body: Readonly<Record<string, unknown>> = {};
          try {
            const parsed: unknown = raw === "" ? {} : JSON.parse(raw);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              body = parsed as Readonly<Record<string, unknown>>;
            }
          } catch {
            body = {};
          }
          resolve({ body, raw, status: response.statusCode ?? 0 });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function ingressListener(
  overrides: Record<string, unknown> = {},
): Promise<ControlRoomListener> {
  const started = await startControlRoomListener({
    csrfToken: INGRESS_CSRF,
    deps: ingressDeps(),
    log: () => undefined,
    ...overrides,
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  return started;
}

const LISTENER_LAYER = "CONTROL_ROOM_LISTENER";

it("answers /bootstrap Host FIRST, then method, then availability", async () => {
  // NO pairing port, so the availability guard is armed for all three probes: a case that
  // answers HOST or METHOD proves that guard ran BEFORE availability, which is the whole
  // claim. Origin and CSRF are deliberately never sent - bootstrap must stay reachable by
  // a page that does not hold a token yet.
  const unwired = await ingressListener();
  try {
    expect(await probe(unwired, {
      csrf: null, host: "evil.example", method: "POST", origin: null, path: "/bootstrap",
    })).toEqual({
      body: { code: "LISTENER_HOST_INVALID", layer: LISTENER_LAYER },
      raw: JSON.stringify({ code: "LISTENER_HOST_INVALID", layer: LISTENER_LAYER }),
      status: 403,
    });
    expect(await probe(unwired, {
      csrf: null, method: "POST", origin: null, path: "/bootstrap",
    })).toEqual({
      body: { code: "LISTENER_PAIRING_METHOD_INVALID", layer: LISTENER_LAYER },
      raw: JSON.stringify({ code: "LISTENER_PAIRING_METHOD_INVALID", layer: LISTENER_LAYER }),
      status: 405,
    });
    expect(await probe(unwired, {
      csrf: null, method: "GET", origin: null, path: "/bootstrap",
    })).toEqual({
      body: { code: "LISTENER_PAIRING_UNAVAILABLE", layer: LISTENER_LAYER },
      raw: JSON.stringify({ code: "LISTENER_PAIRING_UNAVAILABLE", layer: LISTENER_LAYER }),
      status: 503,
    });
  } finally {
    await unwired.close();
  }
  // THE POSITIVE CONTROL. Without it the three refusals above are equally consistent with
  // a route that refuses everything, and would prove nothing about the order.
  const wired = await ingressListener({ pairing: ingressPairing });
  try {
    const answered = await probe(wired, {
      csrf: null, method: "GET", origin: null, path: "/bootstrap",
    });
    expect(answered.status).toBe(200);
    // The FULL roster, set-equality style. `commandAuthorityPlane` is the fourth field
    // composeBootstrapBody emits (defaulting to "V1" when no plane port is wired); a
    // three-key expectation here would have been a subset check wearing an exactness
    // costume, which is exactly how this arm first went red.
    expect(answered.body).toEqual({
      commandAuthorityPlane: "V1",
      csrfToken: INGRESS_CSRF,
      projectId: PROJECT_ID,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    });
  } finally {
    await wired.close();
  }
});

it("answers /session/pair headers FIRST, then method, then protocol, then the tombstone", async () => {
  const listener = await ingressListener();
  try {
    // Each case breaks its own guard AND every later one (method GET, protocol wrong), so
    // only the EARLIER guard can produce the expected code.
    const cases = [
      [{ host: "evil.example" }, "LISTENER_HOST_INVALID", 403],
      [{ origin: "http://evil.example" }, "LISTENER_ORIGIN_INVALID", 403],
      [{ csrf: "wrong" }, "LISTENER_CSRF_INVALID", 403],
    ] as const;
    for (const [overrides, code, status] of cases) {
      expect(await probe(listener, {
        ...overrides, method: "GET", path: "/session/pair", protocolVersion: "future-wire",
      })).toEqual({
        body: { code, layer: LISTENER_LAYER },
        raw: JSON.stringify({ code, layer: LISTENER_LAYER }),
        status,
      });
    }
    // Headers now clean: method answers ahead of the protocol version.
    expect(await probe(listener, {
      method: "GET", path: "/session/pair", protocolVersion: "future-wire",
    })).toEqual({
      body: { code: "LISTENER_PAIRING_METHOD_INVALID", layer: LISTENER_LAYER },
      raw: JSON.stringify({ code: "LISTENER_PAIRING_METHOD_INVALID", layer: LISTENER_LAYER }),
      status: 405,
    });
    expect(await probe(listener, { path: "/session/pair", protocolVersion: "future-wire" }))
      .toEqual({
        body: { code: "LISTENER_PAIRING_PROTOCOL_UNSUPPORTED", layer: LISTENER_LAYER },
        raw: JSON.stringify({
          code: "LISTENER_PAIRING_PROTOCOL_UNSUPPORTED", layer: LISTENER_LAYER,
        }),
        status: 400,
      });
    // Every guard cleared: the compatibility tombstone itself answers, and it owns no
    // token state, so no path through this route can mint.
    expect(await probe(listener, { path: "/session/pair" })).toEqual({
      body: { code: "LISTENER_PAIRING_UNAVAILABLE", layer: LISTENER_LAYER },
      raw: JSON.stringify({ code: "LISTENER_PAIRING_UNAVAILABLE", layer: LISTENER_LAYER }),
      status: 503,
    });
  } finally {
    await listener.close();
  }
});

it("answers the retired approve path identically whether or not a bundle is hosted", async () => {
  // THE ORDERING CLAIM THAT MATTERS: the tombstone must answer BEFORE the hosted-asset
  // fallback. On an UNHOSTED listener the fallback emits the SAME code at the SAME layer,
  // so an unhosted probe alone can never distinguish "the tombstone answered" from "the
  // fallback answered". A HOSTED listener can - and the served index below proves the
  // asset root really is wired, so the 404 is the tombstone winning the race rather than
  // a root that was never resolved.
  const directory = mkdtempSync(join(tmpdir(), "moe-pairing-ingress-"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>ingress</title>\n", "utf8");
  const hosted = await ingressListener({ assetRoot: directory, pairing: ingressPairing });
  const unhosted = await ingressListener({ pairing: ingressPairing });
  try {
    const servedIndex = await probe(hosted, { method: "GET", path: "/" });
    expect(servedIndex.status).toBe(200);
    expect(servedIndex.raw).toContain("<title>ingress</title>");

    const hostedApprove = await probe(hosted, { path: "/session/pair/approve" });
    expect(hostedApprove).toEqual({
      body: { code: "LISTENER_ROUTE_UNKNOWN", layer: LISTENER_LAYER },
      raw: JSON.stringify({ code: "LISTENER_ROUTE_UNKNOWN", layer: LISTENER_LAYER }),
      status: 404,
    });
    expect(await probe(unhosted, { path: "/session/pair/approve" })).toEqual(hostedApprove);
  } finally {
    await hosted.close();
    await unhosted.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
