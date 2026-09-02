import { generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest } from "node:http";

import { afterAll, expect, it } from "vitest";

import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { CommandAdapterDeps } from "./http-contract.js";
import {
  PAIRING_CLAIM_PATH,
  PAIRING_REQUEST_PATH,
} from "./pairing-approval-handshake.js";
import { PAIRING_APPROVAL_LAYER } from "./pairing-approval-window.js";
import { PAIRING_OPEN_PATH } from "./pairing-open-completion.js";
import {
  createSessionChallengeOperandsReadPort,
} from "./session-challenge-operands-read.js";
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
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import {
  SESSION_PROOF_ALGORITHM,
  SESSION_PROOF_PROTOCOL_VERSION,
} from "../identity/session-authority-contracts.js";
import {
  canonicalSessionProofBytes,
  sessionAuthorityRequestDigest,
  sessionClientKeyId,
} from "../identity/session-authority-protocol.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { readPrincipalRecord } from "../identity/session-authority-store.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import {
  PROJECT_ID as STORE_PROJECT_ID,
  closeStores,
  openStore,
} from "../identity/session-test-fixtures.js";

afterAll(() => { closeStores(); });

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
        principalId: "principal-pairing-approval-double",
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
    // task-82c28bf1: approval is terminal-only now. The HTTP path is unknown to EVERY
    // caller - with or without a credential - so no capability an agent can hold reaches
    // it, and the operator's own approval below still works through the private seam.
    expect(await post(listener, "/session/pair/approve", { confirmationLabel })).toMatchObject({
      body: { code: "LISTENER_ROUTE_UNKNOWN", layer: "CONTROL_ROOM_LISTENER" },
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
      // The winning claim now names the principal it minted: a browser cannot fold
      // `principalId` into an openSession digest it never learned.
      principalId: "principal-pairing-approval-double",
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

const TRANSPORT_IDS = Object.freeze(["coordination.v1", "terminal.v1"]);

/** A browser's own Ed25519 key, minted here so no daemon code ever holds the secret. */
function clientKey(): {
  readonly clientKeyId: string;
  readonly privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly publicKeySpkiHex: string;
} {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiHex = pair.publicKey.export({ format: "der", type: "spki" }).toString("hex");
  const clientKeyId = sessionClientKeyId(publicKeySpkiHex);
  if (clientKeyId === null) throw new Error("production rejected Node's canonical Ed25519 SPKI");
  return Object.freeze({ clientKeyId, privateKey: pair.privateKey, publicKeySpkiHex });
}

/**
 * R3-1 PROVENANCE, task-82c28bf1, driven end to end over ONE request identity and ONE
 * real store. The retired self-approval is pinned by what the SOCKET answers, not by a
 * comment: the browser-facing `/session/pair/approve` is a tombstone, the claim behind it
 * refuses until the OPERATOR approves in-process, and only the signed open mints the
 * durable authority.
 *
 * The tombstone assertion is deliberately FIRST. Its drill (step 7) grafts the existing
 * operator approval window onto the retired branch so that route can mint; a drill that
 * merely DELETED the branch would fall through to the unhosted asset fallback, which
 * emits the same LISTENER_ROUTE_UNKNOWN at the same layer and would stay green.
 */
it("answers the retired approve route with a tombstone while only in-process approval can mint", async () => {
  const key = clientKey();
  const store = openStore();
  const authority = createSessionAuthority(store, {
    clock: () => Date.now(), projectId: STORE_PROJECT_ID,
  });
  const listener = await startControlRoomListener({
    csrfToken: CSRF,
    deps: deps(),
    log: () => undefined,
    pairing: createOperatorSessionHandshakePort({
      capabilities: OPERATOR_CAPABILITIES,
      clock: () => Date.now(),
      operatorPrincipalId: "operator-r3-1-provenance",
      projectId: STORE_PROJECT_ID,
      reservedPrincipalIds: ["operator-r3-1-provenance"],
      sessionTtlMs: 60_000,
      store,
    }),
    pairingMonotonicNow: () => Date.now(),
    // The SAME store the mint writes into, so step 7 below reads the authority the
    // socket actually created rather than one a fixture handed back.
    pairingOpenSessions: createSessionAuthority(store, {
      clock: () => Date.now(), projectId: STORE_PROJECT_ID,
    }),
    sessionChallengeOperands: createSessionChallengeOperandsReadPort({
      projectId: STORE_PROJECT_ID, store,
    }),
  });
  if (!listener.ok) throw new Error(`listener refused: ${listener.code}`);
  try {
    const requested = await post(listener, PAIRING_REQUEST_PATH, {});
    if (requested.status !== 200) {
      throw new Error(`pairing request refused: ${JSON.stringify(requested.body)}`);
    }
    const requestId = String(requested.body["requestId"]);
    const confirmationLabel = String(requested.body["confirmationLabel"]);

    // 1. THE TOMBSTONE. Exact status, exact code, exact layer, and an EXACT body roster:
    // a route that had minted anything would have to carry a field beyond {code, layer}.
    const tombstone = await post(listener, "/session/pair/approve", { confirmationLabel });
    expect(tombstone.status).toBe(404);
    expect(tombstone.body).toEqual({
      code: "LISTENER_ROUTE_UNKNOWN", layer: CONTROL_ROOM_LISTENER_LAYER,
    });

    // 2. The keyed claim still refuses: the HTTP probe above minted NOTHING.
    const preApproval = await post(listener, PAIRING_CLAIM_PATH, {
      publicKeySpkiHex: key.publicKeySpkiHex, requestId,
    });
    expect(preApproval.status).toBe(409);
    expect(preApproval.body).toEqual({
      code: "PAIRING_APPROVAL_REQUIRED", layer: PAIRING_APPROVAL_LAYER,
    });

    // 3. THE POSITIVE CONTROL. In-process approval works, so step 1's refusal is a
    // statement about the ROUTE and not about a listener that refuses everything.
    expect(listener.approvePairing(confirmationLabel)).toEqual({ ok: true, state: "APPROVED" });

    // 4. The SAME keyed claim now issues the challenge and mints the principal.
    const claimed = await post(listener, PAIRING_CLAIM_PATH, {
      publicKeySpkiHex: key.publicKeySpkiHex, requestId,
    });
    expect(claimed.status).toBe(200);
    const principalId = String(claimed.body["principalId"]);
    const challenge = claimed.body["challenge"] as Record<string, string>;
    expect(Object.keys(challenge).sort())
      .toEqual(["keyEpochRef", "profileRevisionId", "recoveryIncarnationRef"]);
    expect(readPrincipalRecord(store, principalId).status).toBe("FOUND");
    const sessionId = "session-r3-1-provenance";
    // The authority does not exist yet: approval and a claim mint a principal, never a session.
    expect(authority.readSessionAuthority(sessionId)).toEqual({ status: "ABSENT" });

    // 5. THE CLIENT SIGNS what the claim disclosed, through the PRODUCTION digest and
    // canonical-bytes helpers and node:crypto. No daemon code signs anything.
    const credentialId = "credential-r3-1-provenance";
    const commandId = "command-r3-1-provenance";
    const requestDigest = sessionAuthorityRequestDigest({
      kind: "OPEN_SESSION", projectId: STORE_PROJECT_ID, principalId,
      profileRevisionId: challenge["profileRevisionId"]!,
      sessionId, credentialId, generation: 1,
      clientKeyId: key.clientKeyId, publicKeySpkiHex: key.publicKeySpkiHex,
      transportId: TRANSPORT_IDS[0]!, transportIds: TRANSPORT_IDS,
    });
    const issuedAt = Date.now();
    const nonce = "56".repeat(16);
    const signable = canonicalSessionProofBytes({
      principalId, projectId: STORE_PROJECT_ID,
      recoveryIncarnationRef: challenge["recoveryIncarnationRef"]!,
      keyEpochRef: challenge["keyEpochRef"]!,
      sessionId, credentialId, generation: 1,
      clientKeyId: key.clientKeyId, transportId: TRANSPORT_IDS[0]!,
      requestId: commandId, requestDigest, issuedAt, nonce,
    });

    // 6. THE COMPLETION over the raw socket. The reply roster is asserted by
    // SET-EQUALITY, so a route that started leaking a credential back would red here.
    const completed = await post(listener, PAIRING_OPEN_PATH, {
      clientKeyId: key.clientKeyId,
      commandId,
      correlationId: "correlation-r3-1-provenance",
      credentialId,
      principalId,
      proof: {
        algorithm: SESSION_PROOF_ALGORITHM, issuedAt, nonce,
        protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
        signatureHex: sign(null, signable, key.privateKey).toString("hex"),
      },
      publicKeySpkiHex: key.publicKeySpkiHex,
      requestDigest,
      sessionId,
      transportId: TRANSPORT_IDS[0]!,
      transportIds: TRANSPORT_IDS,
    });
    expect(completed.status).toBe(200);
    // The WIRE roster, not the port's: the completion port answers {ok, sessionId} and
    // the route stamps `protocolVersion` onto it (http-listener-pairing-routes.ts:101).
    // Asserting the port's roster here would have been a subset check wearing an
    // exactness costume.
    expect(Object.keys(completed.body).sort()).toEqual(["ok", "protocolVersion", "sessionId"]);
    expect(completed.body).toEqual({
      ok: true, protocolVersion: WIRE_PROTOCOL_VERSION, sessionId,
    });

    // 7. The durable authority is FOUND in the SAME store the listener was wired with,
    // bound to the key the browser proved possession of.
    const opened = authority.readSessionAuthority(sessionId);
    expect(opened.status).toBe("FOUND");
    if (opened.status !== "FOUND") throw new Error("unreachable");
    expect(opened.authority.publicKey.clientKeyId).toBe(key.clientKeyId);
    expect(opened.authority.principal.principalId).toBe(principalId);
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
