import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { SqliteEventStore } from "@moe/store";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { createOperatorSessionHandshakePort, OPERATOR_SESSION_TTL_MS } from "../identity/session-handshake.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { SESSION_PROOF_ALGORITHM, SESSION_PROOF_PROTOCOL_VERSION } from "../identity/session-authority-contracts.js";
import { canonicalSessionProofBytes, sessionAuthorityRequestDigest, sessionClientKeyId } from "../identity/session-authority-protocol.js";
import { openStore, PROJECT_ID } from "../identity/session-test-fixtures.js";
import { createSessionChallengeOperandsReadPort } from "./session-challenge-operands-read.js";

export { closeStores, PROJECT_ID } from "../identity/session-test-fixtures.js";
export const BEARER = "validation-fixture-bearer";
export const NOW = Date.parse("2026-09-13T10:00:00.000Z");
const TRANSPORT = "control-room.v1";

function clientKey() {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiHex = pair.publicKey.export({ type: "spki", format: "der" }).toString("hex");
  return { privateKey: pair.privateKey, publicKeySpkiHex, clientKeyId: sessionClientKeyId(publicKeySpkiHex)! };
}

/** Every fixture claims a real durable bearer; open/close/rotate use real signed authority commands. */
export function validationFixture(store: SqliteEventStore = openStore()) {
  let now = NOW;
  const clock = () => now;
  const authority = createSessionAuthority(store, { clock, projectId: PROJECT_ID });
  const pairing = createOperatorSessionHandshakePort({ store, clock, projectId: PROJECT_ID,
    operatorPrincipalId: "operator-validation", capabilities: ["goal.write"],
    mintCredential: () => BEARER, mintSessionId: () => "principal-validation", sessionTtlMs: OPERATOR_SESSION_TTL_MS });
  const claimResult = pairing.mint();
  if (!claimResult.ok) throw new Error(`fixture claim refused: ${claimResult.code}`);
  const claimed = claimResult;
  const authenticator = createSessionAuthenticator(store, { clock, projectId: PROJECT_ID,
    operatorPrincipalId: "operator-validation", operatorCredential: "operator-validation-secret", operatorCapabilities: ["goal.write"] });
  const operands = createSessionChallengeOperandsReadPort({ store, projectId: PROJECT_ID });
  const currentResult = operands.readOperands(claimed.principalId);
  if (currentResult.outcome !== "OPERANDS") throw new Error("fixture operands absent");
  const current = currentResult;
  const key = clientKey();
  const binding = { sessionId: "keyed-validation", credentialId: "credential-validation",
    clientKeyId: key.clientKeyId, generation: 1 };

  function signed(requestDigest: string, requestId: string, transportId = TRANSPORT) {
    const nonce = randomBytes(16).toString("hex");
    const fields = { ...binding, principalId: claimed.principalId, projectId: PROJECT_ID,
      transportId, requestDigest, requestId, issuedAt: now, nonce,
      keyEpochRef: current.operands.keyEpochRef, recoveryIncarnationRef: current.operands.recoveryIncarnationRef };
    const bytes = canonicalSessionProofBytes(fields);
    const proof = { algorithm: SESSION_PROOF_ALGORITHM, protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
      issuedAt: now, nonce, signatureHex: sign(null, bytes, key.privateKey).toString("hex") };
    return { bytes, authentication: { ...binding, principalId: claimed.principalId, projectId: PROJECT_ID,
      transportId, requestDigest, requestId, proof } };
  }

  function open(transportId = TRANSPORT) {
    const commandId = "open-validation", transportIds = [transportId];
    const requestDigest = sessionAuthorityRequestDigest({ kind: "OPEN_SESSION", projectId: PROJECT_ID,
      principalId: claimed.principalId, profileRevisionId: current.operands.profileRevisionId,
      ...binding, publicKeySpkiHex: key.publicKeySpkiHex, transportId, transportIds });
    const signedRequest = signed(requestDigest, commandId, transportId);
    const result = authority.openSession({ commandId, correlationId: commandId,
      principalId: claimed.principalId, sessionId: binding.sessionId, credentialId: binding.credentialId,
      clientKeyId: binding.clientKeyId, publicKeySpkiHex: key.publicKeySpkiHex,
      transportId, transportIds, requestDigest, proof: signedRequest.authentication.proof });
    if (!result.ok) throw new Error(`fixture open refused: ${result.code} @ ${result.layer}`);
    return result;
  }

  function close() {
    const requestDigest = sessionAuthorityRequestDigest({ kind: "CLOSE_SESSION", projectId: PROJECT_ID,
      principalId: claimed.principalId, ...binding });
    return authority.closeSession({ commandId: "close-validation", correlationId: "close-validation",
      authentication: signed(requestDigest, "close-validation").authentication });
  }

  function rotate() {
    const next = clientKey(), commandId = "rotate-validation";
    const extra = { nextCredentialId: "credential-next", nextClientKeyId: next.clientKeyId,
      nextPublicKeySpkiHex: next.publicKeySpkiHex };
    const requestDigest = sessionAuthorityRequestDigest({ kind: "ROTATE_CREDENTIAL", projectId: PROJECT_ID,
      principalId: claimed.principalId, ...binding, ...extra, nextGeneration: 2 });
    const presented = signed(requestDigest, commandId);
    return authority.rotateCredential({ commandId, correlationId: commandId, ...extra,
      authentication: presented.authentication, nextSignatureHex: sign(null, presented.bytes, next.privateKey).toString("hex") });
  }
  return { authority, authenticator, binding, claimed, close, open, operands, pairing, rotate, store,
    setNow: (value: number) => { now = value; } };
}
