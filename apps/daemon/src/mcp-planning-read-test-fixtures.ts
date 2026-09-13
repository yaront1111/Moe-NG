import { createHash } from "node:crypto";
import { createHttpMcpAdapter } from "@moe/mcp";
import type { HttpDispatchPort } from "@moe/mcp";
import type { ProductContractRevisionRef } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { GOAL_ID, PROJECT_ID } from "./bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts, OPERATOR_CAPABILITIES } from "./daemon-command-registry.js";
import { designRevisionFixture } from "./design/design-test-fixtures.js";
import { submitDesignRevision } from "./design/design-store.js";
import { streamPort } from "./http/event-stream-fixtures.js";
import { createSessionAuthenticator } from "./identity/session-authenticator.js";
import { createMcpHttpSessionPort } from "./mcp-http/mcp-http-session-port.js";
import { createDesignReadPort } from "./mcp-design-read-query.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import { wiredMcpToolKinds } from "./mcp-tool-allowlist.js";
import { OPERATOR, PRD_SHA, approveGate1, boundWorld, committedRevision } from "./planning/plan-reject-test-fixtures.js";
import { createProductContractReadPort } from "./product-contract/product-contract-read-port.js";
import type { ProductContractReadResult } from "./product-contract/product-contract-read-port.js";
import { runProductContractProposeRevision } from "./product-contract/product-contract-propose-service.js";

const CREDENTIAL = "planning-read-transport-operator";
const AGENT = "planning-read-transport-agent";
const NOW = "2026-09-06T00:00:00.000Z";

export function largeApprovedContract(store: SqliteEventStore): ProductContractRevisionRef {
  const requirements = Array.from({ length: 180 }, (_, index) => ({
    requirementId: `req-${String(index).padStart(3, "0")}`,
    statement: `Requirement ${index}: ${"user-visible behavior ".repeat(9)}`,
    supersedesRequirementId: null,
  }));
  const outcome = runProductContractProposeRevision(store, {
    correlationId: "corr-large-contract", decidedAt: NOW, principalId: OPERATOR, projectId: PROJECT_ID,
    payload: { goalRef: GOAL_ID, draft: {
      authorRef: OPERATOR, contractId: "contract-large", revisionId: "revision-large", lineage: null,
      requirements, criteria: requirements.map((requirement, index) => ({
        criterionId: `crit-${String(index).padStart(3, "0")}`, requirementId: requirement.requirementId,
        statement: `Criterion ${index}: ${"observable acceptance outcome ".repeat(9)}`,
        supersedesCriterionId: null,
      })), retiredCriterionIds: [], retiredRequirementIds: [], sourceDocumentDigests: [PRD_SHA],
    } },
  });
  if (!outcome.ok) throw new Error(`large contract setup refused: ${outcome.code}`);
  return outcome.ref;
}

export async function planningReadWorld(large = false, largeDesign = false) {
  const store = boundWorld();
  const ref = large ? largeApprovedContract(store) : committedRevision(store);
  approveGate1(store, ref);
  const design = submitDesignRevision(store, {
    commandId: "cmd-read-design", contractRef: ref, correlationId: "corr-read-design",
    decidedAt: NOW, expectedVersion: 0, goalRef: GOAL_ID, principalId: OPERATOR,
    projectId: PROJECT_ID, revision: { ...designRevisionFixture(), ...(largeDesign ? {
      openDecisions: Array.from({ length: 12 }, (_, index) => `Decision ${index}: ${'"\\😀 '.repeat(600)}`),
    } : {}) },
  });
  if (!design.ok) throw new Error(`design setup refused: ${design.code}`);
  const ports = createDaemonCommandPorts({ clock: () => NOW, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store });
  const authenticator = createSessionAuthenticator(store, {
    clock: () => Date.parse(NOW), operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: CREDENTIAL, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID,
  });
  const contract = createProductContractReadPort({ projectId: PROJECT_ID, store });
  let contractOverride: ProductContractReadResult | undefined;
  const port: HttpDispatchPort = createMcpDispatchPort({ contract: { read: (goalRef) => contractOverride ?? contract.read(goalRef) }, design: createDesignReadPort({ store }),
    deps: { authenticator, decisions: ports.decisions, registry: ports.registry }, subscriptions: streamPort() });
  const payload = { capabilities: ["goal.write", "work.claim"],
    credentialSha256: createHash("sha256").update(AGENT).digest("hex"),
    expiresAt: "2027-01-01T00:00:00.000Z", sessionId: "sess-planning-read-agent" };
  const opened = JSON.parse(new TextDecoder().decode(await port.dispatchCommandBytes(new TextEncoder().encode(JSON.stringify({
    commandId: "cmd-read-session", commandKind: "session.open", correlationId: "corr-read-session", expectedVersion: 0,
    payload, requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    schemaVersion: "moe-runtime-command/1", sessionCredential: CREDENTIAL, targetAggregateId: "sess-planning-read-agent",
  })), { credential: CREDENTIAL })));
  if (opened.outcome !== "ACCEPTED") throw new Error(`session setup refused: ${JSON.stringify(opened)}`);
  const dispatches: string[] = [];
  const adapter = createHttpMcpAdapter({ enableJsonResponse: true,
    sessionPort: createMcpHttpSessionPort(authenticator), toolAllowlist: wiredMcpToolKinds(),
    dispatchPort: {
      authenticate: port.authenticate,
      dispatchCommandBytes: (bytes, context) => { dispatches.push("command"); return port.dispatchCommandBytes(bytes, context); },
      dispatchQueryBytes: (bytes, context) => { dispatches.push("query"); return port.dispatchQueryBytes(bytes, context); },
    },
  });
  let sessionId: string | null = null;
  let requestId = 0;
  const rpc = async (method: string, params: object, credential = AGENT): Promise<Response> => adapter.handleRequest(new Request("http://127.0.0.1/mcp", {
    method: "POST", body: JSON.stringify({ id: ++requestId, jsonrpc: "2.0", method, params }),
    headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${credential}`,
      "content-type": "application/json", host: "127.0.0.1",
      ...(sessionId === null ? {} : { "mcp-session-id": sessionId }) },
  }));
  const initialized = await rpc("initialize", { capabilities: {}, protocolVersion: "2025-06-18",
    clientInfo: { name: "planning-read-test", version: "1" } });
  await initialized.text();
  sessionId = initialized.headers.get("mcp-session-id");
  if (initialized.status !== 200 || sessionId === null) throw new Error("MCP session setup failed");
  return { adapter, contract, dispatches, ref, rpc, store,
    setContractAnswer: (answer: ProductContractReadResult): void => { contractOverride = answer; },
    call: async (name: string, body: object): Promise<Record<string, unknown>> => {
      const response = await rpc("tools/call", { name, arguments: { correlationId: `corr-read-${requestId}`, payload: body } });
      const frame = await response.json() as { result?: { content?: { text: string }[] }; error?: unknown };
      const text = frame.result?.content?.[0]?.text;
      return text === undefined ? { transportError: frame.error } : JSON.parse(text) as Record<string, unknown>;
    },
  };
}
