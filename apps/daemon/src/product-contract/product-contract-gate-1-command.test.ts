import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { admitProductContractRevisionRef, productContractGate1Authority } from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { handleCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import {
  SESSION_PROOF_ALGORITHM, SESSION_PROOF_PROTOCOL_VERSION,
} from "../identity/session-authority-contracts.js";
import {
  canonicalSessionProofBytes, sessionAuthorityRequestDigest, sessionClientKeyId,
} from "../identity/session-authority-protocol.js";
import { replayAggregateId } from "../identity/session-authority-store.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import {
  TEST_RECOVERY_INCARNATION_REF, TEST_RECOVERY_KEY_EPOCH_REF, installTestRecoveryBinding,
} from "../identity/session-test-fixtures.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
  PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION, deriveProductContractGate1AggregateId,
  productContractGate1SubjectDigest,
} from "./product-contract-gate-1-contract.js";
import {
  createProductContractGate1Authority, runProductContractGate1Command,
} from "./product-contract-gate-1-command.js";

/**
 * task-7997ba7c: the daemon-owned `product_contract.approve_gate_1` writer.
 *
 * Every authority arm is driven through the REAL registry seam
 * (`createStoreDependencies` then `handleCommandRequest`), never the handler
 * directly, so a refusal measured here is the refusal a client receives. Both
 * signed presentations are minted by the PRODUCTION session authority against
 * the same store file the daemon serves, so the HUMAN/AGENT split under test is
 * the one `sessions.authenticate` actually reports rather than a fixture flag.
 */

const PROJECT = "proj-product-contract-gate-1";
const OPERATOR = "operator-local";
const CREDENTIAL = "gate-1-operator-credential";
const DECIDED_AT = "2026-08-09T12:00:00.000Z";
const NOW = Date.parse(DECIDED_AT);
const CLOCK = (): string => DECIDED_AT;
const TRANSPORT_ID = "transport-gate-1";
const PROFILE_REVISION_ID = "profile-revision-gate-1";
const ADMIN = "project.admin";
const WORK = "work.write";

const CONTRACT_ID = "contract-gate-1";
const REVISION_ID = "revision-gate-1";
const REVISION_DIGEST = "ab".repeat(32);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface MintedSession {
  readonly clientKeyId: string;
  readonly credentialId: string;
  readonly generation: number;
  readonly principalId: string;
  readonly privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly sessionId: string;
}

const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-gate-1-"));
const storePath = join(directory, "store.db");

function mintSession(
  store: SqliteEventStore, label: string, kind: "HUMAN" | "AGENT", principalId: string,
): MintedSession {
  const sessions = createSessionAuthority(store, { clock: () => NOW, projectId: PROJECT });
  const principal = sessions.createPrincipal({
    commandId: `gate1-principal-${label}`,
    correlationId: `gate1-principal-correlation-${label}`,
    kind,
    principalId,
    profileRevisionId: PROFILE_REVISION_ID,
  });
  if (!principal.ok) throw new Error(`principal creation refused: ${principal.code}`);
  const keys = generateKeyPairSync("ed25519");
  const publicKeySpkiHex = keys.publicKey.export({ format: "der", type: "spki" }).toString("hex");
  const clientKeyId = sessionClientKeyId(publicKeySpkiHex);
  if (clientKeyId === null) throw new Error("Node produced a non-canonical Ed25519 key");
  const sessionId = `gate1-session-${label}`;
  const credentialId = `gate1-credential-${label}`;
  const commandId = `gate1-session-open-${label}`;
  const requestDigest = sessionAuthorityRequestDigest({
    clientKeyId, credentialId, generation: 1, kind: "OPEN_SESSION", principalId,
    profileRevisionId: PROFILE_REVISION_ID, projectId: PROJECT, publicKeySpkiHex, sessionId,
    transportId: TRANSPORT_ID, transportIds: [TRANSPORT_ID],
  });
  const nonce = "31".repeat(16);
  const challenge = canonicalSessionProofBytes({
    clientKeyId, credentialId, generation: 1, issuedAt: NOW,
    keyEpochRef: TEST_RECOVERY_KEY_EPOCH_REF, nonce, principalId, projectId: PROJECT,
    recoveryIncarnationRef: TEST_RECOVERY_INCARNATION_REF, requestDigest, requestId: commandId,
    sessionId, transportId: TRANSPORT_ID,
  });
  const opened = sessions.openSession({
    clientKeyId, commandId, correlationId: `gate1-session-open-correlation-${label}`,
    credentialId, principalId,
    proof: {
      algorithm: SESSION_PROOF_ALGORITHM, issuedAt: NOW, nonce,
      protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
      signatureHex: sign(null, challenge, keys.privateKey).toString("hex"),
    },
    publicKeySpkiHex, requestDigest, sessionId, transportId: TRANSPORT_ID,
    transportIds: [TRANSPORT_ID],
  });
  if (!opened.ok) throw new Error(`session opening refused: ${opened.code}`);
  return Object.freeze({
    clientKeyId, credentialId, generation: 1, principalId, privateKey: keys.privateKey, sessionId,
  });
}

const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
const HUMAN_SESSION = mintSession(setupStore, "human", "HUMAN", "human-approver-1");
const AGENT_SESSION = mintSession(setupStore, "agent", "AGENT", "agent-approver-1");
setupStore.close();

const provider = createStoreDependencies({
  clock: CLOCK, credential: CREDENTIAL, principalId: OPERATOR, projectId: PROJECT, storePath,
});
const deps = provider.provide();

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

interface Triple {
  readonly contractId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}

const TRIPLE: Triple = Object.freeze({
  contractId: CONTRACT_ID, revisionDigest: REVISION_DIGEST, revisionId: REVISION_ID,
});

/** The gate is CORE's, derived from CORE's admitted ref. Nothing here spells one. */
function gateOf(triple: Triple): { readonly gateId: string; readonly workRef: string } {
  const admitted = admitProductContractRevisionRef({ ...triple });
  if (!admitted.ok) throw new Error(`fixture triple refused: ${admitted.code}`);
  return productContractGate1Authority(admitted.ref);
}

const workRefOf = (triple: Triple): string => gateOf(triple).workRef;

function authenticationFor(
  session: MintedSession, commandId: string, triple: Triple, nonce: string,
): Record<string, unknown> {
  const requestDigest = productContractGate1SubjectDigest({
    commandId, projectId: PROJECT, workRef: workRefOf(triple),
  });
  const challenge = canonicalSessionProofBytes({
    clientKeyId: session.clientKeyId, credentialId: session.credentialId,
    generation: session.generation, issuedAt: NOW, keyEpochRef: TEST_RECOVERY_KEY_EPOCH_REF,
    nonce, principalId: session.principalId, projectId: PROJECT,
    recoveryIncarnationRef: TEST_RECOVERY_INCARNATION_REF, requestDigest, requestId: commandId,
    sessionId: session.sessionId, transportId: TRANSPORT_ID,
  });
  return {
    clientKeyId: session.clientKeyId, credentialId: session.credentialId,
    generation: session.generation, principalId: session.principalId, projectId: PROJECT,
    proof: {
      algorithm: SESSION_PROOF_ALGORITHM, issuedAt: NOW, nonce,
      protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
      signatureHex: sign(null, challenge, session.privateKey).toString("hex"),
    },
    requestDigest, requestId: commandId, sessionId: session.sessionId,
    transportId: TRANSPORT_ID,
  };
}

let nonceCounter = 0;
const freshNonce = (): string => {
  nonceCounter += 1;
  return nonceCounter.toString(16).padStart(32, "0");
};

function send(
  commandId: string, payload: Readonly<Record<string, unknown>>, credential: string = CREDENTIAL,
): ReturnType<typeof handleCommandRequest> {
  return handleCommandRequest(deps, {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
      correlationId: "corr-gate-1", expectedVersion: 0, payload,
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId: "agg-gate-1",
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
}

function approvalPayload(
  session: MintedSession, commandId: string, triple: Triple = TRIPLE, nonce = freshNonce(),
): Record<string, unknown> {
  return { authentication: authenticationFor(session, commandId, triple, nonce), ...triple };
}

function openScopedSession(
  commandId: string, sessionId: string, secret: string, capabilities: readonly string[],
): string {
  const opened = handleCommandRequest(deps, {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind: "session.open", correlationId: "corr-gate-1", expectedVersion: 0,
      payload: {
        capabilities,
        credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
        expiresAt: "2027-01-01T00:00:00.000Z", sessionId,
      },
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL, targetAggregateId: "agg-gate-1",
    })),
    credential: CREDENTIAL,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
  expect(opened).toMatchObject({ outcome: "ACCEPTED" });
  return secret;
}

interface ReadEvent {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

function readAggregate(triple: Triple = TRIPLE): readonly ReadEvent[] {
  const reader = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    return reader.readEvents(deriveProductContractGate1AggregateId(workRefOf(triple)))
      .map((event) => Object.freeze({
        eventType: event.eventType,
        payload: JSON.parse(decoder.decode(event.payload)) as Record<string, unknown>,
      }));
  } finally {
    reader.close();
  }
}

describe("product_contract.approve_gate_1 writes an authenticated human grant", () => {
  it("commits one decision and one event bound to core's own work reference", () => {
    const commandId = "gate1-accepted-1";
    expect(send(commandId, approvalPayload(HUMAN_SESSION, commandId))).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
      outcome: "ACCEPTED",
    });

    const events = readAggregate();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe(PRODUCT_CONTRACT_GATE_1_EVENT_TYPE);
    expect(events[0]?.payload).toEqual({
      contractId: CONTRACT_ID,
      gateId: gateOf(TRIPLE).gateId,
      grant: {
        gateId: gateOf(TRIPLE).gateId,
        grantedAtEpochMs: NOW,
        principalId: "human-approver-1",
        principalKind: "HUMAN",
        workRef: workRefOf(TRIPLE),
      },
      revisionDigest: REVISION_DIGEST,
      revisionId: REVISION_ID,
      workRef: workRefOf(TRIPLE),
    });
  });

  it("refuses a real signed AGENT session with core's own tuple and writes nothing", () => {
    const triple: Triple = { ...TRIPLE, revisionId: "revision-gate-1-agent" };
    const commandId = "gate1-agent-1";
    expect(send(commandId, approvalPayload(AGENT_SESSION, commandId, triple))).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: { code: "APPROVAL_PRINCIPAL_NOT_HUMAN", layer: "HUMAN_AUTHORITY_GATE" },
      stage: "DISPATCH",
    });
    expect(readAggregate(triple)).toHaveLength(0);
  });

  const AUTHORITY_KEYS = [
    "principalId", "principalKind", "grantedAt", "grant", "gate", "workRef", "witness",
    "decidedAt",
  ] as const;

  it("sweeps one smuggled-authority case per reserved key", () => {
    expect(AUTHORITY_KEYS).toHaveLength(8);
  });

  it.each(AUTHORITY_KEYS)(
    "refuses a caller-supplied %s at PAYLOAD_SHAPE before any handler runs",
    (key) => {
      const commandId = `gate1-smuggled-${key}`;
      expect(send(commandId, {
        ...approvalPayload(HUMAN_SESSION, commandId), [key]: "smuggled",
      })).toMatchObject({
        error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false, outcome: "REFUSED",
        stage: "PAYLOAD_SHAPE",
      });
    },
  );

  interface MalformedCase {
    readonly code: string;
    readonly label: string;
    readonly triple: Triple;
  }

  const MALFORMED: readonly MalformedCase[] = [
    { code: "PRODUCT_CONTRACT_PROVENANCE_INVALID", label: "an-empty-contract-id",
      triple: { ...TRIPLE, contractId: "" } },
    { code: "PRODUCT_CONTRACT_PROVENANCE_INVALID", label: "a-63-hex-revision-digest",
      triple: { ...TRIPLE, revisionDigest: "a".repeat(63) } },
    { code: "PRODUCT_CONTRACT_PROVENANCE_INVALID", label: "an-uppercase-revision-digest",
      triple: { ...TRIPLE, revisionDigest: "AB".repeat(32) } },
    { code: "PRODUCT_CONTRACT_LIMIT_EXCEEDED", label: "an-oversized-revision-id",
      triple: { ...TRIPLE, revisionId: "r".repeat(513) } },
  ];

  it("sweeps one malformed-triple case per refusal", () => {
    expect(MALFORMED).toHaveLength(4);
  });

  it.each(MALFORMED)("refuses $label with core's own PROVENANCE tuple", (entry) => {
    const commandId = `gate1-malformed-${entry.label}`;
    expect(send(commandId, {
      authentication: authenticationFor(HUMAN_SESSION, commandId, TRIPLE, freshNonce()),
      ...entry.triple,
    })).toMatchObject({
      outcome: "PORT_REFUSED", refusal: { code: entry.code, layer: "PROVENANCE" },
      stage: "DISPATCH",
    });
  });

  it("replays the stored decision for identical bytes without a second event", () => {
    const triple: Triple = { ...TRIPLE, revisionId: "revision-gate-1-replay" };
    const commandId = "gate1-replay-1";
    const payload = approvalPayload(HUMAN_SESSION, commandId, triple);
    expect(send(commandId, payload)).toMatchObject({
      decision: { disposition: "DECIDED" }, outcome: "ACCEPTED",
    });
    expect(send(commandId, payload)).toMatchObject({
      decision: { disposition: "REPLAYED" }, outcome: "ACCEPTED",
    });
    expect(readAggregate(triple)).toHaveLength(1);
  });

  it("refuses the same command identity carrying different bytes and writes nothing new", () => {
    const triple: Triple = { ...TRIPLE, revisionId: "revision-gate-1-conflict" };
    const other: Triple = { ...TRIPLE, revisionId: "revision-gate-1-conflict-other" };
    const commandId = "gate1-conflict-1";
    expect(send(commandId, approvalPayload(HUMAN_SESSION, commandId, triple))).toMatchObject({
      decision: { disposition: "DECIDED" }, outcome: "ACCEPTED",
    });
    expect(send(commandId, approvalPayload(HUMAN_SESSION, commandId, other))).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: { code: "IDEMPOTENCY_CONFLICT", layer: "DURABLE_STORE" },
    });
    expect(readAggregate(triple)).toHaveLength(1);
    expect(readAggregate(other)).toHaveLength(0);
  });

  it("denies a WORK-only session before dispatch and lets an ADMIN one reach the gate", () => {
    const denied = openScopedSession(
      "gate1-open-work", "gate1-sess-work", "gate1-secret-work", [WORK],
    );
    const commandId = "gate1-capability-denied";
    expect(send(commandId, approvalPayload(HUMAN_SESSION, commandId), denied)).toMatchObject({
      error: { code: "CAPABILITY_DENIED" }, httpStatus: 403, ok: false, outcome: "REFUSED",
      stage: "AUTHORIZE",
    });

    // ADMIN is the REACH fence only: an ADMIN-scoped agent session reaches the gate and
    // is refused THERE by the human authority, never by the capability check above.
    const reaching = openScopedSession(
      "gate1-open-admin", "gate1-sess-admin", "gate1-secret-admin", [ADMIN, WORK],
    );
    const triple: Triple = { ...TRIPLE, revisionId: "revision-gate-1-reach" };
    const reachId = "gate1-capability-reach";
    expect(send(reachId, approvalPayload(AGENT_SESSION, reachId, triple), reaching))
      .toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: { code: "APPROVAL_PRINCIPAL_NOT_HUMAN", layer: "HUMAN_AUTHORITY_GATE" },
        stage: "DISPATCH",
      });
    expect(readAggregate(triple)).toHaveLength(0);
  });
});

const BEARER_REPLAY_DOMAIN = "moe/product-contract/gate-1/bearer-replay/v1";

function bearerReplayDigest(
  sessionId: string, requestId: string, requestDigest: string,
): string {
  return createHash("sha256")
    .update([BEARER_REPLAY_DOMAIN, sessionId, requestId, requestDigest].join("\0"), "utf8")
    .digest("hex");
}

function directRequest(
  commandId: string, principalId: string, payload: Readonly<Record<string, unknown>>,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId,
    correlationId: `correlation-${commandId}`,
    decidedAt: DECIDED_AT,
    expectedVersion: 0,
    kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    payload,
    principalId,
    projectId: PROJECT,
    schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  }));
}

function withDirectStore(run: (store: SqliteEventStore) => void): void {
  const directDirectory = mkdtempSync(join(tmpdir(), "moe-product-contract-gate-1-direct-"));
  const directStore = SqliteEventStore.openForProject(join(directDirectory, "store.db"), PROJECT);
  try {
    run(directStore);
  } finally {
    directStore.close();
    rmSync(directDirectory, { force: true, recursive: true });
  }
}

describe("Gate 1 stage-E bearer dispatch", () => {
  it("commits the same durable HUMAN grant shape through the runner bearer seam", () =>
    withDirectStore((store) => {
      const sessionId = "gate1-direct-bearer-human";
      const sessions = createSessionAuthority(store, { clock: () => NOW, projectId: PROJECT });
      const principal = sessions.createPrincipal({
        commandId: "gate1-direct-principal",
        correlationId: "gate1-direct-principal-correlation",
        kind: "HUMAN",
        principalId: sessionId,
        profileRevisionId: PROFILE_REVISION_ID,
      });
      if (!principal.ok) throw new Error(`principal creation refused: ${principal.code}`);
      const commandId = "gate1-direct-bearer-command";
      const requestDigest = productContractGate1SubjectDigest({
        commandId, projectId: PROJECT, workRef: workRefOf(TRIPLE),
      });
      const authority = createProductContractGate1Authority({ projectId: PROJECT, sessions, store });
      const outcome = runProductContractGate1Command(
        store,
        directRequest(commandId, sessionId, {
          authentication: { issuedAt: NOW, kind: "BEARER", requestDigest, requestId: commandId },
          ...TRIPLE,
        }),
        authority,
        Object.freeze({ sessionId, transportOrigin: "MCP_STDIO" }),
      );
      expect(outcome).toMatchObject({
        decision: { resultCode: "EFFECTS_COMMITTED" }, disposition: "DECIDED", ok: true,
      });
      expect(store.getCommandDecision({ commandId, principalId: sessionId, projectId: PROJECT }))
        .not.toBeNull();
      const events = store.readEvents(deriveProductContractGate1AggregateId(workRefOf(TRIPLE)));
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe(PRODUCT_CONTRACT_GATE_1_EVENT_TYPE);
      expect(JSON.parse(decoder.decode(events[0]?.payload))).toEqual({
        contractId: CONTRACT_ID,
        gateId: gateOf(TRIPLE).gateId,
        grant: {
          gateId: gateOf(TRIPLE).gateId,
          grantedAtEpochMs: NOW,
          principalId: sessionId,
          principalKind: "HUMAN",
          workRef: workRefOf(TRIPLE),
        },
        revisionDigest: REVISION_DIGEST,
        revisionId: REVISION_ID,
        workRef: workRefOf(TRIPLE),
      });
    }));

  it("keeps a signed proof on sessions.authenticate even when a bearer witness is present", () =>
    withDirectStore((store) => {
      installTestRecoveryBinding(store);
      const signed = mintSession(store, "signed-witness", "HUMAN", "signed-witness-human");
      const triple: Triple = { ...TRIPLE, revisionId: "revision-gate-1-signed-witness" };
      const commandId = "gate1-signed-witness-command";
      const authentication = authenticationFor(signed, commandId, triple, freshNonce());
      const requestDigest = authentication["requestDigest"];
      if (typeof requestDigest !== "string") throw new Error("signed fixture omitted its digest");
      const sessions = createSessionAuthority(store, { clock: () => NOW, projectId: PROJECT });
      const authority = createProductContractGate1Authority({ projectId: PROJECT, sessions, store });
      expect(runProductContractGate1Command(
        store,
        directRequest(commandId, signed.principalId, { authentication, ...triple }),
        authority,
        Object.freeze({ sessionId: signed.sessionId, transportOrigin: "HTTP_LISTENER" }),
      )).toMatchObject({ ok: true });
      const bearerDigest = bearerReplayDigest(signed.sessionId, commandId, requestDigest);
      expect(store.readEvents(replayAggregateId(bearerDigest))).toHaveLength(0);
    }));
});
