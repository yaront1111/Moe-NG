import { afterEach, expect, it } from "vitest";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { wiredMcpToolKinds } from "../mcp-tool-allowlist.js";
import { closeStores, driveRounds, openStore, PROJECT_ID, SUBJECT_REF } from "./review-test-fixtures.js";
import { readReviewLedger } from "./review-read-model.js";

afterEach(closeStores);
function world() {
  const store = openStore(); installTestRecoveryBinding(store); driveRounds(store, 3);
  const entry = createDaemonCommandPorts({ store, projectId: PROJECT_ID, operatorPrincipalId: "operator",
    clock: () => new Date().toISOString() }).registry.get("escalation.decide")!;
  const decide = (principalId: string) => entry.handler({
    principal: { principalId, projectId: PROJECT_ID, capabilities: OPERATOR_CAPABILITIES },
    envelope: { schemaVersion: "moe-runtime-command/1", requestDigest: "a".repeat(64), sessionCredential: "test",
      commandId: `human-escalation-${principalId}`, commandKind: "escalation.decide", correlationId: "human-test",
      targetAggregateId: SUBJECT_REF, expectedVersion: 3,
      payload: { decision: "ALLOW_MORE_ATTEMPTS", escalationRef: "escalation-1", subjectRef: SUBJECT_REF } },
  });
  return { store, decide };
}
it("refuses an agent granting itself another attempt despite all capabilities", () => {
  const w = world(); const before = w.store.readEventHorizon();
  expect(() => w.decide("agent-with-admin-and-review"))
    .toThrowError(expect.objectContaining({ code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" }));
  expect(w.store.readEventHorizon()).toBe(before);
  expect(readReviewLedger(w.store, PROJECT_ID, SUBJECT_REF).continuation).toBeUndefined();
});
it.each(["operator", "paired human"])("allows the %s to grant one bounded attempt", (kind) => {
  const w = world(); let principalId = "operator";
  if (kind === "paired human") {
    const human = createOperatorSessionHandshakePort({ store: w.store, projectId: PROJECT_ID,
      operatorPrincipalId: "operator", capabilities: OPERATOR_CAPABILITIES,
      clock: () => Date.now(), sessionTtlMs: 60_000 }).mint();
    if (!human.ok) throw Error(human.code); principalId = human.principalId;
  }
  expect(w.decide(principalId)).toMatchObject({ disposition: "DECIDED" });
  expect(readReviewLedger(w.store, PROJECT_ID, SUBJECT_REF).continuation?.decisionVersion).toBe(4);
});
it("does not advertise human escalation decisions to an agent MCP session", () => {
  expect(wiredMcpToolKinds()).not.toContain("escalation.decide");
});
