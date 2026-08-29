import { request as httpRequest } from "node:http";

import { afterAll, expect, it } from "vitest";

import { CAPABILITIES, OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { readPrincipalRecord } from "../identity/session-authority-store.js";
import {
  createOperatorSessionHandshakePort,
  OPERATOR_PROFILE_REVISION_ID,
} from "../identity/session-handshake.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import {
  closeStores,
  openStore,
  openUnboundStore,
  PROJECT_ID,
} from "../identity/session-test-fixtures.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { ControlRoomListener } from "./http-listener.js";
import { startControlRoomListener } from "./http-listener.js";
import {
  authenticator,
  decisionPort,
  recordingHandler,
  registryOf,
} from "./http-test-fixtures.js";

const CSRF = "pairing-principal-csrf";
const OPERATOR = "operator-pairing-principal";

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
}

interface PairingIdentity {
  readonly confirmationLabel: string;
  readonly requestId: string;
}

afterAll(() => { closeStores(); });

async function post(listener: ControlRoomListener, path: string, body: string): Promise<Reply> {
  const headers = {
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json",
    host: `127.0.0.1:${listener.port}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  return await new Promise((resolve, reject) => {
    const request = httpRequest(listener.origin + path, { headers, method: "POST" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Readonly<Record<string, unknown>>,
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function startPrincipalListener(
  store: ReturnType<typeof openStore>,
  mintSessionId: () => string,
): Promise<ControlRoomListener> {
  const handler = recordingHandler();
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps: {
      authenticator: authenticator([CAPABILITIES.ADMIN]),
      decisions: decisionPort(),
      registry: registryOf("goal.create", handler.handler, ["title"]),
    },
    log: () => undefined,
    pairing: createOperatorSessionHandshakePort({
      capabilities: OPERATOR_CAPABILITIES,
      clock: () => Date.now(),
      mintSessionId,
      operatorPrincipalId: OPERATOR,
      projectId: PROJECT_ID,
      reservedPrincipalIds: [OPERATOR],
      sessionTtlMs: 60_000,
      store,
    }),
    pairingMonotonicNow: () => Date.now(),
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  return started;
}

async function requestPairing(listener: ControlRoomListener): Promise<PairingIdentity> {
  const reply = await post(listener, "/session/pair/request", "{}");
  expect(reply.status).toBe(200);
  const confirmationLabel = reply.body["confirmationLabel"];
  const requestId = reply.body["requestId"];
  if (typeof confirmationLabel !== "string" || typeof requestId !== "string") {
    throw new Error("pairing request omitted its identity");
  }
  return Object.freeze({ confirmationLabel, requestId });
}

it("mints a HUMAN principal and matching authenticating session through the real listener", async () => {
  const store = openStore();
  const sessionId = "session-listener-human";
  const started = await startPrincipalListener(store, () => sessionId);
  try {
    const identity = await requestPairing(started);
    expect(started.approvePairing(identity.confirmationLabel))
      .toEqual({ ok: true, state: "APPROVED" });
    const claimed = await post(started, "/session/pair/claim", JSON.stringify({
      requestId: identity.requestId,
    }));
    expect(claimed.status).toBe(200);
    const credential = claimed.body["sessionCredential"];
    expect(typeof credential).toBe("string");
    if (typeof credential !== "string") throw new Error("claim omitted its credential");
    expect(credential.length).toBeGreaterThan(0);

    const sessions = readSessionLedger(store, PROJECT_ID).sessions;
    expect(sessions.size).toBe(1);
    expect([...sessions.keys()]).toEqual([sessionId]);
    expect(readPrincipalRecord(store, sessionId)).toEqual({
      status: "FOUND",
      principal: {
        principalId: sessionId,
        kind: "HUMAN",
        profileRevisionId: OPERATOR_PROFILE_REVISION_ID,
      },
    });
    const authenticated = createSessionAuthenticator(store, {
      clock: () => Date.now(),
      operatorCapabilities: OPERATOR_CAPABILITIES,
      operatorCredential: "unused",
      operatorPrincipalId: OPERATOR,
      projectId: PROJECT_ID,
    }).authenticate(credential);
    expect(authenticated.verdict).toBe("AUTHENTICATED");
    if (authenticated.verdict === "AUTHENTICATED") {
      expect(authenticated.principal.principalId).toBe(sessionId);
    }
    // No SessionAuthorityOpened: a bearer has no client key; Gate 1 stage E is
    // gated on the fork recorded in comment-b157ddaa.
    expect(createSessionAuthority(store, {
      clock: () => Date.now(), projectId: PROJECT_ID,
    }).readSessionAuthority(sessionId)).toEqual({ status: "ABSENT" });
  } finally {
    await started.close();
  }
});

it("surfaces principal conflicts and releases the approved listener claim for retry", async () => {
  const store = openStore();
  const conflictId = "session-listener-conflict";
  const freshId = "session-listener-after-conflict";
  const authority = createSessionAuthority(store, { clock: () => Date.now(), projectId: PROJECT_ID });
  expect(authority.createPrincipal({
    commandId: "seed-listener-conflict",
    correlationId: "seed-listener-conflict",
    kind: "HUMAN",
    principalId: conflictId,
    profileRevisionId: "seed",
  }).ok).toBe(true);
  const before = readSessionLedger(store, PROJECT_ID).sessions.size;
  let mintCalls = 0;
  const started = await startPrincipalListener(store, () => {
    mintCalls += 1;
    return mintCalls === 1 ? conflictId : freshId;
  });
  try {
    const identity = await requestPairing(started);
    expect(started.approvePairing(identity.confirmationLabel))
      .toEqual({ ok: true, state: "APPROVED" });
    const claimBody = JSON.stringify({ requestId: identity.requestId });
    const refused = await post(started, "/session/pair/claim", claimBody);
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({
      cause: { code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE" },
      code: "PAIRING_SESSION_MINT_FAILED",
      layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    });
    expect(refused.body).not.toHaveProperty("sessionCredential");
    expect(readSessionLedger(store, PROJECT_ID).sessions.size).toBe(before);

    const retried = await post(started, "/session/pair/claim", claimBody);
    expect(retried.status).toBe(200);
    expect(typeof retried.body["sessionCredential"]).toBe("string");
    expect(mintCalls).toBe(2);
  } finally {
    await started.close();
  }
});

it("attributes hostile kind payloads to the exact listener or pairing fence", async () => {
  const store = openStore();
  const started = await startPrincipalListener(store, () => "session-hostile-wire-kind");
  const requestId = "a".repeat(64);
  const kindBody = JSON.stringify({ requestId, kind: "HUMAN" });
  const principalKindBody = JSON.stringify({ requestId, principalKind: "HUMAN" });
  expect(Buffer.byteLength(kindBody)).toBe(95);
  expect(Buffer.byteLength(principalKindBody)).toBe(104);
  try {
    const exactKeyRefusal = await post(started, "/session/pair/claim", kindBody);
    expect(exactKeyRefusal.status).toBe(400);
    expect(exactKeyRefusal.body).toEqual({
      code: "PAIRING_CLAIM_REQUEST_INVALID",
      layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    });

    const listenerRefusal = await post(started, "/session/pair/claim", principalKindBody);
    expect(listenerRefusal.status).toBe(413);
    expect(listenerRefusal.body).toEqual({
      code: "LISTENER_BODY_TOO_LARGE",
      layer: "CONTROL_ROOM_LISTENER",
    });
  } finally {
    await started.close();
  }
});

it("burns the approval when a mint refuses AFTER its principal committed, minting exactly one", async () => {
  // THE CARDINALITY ARM. An unbound store lets `createPrincipal` commit and then
  // makes `session.open` refuse - the one production sequence that leaves a durable
  // HUMAN principal behind a refused claim. Releasing that approval would let the
  // next claim mint a SECOND principal under a fresh id, so it must burn.
  const store = openUnboundStore();
  const mintedIds = ["session-retry-one", "session-retry-two"];
  let mintCalls = 0;
  const started = await startPrincipalListener(store, () => {
    const id = mintedIds[mintCalls] ?? "session-retry-overflow";
    mintCalls += 1;
    return id;
  });
  try {
    const identity = await requestPairing(started);
    expect(started.approvePairing(identity.confirmationLabel))
      .toEqual({ ok: true, state: "APPROVED" });
    const claimBody = JSON.stringify({ requestId: identity.requestId });

    const refused = await post(started, "/session/pair/claim", claimBody);
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({
      cause: { code: "SESSION_RECOVERY_BINDING_UNAVAILABLE", layer: "DAEMON_PREREQUISITE" },
      code: "PAIRING_SESSION_MINT_FAILED",
      layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    });
    expect(refused.body).not.toHaveProperty("sessionCredential");

    const retried = await post(started, "/session/pair/claim", claimBody);
    expect(retried.status).toBe(410);
    expect(retried.body).toEqual({
      code: "PAIRING_REQUEST_ALREADY_CLAIMED",
      layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    });

    // EXACTLY ONE durable HUMAN principal exists for this approval, across both claims.
    expect(mintCalls).toBe(1);
    expect(readPrincipalRecord(store, "session-retry-one")).toEqual({
      status: "FOUND",
      principal: {
        principalId: "session-retry-one",
        kind: "HUMAN",
        profileRevisionId: OPERATOR_PROFILE_REVISION_ID,
      },
    });
    expect(readPrincipalRecord(store, "session-retry-two")).toEqual({ status: "ABSENT" });
    expect(readSessionLedger(store, PROJECT_ID).sessions.size).toBe(0);
  } finally {
    await started.close();
  }
});
