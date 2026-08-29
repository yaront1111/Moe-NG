import { afterAll, expect, it } from "vitest";

import { createSessionAuthenticator, credentialSha256Of } from "./session-authenticator.js";
import { createSessionAuthority } from "./session-authority.js";
import { readPrincipalRecord } from "./session-authority-store.js";
import { SESSION_SCHEMA_VERSION } from "./session-contracts.js";
import {
  createOperatorSessionHandshakePort,
  OPERATOR_PROFILE_REVISION_ID,
} from "./session-handshake.js";
import { readSessionLedger } from "./session-read-model.js";
import { runSessionCommand } from "./session-services.js";
import { closeStores, openStore, openUnboundStore, OPENER, PROJECT_ID } from "./session-test-fixtures.js";
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

function portWithSessionId(
  store: ReturnType<typeof openStore>,
  sessionId: string,
): ReturnType<typeof createOperatorSessionHandshakePort> {
  return createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => Date.now(),
    mintSessionId: () => sessionId,
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
  // BURN: the HUMAN principal already committed, so this approval must not be retried.
  expect(minted).toEqual({
    code: "SESSION_RECOVERY_BINDING_UNAVAILABLE",
    disposition: "BURN",
    layer: "DAEMON_PREREQUISITE",
    ok: false,
  });
});

it("a paired mint is a HUMAN principal keyed by its own session id", () => {
  const store = openStore();
  const sessionId = "session-human-a";
  const minted = portWithSessionId(store, sessionId).mint();
  expect(minted.ok).toBe(true);
  if (!minted.ok) throw new Error(`mint refused: ${minted.code}`);

  expect(OPERATOR_PROFILE_REVISION_ID).toBe("operator-pairing-profile:v1");
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
  }).authenticate(minted.credential);
  expect(authenticated.verdict).toBe("AUTHENTICATED");
  if (authenticated.verdict === "AUTHENTICATED") {
    expect(authenticated.principal.principalId).toBe(sessionId);
  }

  // No SessionAuthorityOpened is minted here: a bearer has no client key;
  // Gate 1 stage-E reachability is gated on the fork in comment-b157ddaa.
  expect(createSessionAuthority(store, {
    clock: () => Date.now(), projectId: PROJECT_ID,
  }).readSessionAuthority(sessionId)).toEqual({ status: "ABSENT" });
});

it("the agent path stays unchanged and mints no SessionAuthority principal", () => {
  const store = openStore();
  const now = Date.now();
  const sessionId = "session-agent-b";
  const envelope = {
    commandId: "session-agent-b-open",
    correlationId: "session-agent-b-correlation",
    decidedAt: new Date(now).toISOString(),
    expectedVersion: 0,
    kind: "session.open",
    payload: {
      capabilities: ["work.claim"],
      credentialSha256: credentialSha256Of("session-agent-b-credential"),
      expiresAt: new Date(now + 60_000).toISOString(),
      sessionId,
    },
    principalId: OPENER,
    projectId: PROJECT_ID,
    schemaVersion: SESSION_SCHEMA_VERSION,
  };
  const opened = runSessionCommand(
    store,
    new TextEncoder().encode(JSON.stringify(envelope)),
  );
  expect(opened.ok).toBe(true);
  expect(readPrincipalRecord(store, sessionId)).toEqual({ status: "ABSENT" });
});

it("a refused principal mint refuses before the old session ledger is touched", () => {
  const store = openStore();
  const sessionId = "session-conflict-c";
  const sessions = createSessionAuthority(store, {
    clock: () => Date.now(), projectId: PROJECT_ID,
  });
  const seeded = sessions.createPrincipal({
    commandId: "seed-c",
    correlationId: "seed-c",
    kind: "HUMAN",
    principalId: sessionId,
    profileRevisionId: "seed",
  });
  expect(seeded.ok).toBe(true);
  const before = readSessionLedger(store, PROJECT_ID).sessions.size;

  // RELEASE: the refused mutation wrote nothing, so the approval stays retryable.
  expect.soft(portWithSessionId(store, sessionId).mint()).toEqual({
    code: "EXPECTED_VERSION_CONFLICT",
    disposition: "RELEASE",
    layer: "DURABLE_STORE",
    ok: false,
  });
  expect(readSessionLedger(store, PROJECT_ID).sessions.size).toBe(before);
  expect(readPrincipalRecord(store, sessionId)).toEqual({
    status: "FOUND",
    principal: {
      principalId: sessionId,
      kind: "HUMAN",
      profileRevisionId: "seed",
    },
  });
});

it("a reserved session id is refused before any principal is minted", () => {
  const store = openStore();
  const minted = portWithSessionId(store, OPERATOR).mint();
  // RELEASE: the pre-write fence refuses before any durable authority is touched.
  expect.soft(minted).toEqual({
    code: "SESSION_ID_RESERVED",
    disposition: "RELEASE",
    layer: "DAEMON_INGRESS",
    ok: false,
  });
  // This ABSENT assertion distinguishes the pre-write guard from the session
  // layer's identical SESSION_ID_RESERVED fence.
  expect(readPrincipalRecord(store, OPERATOR)).toEqual({ status: "ABSENT" });
});

it("an orphan principal after a session.open refusal remains inert", () => {
  const store = openUnboundStore();
  const sessionId = "session-orphan-e";
  const minted = portWithSessionId(store, sessionId).mint();
  // BURN: this refusal follows a committed principal, so the orphan below is the
  // ONLY one this approval can ever produce.
  expect.soft(minted).toEqual({
    code: "SESSION_RECOVERY_BINDING_UNAVAILABLE",
    disposition: "BURN",
    layer: "DAEMON_PREREQUISITE",
    ok: false,
  });
  expect.soft(readPrincipalRecord(store, sessionId)).toEqual({
    status: "FOUND",
    principal: {
      principalId: sessionId,
      kind: "HUMAN",
      profileRevisionId: OPERATOR_PROFILE_REVISION_ID,
    },
  });
  expect(createSessionAuthority(store, {
    clock: () => Date.now(), projectId: PROJECT_ID,
  }).readSessionAuthority(sessionId)).toEqual({ status: "ABSENT" });
  expect(readSessionLedger(store, PROJECT_ID).sessions.has(sessionId)).toBe(false);
});
