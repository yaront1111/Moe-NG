import { afterEach, describe, expect, it } from "vitest";
import { closeStores, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { agentCapabilitiesFor, OPERATOR_PRINCIPAL_KINDS } from "../daemon-command-vocabulary.js";
import { MCP_EXCLUDED_COMMAND_KINDS, wiredMcpToolKinds } from "../mcp-tool-allowlist.js";
import { criterionWorld } from "./criterion-test-fixtures.js";
import { CRITERION_APPROVE, CRITERION_VERIFY } from "./criterion-contracts.js";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { GOAL_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { handleCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import type { TransportOrigin } from "../http/http-contract.js";
import { criterionCatalogId } from "./criterion-storage.js";

afterEach(closeStores);
describe("criterion commands at the daemon registry", () => {
  it.each([CRITERION_APPROVE, CRITERION_VERIFY])("serves %s only to the operator surface", (kind) => {
    const { store } = criterionWorld();
    const ports = createDaemonCommandPorts({ store, projectId: PROJECT_ID, operatorPrincipalId: "operator-local",
      clock: () => "2026-09-06T00:00:00.000Z" });
    expect(ports.registry.get(kind as never)).toBeDefined();
    expect(OPERATOR_PRINCIPAL_KINDS.has(kind as never)).toBe(true);
    expect(MCP_EXCLUDED_COMMAND_KINDS).toContain(kind);
    expect(wiredMcpToolKinds()).not.toContain(kind);
    expect(agentCapabilitiesFor(kind)).toBeNull();
  });
  it("dispatches a paired human approval over HTTP and fences MCP plus caller target substitution before a write", () => {
    const { store, service, human, approvalInput } = criterionWorld();
    const ports = createDaemonCommandPorts({ store, projectId: PROJECT_ID, operatorPrincipalId: "operator-local",
      criterionEvidence: service, clock: () => "2026-09-06T00:00:00.000Z" });
    const target = criterionCatalogId(PROJECT_ID, GOAL_ID, RUN_ID);
    const input = approvalInput("crit-api", 0);
    const send = (origin: TransportOrigin, targetAggregateId = target) => handleCommandRequest({ ...ports,
      authenticator: { authenticate: () => ({ verdict: "AUTHENTICATED", principal: {
        principalId: human.principalId, projectId: PROJECT_ID, capabilities: OPERATOR_CAPABILITIES,
      } }) } }, { credential: "paired-human", protocolVersion: WIRE_PROTOCOL_VERSION,
      body: new TextEncoder().encode(JSON.stringify({ ...input, principalId: undefined,
        commandKind: CRITERION_APPROVE, targetAggregateId, requestDigest: "a".repeat(64),
        schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: "paired-human" })) }, origin);
    for (const origin of ["MCP_HTTP", "MCP_STDIO", "AGENT_WRAPPER"] as const) {
      expect(send(origin)).toMatchObject({ outcome: "PORT_REFUSED", stage: "DISPATCH",
        refusal: { code: "CRITERION_CHECK_TRANSPORT_DENIED", layer: "CRITERION_EVIDENCE" } });
      expect(store.getAggregateVersion(target)).toBe(0);
    }
    expect(send("HTTP_LISTENER", "foreign-target")).toMatchObject({ outcome: "PORT_REFUSED",
      refusal: { code: "CRITERION_CHECK_TARGET_MISMATCH", layer: "CRITERION_EVIDENCE" } });
    expect(store.getAggregateVersion(target)).toBe(0);
    expect(send("HTTP_LISTENER")).toMatchObject({ outcome: "ACCEPTED",
      decision: { resultCode: "CRITERION_CHECK_APPROVED", disposition: "DECIDED" } });
    expect(store.getAggregateVersion(target)).toBe(1);
  });
});
