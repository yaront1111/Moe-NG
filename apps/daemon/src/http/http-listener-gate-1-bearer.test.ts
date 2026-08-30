import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import {
  type ProductContractRevisionDraft, type ProductContractRevisionRef,
  productContractGate1Authority,
} from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { expect, it, vi } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { handleCommandRequest } from "./http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { ControlRoomListener } from "./http-listener.js";
import { startControlRoomListener } from "./http-listener.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, deriveProductContractGate1AggregateId,
  productContractGate1SubjectDigest,
} from "../product-contract/product-contract-gate-1-contract.js";
import {
  commitProductContractRevision,
} from "../product-contract/product-contract-revision-store.js";

const PROJECT = "proj-listener-gate-1-bearer";
const OPERATOR = "operator-listener-gate-1-bearer";
const OPERATOR_CREDENTIAL = "operator-credential-listener-gate-1-bearer";
const CSRF = "csrf-listener-gate-1-bearer";
const DECIDED_AT = "2026-08-30T12:00:00.000Z";
const NOW = Date.parse(DECIDED_AT);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
}

interface PairingIdentity {
  readonly confirmationLabel: string;
  readonly requestId: string;
}

function revisionDraft(): ProductContractRevisionDraft {
  return {
    authorRef: OPERATOR,
    contractId: "contract-listener-gate-1-bearer",
    criteria: [{
      criterionId: "criterion-listener-bearer",
      requirementId: "requirement-listener-bearer",
      statement: "A paired human can approve Gate 1.",
      supersedesCriterionId: null,
    }],
    lineage: null,
    requirements: [{
      requirementId: "requirement-listener-bearer",
      statement: "Gate 1 accepts the paired human bearer.",
      supersedesRequirementId: null,
    }],
    retiredCriterionIds: [],
    retiredRequirementIds: [],
    revisionId: "revision-listener-gate-1-bearer",
    sourceDocumentDigests: ["a".repeat(64)],
  };
}

function commitRevision(storePath: string): ProductContractRevisionRef {
  const setup = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    installTestRecoveryBinding(setup);
    const committed = commitProductContractRevision(setup, {
      correlationId: "correlation-listener-gate-1-revision",
      decidedAt: DECIDED_AT,
      draft: revisionDraft(),
      principalId: OPERATOR,
      projectId: PROJECT,
    });
    if (!committed.ok) throw new Error(`revision fixture refused: ${committed.code}`);
    return committed.ref;
  } finally {
    setup.close();
  }
}

async function post(
  listener: ControlRoomListener, path: string, body: unknown,
): Promise<Reply> {
  const payload = JSON.stringify(body);
  const headers = {
    "content-length": String(Buffer.byteLength(payload)),
    "content-type": "application/json",
    host: `127.0.0.1:${String(listener.port)}`,
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
    request.end(payload);
  });
}

function identityOf(reply: Reply): PairingIdentity {
  const confirmationLabel = reply.body["confirmationLabel"];
  const requestId = reply.body["requestId"];
  if (typeof confirmationLabel !== "string" || typeof requestId !== "string") {
    throw new Error("pairing request omitted its identity");
  }
  return Object.freeze({ confirmationLabel, requestId });
}

function commandBytes(
  commandId: string,
  sessionCredential: string,
  authentication: Readonly<Record<string, unknown>>,
  triple: Readonly<{ contractId: string; revisionDigest: string; revisionId: string }>,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId,
    commandKind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    correlationId: `correlation-${commandId}`,
    expectedVersion: 0,
    payload: { authentication, ...triple },
    requestDigest: "b".repeat(64),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential,
    targetAggregateId: `gate-1/${commandId}`,
  }));
}

it("admits a paired HUMAN bearer on MCP and refuses the local operator bearer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-listener-gate-1-bearer-"));
  const storePath = join(directory, "store.db");
  const ref = commitRevision(storePath);
  const logs: string[] = [];
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    stdoutWrites.push(String(chunk)); return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk): boolean => {
    stderrWrites.push(String(chunk)); return true;
  });
  let provider: ReturnType<typeof createStoreDependencies> | null = null;
  let started: ControlRoomListener | null = null;

  try {
    provider = createStoreDependencies({
      clock: () => DECIDED_AT,
      credential: OPERATOR_CREDENTIAL,
      principalId: OPERATOR,
      projectId: PROJECT,
      storePath,
    });
    const deps = provider.provide();
    const sessionHandshake = provider.sessionHandshake;
    if (sessionHandshake === undefined) throw new Error("the provider wires no pairing handshake");
    const listener = await startControlRoomListener({
      csrfToken: CSRF,
      deps,
      log: (line) => logs.push(line),
      pairing: sessionHandshake(),
      pairingMonotonicNow: () => NOW,
    });
    if (!listener.ok) throw new Error(`listener refused: ${listener.code}`);
    started = listener;
    const identity = identityOf(await post(started, "/session/pair/request", {}));
    expect(started.approvePairing(identity.confirmationLabel))
      .toEqual({ ok: true, state: "APPROVED" });
    const claimed = await post(started, "/session/pair/claim", { requestId: identity.requestId });
    expect(claimed.status).toBe(200);
    const pairedCredential = claimed.body["sessionCredential"];
    if (typeof pairedCredential !== "string") throw new Error("pairing claim omitted its credential");
    const authenticated = deps.authenticator.authenticate(pairedCredential);
    expect(authenticated.verdict).toBe("AUTHENTICATED");
    if (authenticated.verdict !== "AUTHENTICATED") {
      throw new Error("paired bearer refused at ingress");
    }
    const pairedSessionId = authenticated.principal.principalId;
    const gate = productContractGate1Authority(ref);
    const triple = {
      contractId: ref.contractId,
      revisionDigest: ref.revisionDigest,
      revisionId: ref.revisionId,
    };

    const commandId = "listener-gate-1-paired-human";
    const requestDigest = productContractGate1SubjectDigest({
      commandId, projectId: PROJECT, workRef: gate.workRef,
    });
    const pairedOutcome = handleCommandRequest(deps, {
      body: commandBytes(commandId, pairedCredential, {
        issuedAt: NOW, kind: "BEARER", requestDigest, requestId: commandId,
      }, triple),
      credential: pairedCredential,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "MCP_STDIO");
    expect(pairedOutcome).not.toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: {
        code: "PRODUCT_CONTRACT_GATE_1_BEARER_WITNESS_MISSING",
        layer: "DAEMON_GATE_1_BEARER",
      },
    });
    expect(pairedOutcome).toMatchObject({
      decision: { resultCode: "EFFECTS_COMMITTED" }, outcome: "ACCEPTED",
    });

    const reader = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      const events = reader.readEvents(deriveProductContractGate1AggregateId(gate.workRef));
      expect(events).toHaveLength(1);
      const payload = JSON.parse(decoder.decode(events[0]?.payload)) as Record<string, unknown>;
      expect(payload["grant"]).toEqual({
        gateId: gate.gateId,
        grantedAtEpochMs: NOW,
        principalId: pairedSessionId,
        principalKind: "HUMAN",
        workRef: gate.workRef,
      });
    } finally {
      reader.close();
    }

    const operatorCommandId = "listener-gate-1-local-operator";
    const operatorDigest = productContractGate1SubjectDigest({
      commandId: operatorCommandId, projectId: PROJECT, workRef: gate.workRef,
    });
    const operatorOutcome = handleCommandRequest(deps, {
      body: commandBytes(operatorCommandId, OPERATOR_CREDENTIAL, {
        issuedAt: NOW, kind: "BEARER", requestDigest: operatorDigest,
        requestId: operatorCommandId,
      }, triple),
      credential: OPERATOR_CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "MCP_STDIO");
    expect(operatorOutcome).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: {
        code: "PRODUCT_CONTRACT_GATE_1_BEARER_PRINCIPAL_ABSENT",
        layer: "DAEMON_GATE_1_BEARER",
      },
      stage: "DISPATCH",
    });
    const unsafeText = [
      ...logs, ...stdoutWrites, ...stderrWrites, JSON.stringify(operatorOutcome),
    ].join("\n");
    for (const secret of [
      pairedCredential, pairedSessionId, requestDigest, operatorDigest, OPERATOR_CREDENTIAL,
    ]) {
      expect(unsafeText).not.toContain(secret);
    }
  } finally {
    try {
      if (started !== null) await started.close();
      provider?.close();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      rmSync(directory, { force: true, recursive: true });
    }
  }
});
