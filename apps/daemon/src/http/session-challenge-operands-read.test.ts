import { generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest } from "node:http";

import type { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import {
  SESSION_PROOF_ALGORITHM, SESSION_PROOF_PROTOCOL_VERSION,
} from "../identity/session-authority-contracts.js";
import {
  canonicalSessionProofBytes, sessionAuthorityRequestDigest, sessionClientKeyId,
} from "../identity/session-authority-protocol.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import {
  PROJECT_ID, TEST_RECOVERY_INCARNATION_REF, TEST_RECOVERY_KEY_EPOCH_REF, closeStores, openStore,
  openUnboundStore,
} from "../identity/session-test-fixtures.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type {
  AuthenticationResult, Authenticator, CommandAdapterDeps,
} from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import {
  SESSION_CHALLENGE_OPERANDS_READ_CODES, SESSION_CHALLENGE_OPERANDS_READ_PATH,
  SESSION_CHALLENGE_OPERAND_KEYS,
  createSessionChallengeOperandsReadPort, handleSessionChallengeOperandsReadRequest,
} from "./session-challenge-operands-read.js";
import type {
  SessionChallengeOperandKey, SessionChallengeOperandsReadPort,
} from "./session-challenge-operands-read.js";

/**
 * task-c338dd23: the three store-held operands `openSession` verifies a client
 * signature against, published on an AUTHENTICATED read so a browser can sign
 * before it calls.
 *
 * Every arm asserts the exact stable code AND the refusing layer. `READ_LAYER`
 * is spelled here rather than imported because the production constant is
 * deliberately module-private: exporting a `*_LAYER` enrols the module in the
 * boundary roster and its coverage arms.
 */

/**
 * The operand roster's denominator, spelled out INDEPENDENTLY of the production
 * constant. Every arm that grades the roster compares against this, so deleting
 * a member cannot shrink the expectation along with the subject.
 */
const EXPECTED_OPERAND_KEYS = Object.freeze(
  ["keyEpochRef", "profileRevisionId", "recoveryIncarnationRef"],
);

const READ_LAYER = "SESSION_CHALLENGE_OPERANDS_READ";
const PRINCIPAL = "principal-challenge-operands-1";
const PROFILE_REVISION = "profile-revision-challenge-operands-1";
const FOREIGN_PROJECT = "project-challenge-operands-foreign";
const NOW = Date.parse("2026-08-30T05:00:00.000Z");

const encoder = new TextEncoder();

function body(value: Readonly<Record<string, unknown>>): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function authenticatorFor(result: AuthenticationResult): Authenticator {
  return Object.freeze({ authenticate: (): AuthenticationResult => result });
}

function authenticatedAs(projectId: string, capabilities: readonly string[]): Authenticator {
  return authenticatorFor({
    principal: Object.freeze({ capabilities, principalId: PRINCIPAL, projectId }),
    verdict: "AUTHENTICATED",
  });
}

/** A store that fails the test if any read reaches it: the "before any store read" witness. */
function untouchableStore(): SqliteEventStore {
  return new Proxy({} as SqliteEventStore, {
    get(_target, property): never {
      throw new Error(`the store was read (property ${String(property)}) before the guards ran`);
    },
  });
}

function seedPrincipal(store: SqliteEventStore, suffix: string): void {
  const authority = createSessionAuthority(store, { clock: () => NOW, projectId: PROJECT_ID });
  const created = authority.createPrincipal({
    commandId: `command-challenge-operands-${suffix}`,
    correlationId: `correlation-challenge-operands-${suffix}`,
    kind: "HUMAN",
    principalId: PRINCIPAL,
    profileRevisionId: PROFILE_REVISION,
  });
  if (!created.ok) throw new Error(`principal seed failed: ${created.code}`);
}

function seededStore(): SqliteEventStore {
  const store = openStore();
  seedPrincipal(store, "1");
  return store;
}

function portFor(store: SqliteEventStore): SessionChallengeOperandsReadPort {
  return createSessionChallengeOperandsReadPort({ projectId: PROJECT_ID, store });
}

function readWith(
  authenticator: Authenticator, port: SessionChallengeOperandsReadPort, requestBody: Uint8Array,
): ReturnType<typeof handleSessionChallengeOperandsReadRequest> {
  return handleSessionChallengeOperandsReadRequest(
    { authenticator, sessionChallengeOperands: port },
    { body: requestBody, credential: "credential", protocolVersion: WIRE_PROTOCOL_VERSION },
  );
}

describe("session challenge operands read", () => {
  it("refuses an unauthenticated caller with the seam's own code and layer", () => {
    const dispatch = readWith(
      authenticatorFor({ verdict: "UNAUTHENTICATED" }), portFor(untouchableStore()), body({}),
    );
    expect(dispatch.kind).toBe("REPLY");
    if (dispatch.kind !== "REPLY") throw new Error("unreachable");
    expect(dispatch.body).toMatchObject({ ok: false, stage: "AUTHENTICATE" });
  });

  it("refuses a caller without the capability, naming the code and this route's layer", () => {
    const dispatch = readWith(
      authenticatedAs(PROJECT_ID, []), portFor(untouchableStore()), body({}),
    );
    expect(dispatch.kind).toBe("REPLY");
    if (dispatch.kind !== "REPLY") throw new Error("unreachable");
    expect(dispatch.body).toStrictEqual({
      code: "SESSION_CHALLENGE_OPERANDS_CAPABILITY_DENIED",
      layer: READ_LAYER,
      outcome: "REFUSED",
    });
  });

  it("refuses a foreign-project principal BEFORE any store read", () => {
    const dispatch = readWith(
      authenticatedAs(FOREIGN_PROJECT, [CAPABILITIES.GOAL]), portFor(untouchableStore()), body({}),
    );
    expect(dispatch.kind).toBe("REPLY");
    if (dispatch.kind !== "REPLY") throw new Error("unreachable");
    expect(dispatch.body).toStrictEqual({
      code: "SESSION_CHALLENGE_OPERANDS_PROJECT_MISMATCH",
      layer: READ_LAYER,
      outcome: "REFUSED",
    });
  });

  it("answers a body carrying any unexpected key as a transport refusal", () => {
    const store = seededStore();
    const dispatch = readWith(
      authenticatedAs(PROJECT_ID, [CAPABILITIES.GOAL]), portFor(store), body({ unexpected: 1 }),
    );
    expect(dispatch).toStrictEqual({
      code: "LISTENER_SESSION_CHALLENGE_OPERANDS_REQUEST_INVALID",
      kind: "LISTENER_REFUSAL",
    });
    closeStores();
  });

  it("refuses when the daemon was composed without the port", () => {
    const dispatch = handleSessionChallengeOperandsReadRequest(
      { authenticator: authenticatedAs(PROJECT_ID, [CAPABILITIES.GOAL]) },
      { body: body({}), credential: "credential", protocolVersion: WIRE_PROTOCOL_VERSION },
    );
    expect(dispatch).toStrictEqual({
      code: "LISTENER_SESSION_CHALLENGE_OPERANDS_UNAVAILABLE",
      kind: "LISTENER_REFUSAL",
    });
  });

  it("publishes exactly the three operands and nothing else", () => {
    const store = seededStore();
    const dispatch = readWith(
      authenticatedAs(PROJECT_ID, [CAPABILITIES.GOAL]), portFor(store), body({}),
    );
    expect(dispatch.kind).toBe("REPLY");
    if (dispatch.kind !== "REPLY") throw new Error("unreachable");
    const answer = dispatch.body as {
      readonly operands: Record<string, unknown>; readonly outcome: string;
    };
    expect(answer.outcome).toBe("OPERANDS");
    // Compared against the LITERAL expectation, never against the roster this
    // arm exists to grade: `keys(response) === keys(roster)` moves on BOTH
    // sides when a member is deleted and stays green while a key vanishes.
    expect(Object.keys(answer.operands).sort()).toStrictEqual(EXPECTED_OPERAND_KEYS);
    expect(answer.operands).toStrictEqual({
      keyEpochRef: TEST_RECOVERY_KEY_EPOCH_REF,
      profileRevisionId: PROFILE_REVISION,
      recoveryIncarnationRef: TEST_RECOVERY_INCARNATION_REF,
    });
    closeStores();
  });

  it("refuses when the authenticated principal has no durable record", () => {
    const store = openStore();
    const dispatch = readWith(
      authenticatedAs(PROJECT_ID, [CAPABILITIES.GOAL]), portFor(store), body({}),
    );
    expect(dispatch.kind).toBe("REPLY");
    if (dispatch.kind !== "REPLY") throw new Error("unreachable");
    expect(dispatch.body).toStrictEqual({
      code: "SESSION_CHALLENGE_OPERANDS_PRINCIPAL_ABSENT",
      layer: READ_LAYER,
      outcome: "REFUSED",
    });
    closeStores();
  });

  it("refuses when the project has no active recovery binding", () => {
    const store = openUnboundStore();
    seedPrincipal(store, "2");
    const dispatch = readWith(
      authenticatedAs(PROJECT_ID, [CAPABILITIES.GOAL]), portFor(store), body({}),
    );
    expect(dispatch.kind).toBe("REPLY");
    if (dispatch.kind !== "REPLY") throw new Error("unreachable");
    expect(dispatch.body).toStrictEqual({
      code: "SESSION_CHALLENGE_OPERANDS_RECOVERY_BINDING_ABSENT",
      layer: READ_LAYER,
      outcome: "REFUSED",
    });
    closeStores();
  });

  it("sweeps every operand, and the sweep is proven non-empty", () => {
    expect(SESSION_CHALLENGE_OPERAND_KEYS).toHaveLength(EXPECTED_OPERAND_KEYS.length);
    const store = seededStore();
    const port = portFor(store);
    const observed = SESSION_CHALLENGE_OPERAND_KEYS.map((operand) => {
      const dispatch = readWith(
        authenticatedAs(PROJECT_ID, [CAPABILITIES.GOAL]), port, body({ [operand]: "ff".repeat(32) }),
      );
      if (dispatch.kind !== "REPLY") throw new Error(`${operand} was not answered with a REPLY`);
      return dispatch.body;
    });
    expect(observed).toHaveLength(SESSION_CHALLENGE_OPERAND_KEYS.length);
    for (const answer of observed) {
      expect(answer).toStrictEqual({
        code: "SESSION_CHALLENGE_OPERANDS_CALLER_SUPPLIED",
        layer: READ_LAYER,
        outcome: "REFUSED",
      });
    }
    closeStores();
  });

  it("gives a caller-supplied operand its OWN code, not the generic transport refusal", () => {
    const store = seededStore();
    const dispatch = readWith(
      authenticatedAs(PROJECT_ID, [CAPABILITIES.GOAL]), portFor(store),
      body({ profileRevisionId: PROFILE_REVISION, unexpected: 1 }),
    );
    expect(dispatch.kind).toBe("REPLY");
    if (dispatch.kind !== "REPLY") throw new Error("unreachable");
    expect(dispatch.body).toStrictEqual({
      code: "SESSION_CHALLENGE_OPERANDS_CALLER_SUPPLIED",
      layer: READ_LAYER,
      outcome: "REFUSED",
    });
    closeStores();
  });

  it("pins the operand roster denominator against a literal expectation", () => {
    expect(SESSION_CHALLENGE_OPERAND_KEYS).toHaveLength(EXPECTED_OPERAND_KEYS.length);
    expect([...SESSION_CHALLENGE_OPERAND_KEYS].sort()).toStrictEqual(EXPECTED_OPERAND_KEYS);
  });

  it("pins the route-local code roster so deleting an arm cannot shrink it silently", () => {
    expect(SESSION_CHALLENGE_OPERANDS_READ_CODES).toHaveLength(5);
    expect([...SESSION_CHALLENGE_OPERANDS_READ_CODES]).toStrictEqual([
      "SESSION_CHALLENGE_OPERANDS_CALLER_SUPPLIED",
      "SESSION_CHALLENGE_OPERANDS_CAPABILITY_DENIED",
      "SESSION_CHALLENGE_OPERANDS_PRINCIPAL_ABSENT",
      "SESSION_CHALLENGE_OPERANDS_PROJECT_MISMATCH",
      "SESSION_CHALLENGE_OPERANDS_RECOVERY_BINDING_ABSENT",
    ]);
  });
});


/**
 * REACHABILITY. A port that exists but is never registered satisfies every
 * existence grep while the feature does not exist, so these arms drive the real
 * `startControlRoomListener` over a real socket rather than calling the handler.
 */
const CSRF = "csrf-session-challenge-operands";
const CREDENTIAL = "credential-session-challenge-operands";

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
}

const listeners: ControlRoomListener[] = [];

async function startListener(port?: SessionChallengeOperandsReadPort): Promise<ControlRoomListener> {
  const deps = {
    authenticator: authenticatedAs(PROJECT_ID, [CAPABILITIES.GOAL]),
    decisions: {
      decide: (): never => {
        throw new Error("the operands read entered the decision port");
      },
    },
    registry: {
      get: (): never => {
        throw new Error("the operands read entered the command registry");
      },
    },
  } as unknown as CommandAdapterDeps;
  const started = await startControlRoomListener({
    csrfToken: CSRF, deps,
    ...(port === undefined ? {} : { sessionChallengeOperands: port }),
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  listeners.push(started);
  return started;
}

async function post(
  listener: ControlRoomListener, payload: string, method = "POST",
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-length": String(Buffer.byteLength(payload)),
    "content-type": "application/json",
    host: `127.0.0.1:${String(listener.port)}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
    "x-moe-session-credential": CREDENTIAL,
  };
  return await new Promise((resolve, reject) => {
    const outbound = httpRequest(
      listener.origin + SESSION_CHALLENGE_OPERANDS_READ_PATH, { headers, method }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: (text === "" ? {} : JSON.parse(text)) as Readonly<Record<string, unknown>>,
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    outbound.on("error", reject);
    outbound.end(payload);
  });
}

describe("session challenge operands route reachability", () => {
  afterAll(async () => {
    for (const listener of listeners.splice(0)) await listener.close();
    closeStores();
  });

  it("answers the operands over a real socket at its registered path", async () => {
    const listener = await startListener(portFor(seededStore()));
    const reply = await post(listener, JSON.stringify({}));
    expect(reply.status).toBe(200);
    expect(reply.body["outcome"]).toBe("OPERANDS");
    expect(reply.body["operands"]).toStrictEqual({
      keyEpochRef: TEST_RECOVERY_KEY_EPOCH_REF,
      profileRevisionId: PROFILE_REVISION,
      recoveryIncarnationRef: TEST_RECOVERY_INCARNATION_REF,
    });
  });

  it("refuses a non-POST at the registered path with the listener's transport code", async () => {
    const listener = await startListener(portFor(seededStore()));
    const reply = await post(listener, "", "GET");
    expect(reply.status).toBe(400);
    expect(reply.body["code"]).toBe("LISTENER_SESSION_CHALLENGE_OPERANDS_REQUEST_INVALID");
  });

  it("answers UNAVAILABLE when the daemon is composed without the port", async () => {
    const listener = await startListener();
    const reply = await post(listener, JSON.stringify({}));
    expect(reply.status).toBe(503);
    expect(reply.body["code"]).toBe("LISTENER_SESSION_CHALLENGE_OPERANDS_UNAVAILABLE");
  });
});


/**
 * DoD 4. The claim "these are the operands `openSession` verifies against" is
 * only worth what its FALSIFIER is worth, so both arms below drive the real
 * `openSession` with values taken from the ROUTE's answer, never from the
 * fixture constants, and the second one perturbs a single published operand.
 * The challenge is built by the production `canonicalSessionProofBytes` and the
 * digest by the production `sessionAuthorityRequestDigest`; nothing here
 * reimplements either.
 */
const TRANSPORT_IDS = Object.freeze(["coordination.v1", "terminal.v1"]);

function publishedOperands(
  store: SqliteEventStore,
): Readonly<Record<string, string>> {
  const dispatch = readWith(
    authenticatedAs(PROJECT_ID, [CAPABILITIES.GOAL]), portFor(store), body({}),
  );
  if (dispatch.kind !== "REPLY") throw new Error("the route did not reply");
  const answer = dispatch.body as { readonly operands?: Readonly<Record<string, string>> };
  if (answer.operands === undefined) throw new Error("the route published no operands");
  return answer.operands;
}

function openSessionWith(
  store: SqliteEventStore, operands: Readonly<Record<string, string>>, suffix: string,
): ReturnType<ReturnType<typeof createSessionAuthority>["openSession"]> {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiHex = pair.publicKey.export({ format: "der", type: "spki" }).toString("hex");
  const clientKeyId = sessionClientKeyId(publicKeySpkiHex);
  if (clientKeyId === null) throw new Error("production rejected Node's canonical Ed25519 SPKI");
  const facts = {
    commandId: `command-identity-${suffix}`,
    correlationId: `correlation-identity-${suffix}`,
    credentialId: `credential-identity-${suffix}`,
    sessionId: `session-identity-${suffix}`,
    transportId: TRANSPORT_IDS[0]!,
    transportIds: TRANSPORT_IDS,
  };
  const requestDigest = sessionAuthorityRequestDigest({
    kind: "OPEN_SESSION", projectId: PROJECT_ID, principalId: PRINCIPAL,
    profileRevisionId: operands["profileRevisionId"],
    sessionId: facts.sessionId, credentialId: facts.credentialId, generation: 1,
    clientKeyId, publicKeySpkiHex,
    transportId: facts.transportId, transportIds: facts.transportIds,
  });
  const issuedAt = NOW;
  const nonce = "12".repeat(16);
  const challenge = canonicalSessionProofBytes({
    principalId: PRINCIPAL, projectId: PROJECT_ID,
    recoveryIncarnationRef: operands["recoveryIncarnationRef"] ?? "",
    keyEpochRef: operands["keyEpochRef"] ?? "",
    sessionId: facts.sessionId, credentialId: facts.credentialId, generation: 1,
    clientKeyId, transportId: facts.transportId, requestId: facts.commandId,
    requestDigest, issuedAt, nonce,
  });
  const authority = createSessionAuthority(store, { clock: () => NOW, projectId: PROJECT_ID });
  return authority.openSession({
    ...facts, principalId: PRINCIPAL, publicKeySpkiHex, clientKeyId, requestDigest,
    proof: {
      protocolVersion: SESSION_PROOF_PROTOCOL_VERSION, algorithm: SESSION_PROOF_ALGORITHM,
      issuedAt, nonce, signatureHex: sign(null, challenge, pair.privateKey).toString("hex"),
    },
  });
}

/**
 * The layer each perturbation must reach, which is a claim about MECHANISM, not
 * a wildcard. `profileRevisionId` is folded into `sessionAuthorityRequestDigest`,
 * which `openSession` recomputes from the durable principal and compares, so a
 * wrong one dies at BINDING. The two recovery refs are only in the signed
 * challenge, so a wrong one survives the digest compare and dies at PROOF when
 * the signature is verified. A single regex over both would pass even if a
 * perturbation started failing for the wrong reason.
 */
const PERTURBATION_LAYERS: Readonly<Record<SessionChallengeOperandKey, string>> = Object.freeze({
  keyEpochRef: "PROOF",
  profileRevisionId: "BINDING",
  recoveryIncarnationRef: "PROOF",
});

describe("published operands are the ones openSession verifies against", () => {
  it("opens a session signed with NOTHING but what the route published", () => {
    const store = seededStore();
    const opened = openSessionWith(store, publishedOperands(store), "exact");
    expect(opened).toMatchObject({ ok: true, disposition: "DECIDED" });
    closeStores();
  });

  it("refuses when ONE published operand is perturbed, at the layer that owns it", () => {
    expect(SESSION_CHALLENGE_OPERAND_KEYS).toHaveLength(EXPECTED_OPERAND_KEYS.length);
    expect(Object.keys(PERTURBATION_LAYERS).sort())
      .toStrictEqual([...SESSION_CHALLENGE_OPERAND_KEYS].sort());
    const store = seededStore();
    const published = publishedOperands(store);
    const outcomes = SESSION_CHALLENGE_OPERAND_KEYS.map((operand, index) => {
      const perturbed = { ...published, [operand]: "ab".repeat(32) };
      return Object.freeze({
        operand, result: openSessionWith(store, perturbed, `perturbed-${String(index)}`),
      });
    });
    expect(outcomes).toHaveLength(SESSION_CHALLENGE_OPERAND_KEYS.length);
    for (const { operand, result } of outcomes) {
      expect(result).toStrictEqual({
        ok: false, code: "AUTHENTICATION_FAILED", layer: PERTURBATION_LAYERS[operand],
      });
    }
    closeStores();
  });
});
