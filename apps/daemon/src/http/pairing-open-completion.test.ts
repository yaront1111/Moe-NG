import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { afterAll, expect, it } from "vitest";

import { CAPABILITIES, OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import {
  SESSION_PROOF_ALGORITHM, SESSION_PROOF_PROTOCOL_VERSION,
} from "../identity/session-authority-contracts.js";
import {
  canonicalSessionProofBytes, sessionAuthorityRequestDigest, sessionClientKeyId,
} from "../identity/session-authority-protocol.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { readPrincipalRecord } from "../identity/session-authority-store.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import {
  PROJECT_ID, TEST_RECOVERY_INCARNATION_REF, TEST_RECOVERY_KEY_EPOCH_REF,
  closeStores, openStore,
} from "../identity/session-test-fixtures.js";
import { createPairingApprovalHandshake } from "./pairing-approval-handshake.js";
import type { PairingClaimed } from "./pairing-approval-handshake.js";
import { createPairingApprovalWindow } from "./pairing-approval-window.js";
import {
  PAIRING_OPEN_KEYS, PAIRING_OPEN_MAX_BODY_BYTES, PAIRING_OPEN_PATH,
  PAIRING_OPEN_REFUSAL_CODES, createPairingOpenCompletion,
} from "./pairing-open-completion.js";
import {
  createSessionChallengeOperandsReadPort,
} from "./session-challenge-operands-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import {
  authenticator, decisionPort, recordingHandler, registryOf,
} from "./http-test-fixtures.js";

/**
 * THE OPEN COMPLETION (ruling `comment-d3a24ac8`, steps 4-5).
 *
 * Every arm drives the REAL seam over one real store: the production pairing claim mints
 * the principal and discloses the challenge, a test Ed25519 key signs it exactly as a
 * browser would using the exported protocol helpers, and the completion composes the
 * production `openSession`. No daemon edit signs anything, and no double stands in for
 * the verifier.
 */
const NOW = Date.parse("2026-08-30T06:00:00.000Z");
const TRANSPORT_IDS = Object.freeze(["coordination.v1", "terminal.v1"]);
const OPEN_LAYER = "CONTROL_ROOM_PAIRING_OPEN";
const encoder = new TextEncoder();
const bytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

afterAll(() => { closeStores(); });

interface ClientKey {
  readonly clientKeyId: string;
  readonly privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly publicKeySpkiHex: string;
}

function clientKey(): ClientKey {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiHex = pair.publicKey.export({ format: "der", type: "spki" }).toString("hex");
  const clientKeyId = sessionClientKeyId(publicKeySpkiHex);
  if (clientKeyId === null) throw new Error("production rejected Node's canonical Ed25519 SPKI");
  return Object.freeze({ clientKeyId, privateKey: pair.privateKey, publicKeySpkiHex });
}

interface Seam {
  readonly authority: ReturnType<typeof createSessionAuthority>;
  readonly claimed: PairingClaimed;
  readonly completion: ReturnType<typeof createPairingOpenCompletion>;
  readonly store: ReturnType<typeof openStore>;
}

/** Runs one request -> approve -> key-bearing claim, then hands back the wired completion. */
function pairedSeam(key: ClientKey): Seam {
  const store = openStore();
  const window = createPairingApprovalWindow();
  const pairing = createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => NOW,
    operatorPrincipalId: "principal-operator-open-completion",
    projectId: PROJECT_ID,
    sessionTtlMs: 60_000,
    store,
  });
  const handshake = createPairingApprovalHandshake(
    window.requests, pairing,
    createSessionChallengeOperandsReadPort({ projectId: PROJECT_ID, store }),
  );
  const request = handshake.request(encoder.encode("{}"));
  if (!request.ok) throw new Error(`pairing request refused: ${request.code}`);
  if (!window.operator.approve(request.confirmationLabel).ok) {
    throw new Error("operator approval refused");
  }
  const claimed = handshake.claim(bytes({
    publicKeySpkiHex: key.publicKeySpkiHex, requestId: request.requestId,
  }));
  if (!claimed.ok) throw new Error(`claim refused: ${claimed.code}`);
  return Object.freeze({
    authority: createSessionAuthority(store, { clock: () => NOW, projectId: PROJECT_ID }),
    claimed,
    completion: createPairingOpenCompletion(
      createSessionAuthority(store, { clock: () => NOW, projectId: PROJECT_ID }),
    ),
    store,
  });
}

/**
 * Builds the signed open payload a browser would send, from the challenge the CLAIM
 * disclosed — not from constants. If the claim ever stopped issuing a usable challenge,
 * every arm below would fail rather than silently signing over the right values anyway.
 */
function signedOpen(seam: Seam, key: ClientKey, overrides: Record<string, unknown> = {}): {
  readonly payload: Record<string, unknown>;
  readonly sessionId: string;
} {
  const challenge = seam.claimed.challenge;
  if (challenge === undefined) throw new Error("the approved claim issued no challenge");
  const sessionId = `session-open-${String(overrides["nonceSeed"] ?? "one")}`;
  const credentialId = "credential-open-completion";
  const commandId = "command-open-completion";
  const requestDigest = sessionAuthorityRequestDigest({
    kind: "OPEN_SESSION",
    projectId: PROJECT_ID,
    principalId: seam.claimed.principalId,
    profileRevisionId: challenge.profileRevisionId,
    sessionId,
    credentialId,
    generation: 1,
    clientKeyId: key.clientKeyId,
    publicKeySpkiHex: key.publicKeySpkiHex,
    transportId: TRANSPORT_IDS[0]!,
    transportIds: TRANSPORT_IDS,
  });
  const issuedAt = NOW;
  const nonce = "12".repeat(16);
  const signable = canonicalSessionProofBytes({
    principalId: seam.claimed.principalId,
    projectId: PROJECT_ID,
    recoveryIncarnationRef: challenge.recoveryIncarnationRef,
    keyEpochRef: challenge.keyEpochRef,
    sessionId,
    credentialId,
    generation: 1,
    clientKeyId: key.clientKeyId,
    transportId: TRANSPORT_IDS[0]!,
    requestId: commandId,
    requestDigest: String(overrides["requestDigest"] ?? requestDigest),
    issuedAt,
    nonce,
  });
  const signer = (overrides["signWith"] as ClientKey | undefined) ?? key;
  return {
    payload: {
      clientKeyId: key.clientKeyId,
      commandId,
      correlationId: "correlation-open-completion",
      credentialId,
      principalId: seam.claimed.principalId,
      proof: {
        algorithm: SESSION_PROOF_ALGORITHM,
        issuedAt,
        nonce,
        protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
        signatureHex: sign(null, signable, signer.privateKey).toString("hex"),
      },
      publicKeySpkiHex: key.publicKeySpkiHex,
      requestDigest: String(overrides["requestDigest"] ?? requestDigest),
      sessionId,
      transportId: TRANSPORT_IDS[0]!,
      transportIds: TRANSPORT_IDS,
    },
    sessionId,
  };
}

it("HAPPY PATH: a claim-disclosed challenge, signed in the client, opens the authority", () => {
  const key = clientKey();
  const seam = pairedSeam(key);
  // The signature below is computed over the scalars the CLAIM disclosed. Pinning them
  // to the fixture's durable binding is what proves the loop closed on real store
  // values: a challenge of plausible-looking constants would open nothing, but it would
  // also not be caught by any assertion that only reads it back from itself.
  expect(seam.claimed.challenge?.recoveryIncarnationRef).toBe(TEST_RECOVERY_INCARNATION_REF);
  expect(seam.claimed.challenge?.keyEpochRef).toBe(TEST_RECOVERY_KEY_EPOCH_REF);
  // The authority does not exist yet: the claim minted a principal and nothing else.
  expect(seam.authority.readSessionAuthority(signedOpen(seam, key).sessionId))
    .toEqual({ status: "ABSENT" });

  const { payload, sessionId } = signedOpen(seam, key);
  expect(seam.completion.complete(bytes(payload))).toEqual({ ok: true, sessionId });

  const opened = seam.authority.readSessionAuthority(sessionId);
  expect(opened.status).toBe("FOUND");
  // Bound to the key the browser proved possession of, not merely to the claim.
  if (opened.status !== "FOUND") throw new Error("unreachable");
  expect(opened.authority.publicKey.clientKeyId).toBe(key.clientKeyId);
});

it("WRONG KEY: the authority's PROOF refusal travels out verbatim, unrestamped", () => {
  const key = clientKey();
  const seam = pairedSeam(key);
  const { payload, sessionId } = signedOpen(seam, key, { signWith: clientKey() });

  const refused = seam.completion.complete(bytes(payload));
  // The refusing layer is the AUTHORITY's, never this route's: a restamped code would
  // read CONTROL_ROOM_PAIRING_OPEN here and tell a caller nothing about which fence ran.
  expect(refused).toEqual({ code: "AUTHENTICATION_FAILED", layer: "PROOF", ok: false });
  expect((refused as { readonly layer: string }).layer).not.toBe(OPEN_LAYER);
  expect(seam.authority.readSessionAuthority(sessionId)).toEqual({ status: "ABSENT" });
});

it("TAMPERED DIGEST: the BINDING refusal travels out verbatim and mints nothing", () => {
  const key = clientKey();
  const seam = pairedSeam(key);
  const { payload, sessionId } = signedOpen(seam, key, { requestDigest: "0".repeat(64) });

  expect(seam.completion.complete(bytes(payload)))
    .toEqual({ code: "AUTHENTICATION_FAILED", layer: "BINDING", ok: false });
  expect(seam.authority.readSessionAuthority(sessionId)).toEqual({ status: "ABSENT" });
});

it("REPLAY is IDEMPOTENT at the authority, and mints no second authority", () => {
  // MEASURED, not assumed: openSession answers an exact re-presentation from its replay
  // marker rather than refusing. That is the authority's call and the safe one, so this
  // route must not convert it into a refusal of its own — a route that refused here
  // would make a dropped response unrecoverable for an honest client.
  const key = clientKey();
  const seam = pairedSeam(key);
  const { payload, sessionId } = signedOpen(seam, key);

  expect(seam.completion.complete(bytes(payload))).toEqual({ ok: true, sessionId });
  expect(seam.completion.complete(bytes(payload))).toEqual({ ok: true, sessionId });

  const opened = seam.authority.readSessionAuthority(sessionId);
  expect(opened.status).toBe("FOUND");
  if (opened.status !== "FOUND") throw new Error("unreachable");
  // ONE authority at its FIRST version: a second durable open would have advanced it.
  expect(opened.authority.version).toBe(1);
  expect(opened.authority.publicKey.clientKeyId).toBe(key.clientKeyId);
});

it("SHAPE ONLY: a body missing one roster key is refused here, before the authority", () => {
  const key = clientKey();
  const seam = pairedSeam(key);
  const { payload, sessionId } = signedOpen(seam, key);
  const { transportId: _dropped, ...missing } = payload;

  expect(seam.completion.complete(bytes(missing)))
    .toEqual({ code: "PAIRING_OPEN_REQUEST_INVALID", layer: OPEN_LAYER, ok: false });
  // An extra key is refused too: the roster is exact in both directions.
  expect(seam.completion.complete(bytes({ ...payload, extra: "x" })))
    .toEqual({ code: "PAIRING_OPEN_REQUEST_INVALID", layer: OPEN_LAYER, ok: false });
  expect(seam.authority.readSessionAuthority(sessionId)).toEqual({ status: "ABSENT" });
});

it("BODY CAP: an oversized body is refused by size, not parsed", () => {
  const key = clientKey();
  const seam = pairedSeam(key);
  const oversized = new Uint8Array(PAIRING_OPEN_MAX_BODY_BYTES + 1);

  expect(seam.completion.complete(oversized))
    .toEqual({ code: "PAIRING_OPEN_BODY_TOO_LARGE", layer: OPEN_LAYER, ok: false });
  // And the cap admits the real payload with room to spare, so it is a bound and not a
  // second refusal path for legitimate traffic.
  expect(bytes(signedOpen(seam, key).payload).byteLength)
    .toBeLessThan(PAIRING_OPEN_MAX_BODY_BYTES);
});

it("keeps the roster identical to openSession's OPEN_KEYS", () => {
  // Two exact-arity rosters, one on each side of the compose. If they drift, this route
  // accepts a body the authority will reject, or rejects one it would have read.
  expect([...PAIRING_OPEN_KEYS].sort()).toEqual([
    "clientKeyId", "commandId", "correlationId", "credentialId", "principalId", "proof",
    "publicKeySpkiHex", "requestDigest", "sessionId", "transportId", "transportIds",
  ]);
  expect(PAIRING_OPEN_PATH).toBe("/session/pair/open");
  expect([...PAIRING_OPEN_REFUSAL_CODES]).toEqual([
    "PAIRING_OPEN_BODY_TOO_LARGE", "PAIRING_OPEN_REQUEST_INVALID",
  ]);
});

it("IS NOT A SECOND VERIFIER: the module imports no proof-verification symbol", () => {
  // The single-verifier property is structural, so grade it structurally. A drill that
  // adds a second verifySessionProofOverChallenge call inside this route leaves
  // session-authority.ts byte-identical and would otherwise pass every arm above.
  const source = readFileSync(
    new URL("./pairing-open-completion.ts", import.meta.url), "utf8",
  );
  // CODE ONLY, comments stripped. The module's own doc names the sole verifier on
  // purpose, so a whole-file substring ban would fire on the comment that DOCUMENTS the
  // property rather than on any violation of it.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  for (const banned of ["verifySessionProofOverChallenge", "canonicalSessionProofBytes",
    "sessionAuthorityRequestDigest", "presentedChallenge", "createVerify", "node:crypto",
    "session-authority-protocol"]) {
    expect(code.includes(banned)).toBe(false);
  }
  // POSITIVE CONTROLS. The stripper must not have eaten the code (the compose survives),
  // the scanned text must really be this module (its one import survives), and the doc
  // naming the verifier must still exist in the RAW source — without these three the
  // zeroes above would also be satisfied by an empty string.
  expect(code).toContain("sessions.openSession(record)");
  expect(code).toContain("session-authority-contracts.js");
  expect(source).toContain("verifySessionProofOverChallenge");
});

/**
 * THE AMENDED DoD-2 SENTENCE, EXECUTED END TO END THROUGH THE PRODUCTION LISTENER.
 *
 * "the approved pairing claim mints the principal AND issues the claim-bound challenge;
 * the session authority opens through the production openSession path only with the
 * verified proof; both records exist by the end of the approved-claim flow, the session
 * authority never before verification."
 *
 * Nothing below is doubled and nothing is called directly: every step is an HTTP request
 * to the real listener over one real store, with the operator approval going through the
 * listener's own terminal-only entry point.
 */
const CSRF = "pairing-open-completion-csrf";

async function post(
  listener: ControlRoomListener, path: string, body: string,
): Promise<{ readonly body: Record<string, unknown>; readonly status: number }> {
  const headers = {
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json",
    host: `127.0.0.1:${listener.port}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  return await new Promise((resolve, reject) => {
    const sent = httpRequest(listener.origin + path, { headers, method: "POST" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        status: response.statusCode ?? 0,
      }));
    });
    sent.on("error", reject);
    sent.end(body);
  });
}

it("END TO END: claim mints the principal and the challenge; only the signed open mints the authority", async () => {
  const key = clientKey();
  const store = openStore();
  const authority = createSessionAuthority(store, { clock: () => NOW, projectId: PROJECT_ID });
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps: {
      authenticator: authenticator([CAPABILITIES.ADMIN]),
      decisions: decisionPort(),
      registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
    },
    log: () => undefined,
    pairing: createOperatorSessionHandshakePort({
      capabilities: OPERATOR_CAPABILITIES,
      clock: () => Date.now(),
      operatorPrincipalId: "operator-pairing-open-e2e",
      projectId: PROJECT_ID,
      reservedPrincipalIds: ["operator-pairing-open-e2e"],
      sessionTtlMs: 60_000,
      store,
    }),
    pairingMonotonicNow: () => Date.now(),
    // The SAME operand port the read route publishes, and the SAME store the mint writes.
    pairingOpenSessions: createSessionAuthority(store, {
      clock: () => Date.now(), projectId: PROJECT_ID,
    }),
    sessionChallengeOperands: createSessionChallengeOperandsReadPort({
      projectId: PROJECT_ID, store,
    }),
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  try {
    const requested = await post(started, "/session/pair/request", "{}");
    expect(requested.status).toBe(200);
    expect(started.approvePairing(String(requested.body["confirmationLabel"])))
      .toEqual({ ok: true, state: "APPROVED" });

    // 1-3. APPROVED CLAIM WITH KEY MATERIAL -> principal + claim-bound challenge.
    const claimed = await post(started, "/session/pair/claim", JSON.stringify({
      publicKeySpkiHex: key.publicKeySpkiHex, requestId: String(requested.body["requestId"]),
    }));
    expect(claimed.status).toBe(200);
    const principalId = String(claimed.body["principalId"]);
    const challenge = claimed.body["challenge"] as Record<string, string>;
    expect(Object.keys(challenge).sort())
      .toEqual(["keyEpochRef", "profileRevisionId", "recoveryIncarnationRef"]);
    // BOTH HALVES OF THE CHECKPOINT: the principal is durable, the authority is not.
    expect(readPrincipalRecord(store, principalId).status).toBe("FOUND");
    const sessionId = "session-open-e2e";
    expect(authority.readSessionAuthority(sessionId)).toEqual({ status: "ABSENT" });

    // 4. THE CLIENT SIGNS what the claim disclosed - no daemon code signs anything.
    const requestDigest = sessionAuthorityRequestDigest({
      kind: "OPEN_SESSION", projectId: PROJECT_ID, principalId,
      profileRevisionId: challenge["profileRevisionId"]!,
      sessionId, credentialId: "credential-open-e2e", generation: 1,
      clientKeyId: key.clientKeyId, publicKeySpkiHex: key.publicKeySpkiHex,
      transportId: TRANSPORT_IDS[0]!, transportIds: TRANSPORT_IDS,
    });
    const issuedAt = Date.now();
    const nonce = "34".repeat(16);
    const signable = canonicalSessionProofBytes({
      principalId, projectId: PROJECT_ID,
      recoveryIncarnationRef: challenge["recoveryIncarnationRef"]!,
      keyEpochRef: challenge["keyEpochRef"]!,
      sessionId, credentialId: "credential-open-e2e", generation: 1,
      clientKeyId: key.clientKeyId, transportId: TRANSPORT_IDS[0]!,
      requestId: "command-open-e2e", requestDigest, issuedAt, nonce,
    });

    // 5. THE COMPLETION. Only here may SessionAuthorityOpened come into existence.
    const completed = await post(started, PAIRING_OPEN_PATH, JSON.stringify({
      clientKeyId: key.clientKeyId,
      commandId: "command-open-e2e",
      correlationId: "correlation-open-e2e",
      credentialId: "credential-open-e2e",
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
    }));
    expect(completed.status).toBe(200);
    expect(completed.body["ok"]).toBe(true);
    expect(completed.body["sessionId"]).toBe(sessionId);

    // BOTH RECORDS EXIST BY THE END OF THE FLOW, and the authority arrived last.
    const opened = authority.readSessionAuthority(sessionId);
    expect(opened.status).toBe("FOUND");
    if (opened.status !== "FOUND") throw new Error("unreachable");
    expect(opened.authority.publicKey.clientKeyId).toBe(key.clientKeyId);
    expect(opened.authority.principal.principalId).toBe(principalId);
  } finally {
    await started.close();
  }
});

it("refuses the completion route when the daemon composes no session authority", async () => {
  // A listener without `pairingOpenSessions` must not answer as though it verified.
  const store = openStore();
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps: {
      authenticator: authenticator([CAPABILITIES.ADMIN]),
      decisions: decisionPort(),
      registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
    },
    log: () => undefined,
    pairing: createOperatorSessionHandshakePort({
      capabilities: OPERATOR_CAPABILITIES,
      clock: () => Date.now(),
      operatorPrincipalId: "operator-pairing-open-unwired",
      projectId: PROJECT_ID,
      sessionTtlMs: 60_000,
      store,
    }),
    pairingMonotonicNow: () => Date.now(),
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  try {
    const refused = await post(started, PAIRING_OPEN_PATH, "{}");
    expect(refused.body["code"]).toBe("LISTENER_PAIRING_UNAVAILABLE");
    expect(refused.status).toBeGreaterThanOrEqual(400);
  } finally {
    await started.close();
  }
});
