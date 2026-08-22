import { afterAll, expect, it } from "vitest";

import { createSessionAuthenticator, credentialSha256Of } from "./session-authenticator.js";
import { createOperatorSessionHandshakePort } from "./session-handshake.js";
import { readSessionLedger } from "./session-read-model.js";
import { closeStores, openStore, openUnboundStore, PROJECT_ID } from "./session-test-fixtures.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";

/**
 * The operator handshake mint, proved against a REAL store: a mint opens a real
 * session through `runSessionCommand`, the ledger holds only the credential's
 * hash, and the plaintext it returns authenticates through the ordinary
 * `createSessionAuthenticator` fold. No second credential store is invented.
 */

const OPERATOR = "operator-local";

afterAll(() => { closeStores(); });

function portOver(store: ReturnType<typeof openStore>): ReturnType<
  typeof createOperatorSessionHandshakePort
> {
  return createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => Date.now(),
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT_ID,
    reservedPrincipalIds: [OPERATOR],
    sessionTtlMs: 60_000,
    store,
  });
}

it("mints a session whose hash is bound and whose plaintext authenticates", () => {
  const store = openStore();
  const port = portOver(store);
  expect(port.boundProjectId).toBe(PROJECT_ID);

  const minted = port.mint();
  if (!minted.ok) throw new Error(`mint refused: ${minted.code}`);
  expect(minted.credential.length).toBeGreaterThan(0);
  expect(minted.capabilities).toEqual([...OPERATOR_CAPABILITIES]);
  expect(minted.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

  // The durable ledger holds the HASH of the credential, never the plaintext.
  const ledger = readSessionLedger(store, PROJECT_ID);
  const hashes = [...ledger.sessions.values()].map((session) => session.credentialSha256);
  expect(hashes).toContain(credentialSha256Of(minted.credential));

  // The plaintext authenticates through the ordinary fold with the minted caps.
  const authenticator = createSessionAuthenticator(store, {
    clock: () => Date.now(),
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: "unused",
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT_ID,
  });
  const result = authenticator.authenticate(minted.credential);
  expect(result.verdict).toBe("AUTHENTICATED");
  if (result.verdict === "AUTHENTICATED") {
    // The fold sorts and dedups the capability set, so compare as a set: the
    // members are the operator's, whatever the order the record stored them in.
    expect([...result.principal.capabilities].sort())
      .toEqual([...OPERATOR_CAPABILITIES].sort());
    expect(result.principal.projectId).toBe(PROJECT_ID);
  }
});

it("mints DISTINCT sessions on repeated calls, each independently authenticating", () => {
  const store = openStore();
  const port = portOver(store);
  const first = port.mint();
  const second = port.mint();
  if (!first.ok || !second.ok) throw new Error("a mint refused");
  expect(first.credential).not.toBe(second.credential);

  const authenticator = createSessionAuthenticator(store, {
    clock: () => Date.now(),
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: "unused",
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT_ID,
  });
  expect(authenticator.authenticate(first.credential).verdict).toBe("AUTHENTICATED");
  expect(authenticator.authenticate(second.credential).verdict).toBe("AUTHENTICATED");
});

it("refuses, with the session layer's own code, when the store has no recovery binding", () => {
  // No recovery binding installed: session.open refuses its prerequisite, and the
  // handshake surfaces that code rather than fabricating a credential.
  const store = openUnboundStore();
  const minted = portOver(store).mint();
  expect(minted.ok).toBe(false);
  if (!minted.ok) expect(minted.code).toBe("SESSION_RECOVERY_BINDING_UNAVAILABLE");
});
