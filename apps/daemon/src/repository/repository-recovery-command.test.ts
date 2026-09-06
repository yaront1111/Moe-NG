import { afterEach, expect, it, vi } from "vitest";
import { closeStores, openStore, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { OPERATOR_CAPABILITIES, PAYLOAD_KEYS } from "../daemon-command-vocabulary.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
afterEach(closeStores);
it("serves recovery only as an async human command and preserves the service result", async () => {
  const store = openStore();
  installTestRecoveryBinding(store);
  const human = createOperatorSessionHandshakePort({ store, projectId: PROJECT_ID, operatorPrincipalId: "operator",
    capabilities: OPERATOR_CAPABILITIES, clock: () => Date.now(), sessionTtlMs: 60000 }).mint();
  if (!human.ok) throw new Error(human.code);
  const recover = vi.fn(async () => ({ ok: true as const, commandId: "recovery-a", disposition: "COMMITTED" as const, resultCode: "REPOSITORY_RECOVERY_RELEASED" as const }));
  const entry = createDaemonCommandPorts({ store, projectId: PROJECT_ID, operatorPrincipalId: "operator", clock: () => new Date().toISOString(), repositoryRecovery: { recover } }).registry.get("repository.recover");
  expect(entry?.asyncHandler).toBeTypeOf("function");
  expect(entry?.payloadKeys).toBe(PAYLOAD_KEYS["repository.recover"]);
  expect(Object.isFrozen(entry?.payloadKeys)).toBe(true);
  if (entry?.asyncHandler === undefined) throw new Error("recovery entry missing");
  const input: CommandHandlerInput = { envelope: { schemaVersion: "moe-runtime-command/1", requestDigest: "a".repeat(64), sessionCredential: "test-session",
    commandId: "recovery-a", commandKind: "repository.recover", correlationId: "correlation-a", expectedVersion: 2,
    targetAggregateId: "recovery-owner", payload: { action: "ABORT_UNEXECUTED", decision: "APPROVE", nodeRef: "node-a", expectedReservationRevision: 7, reason: "Never started" } },
    principal: { principalId: human.principalId, projectId: PROJECT_ID, capabilities: OPERATOR_CAPABILITIES } };
  expect(await entry.asyncHandler(input)).toEqual({ commandId: "recovery-a", disposition: "DECIDED", effectId: null, resultCode: "REPOSITORY_RECOVERY_RELEASED" });
  expect(recover).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 2, targetAggregateId: "recovery-owner", principalId: human.principalId, operatorPrincipalId: "operator" }));
  recover.mockClear();
  await expect(entry.asyncHandler({ ...input, principal: { ...input.principal, principalId: "agent-admin" } })).rejects.toMatchObject({ code: "REPOSITORY_RECOVERY_HUMAN_REQUIRED", layer: "REPOSITORY_RECOVERY" });
  expect(recover).not.toHaveBeenCalled();
});
