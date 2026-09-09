import { describe, expect, it } from "vitest";
import { decodeRepositoryRecoveryPayload } from "./repository-recovery-codec.js";

const payload = { action: "ABORT_UNEXECUTED", decision: "APPROVE", expectedReservationRevision: 7,
  nodeRef: "graph:node", reason: "The attempt was cancelled before execution." };
describe("operator repository recovery request", () => {
  it.each(["ABORT_UNEXECUTED", "RECONCILE_LANDED"])("decodes the exact explicit %s decision", (action) => {
    const input = { ...payload, action }; const parsed = decodeRepositoryRecoveryPayload(input);
    expect(parsed).toEqual(input); expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([
    ["implicit decision", { ...payload, decision: undefined }], ["refusal", { ...payload, decision: "REJECT" }],
    ["unknown action", { ...payload, action: "FORCE_UNLOCK" }], ["negative revision", { ...payload, expectedReservationRevision: -1 }],
    ["unsafe revision", { ...payload, expectedReservationRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing reason", { ...payload, reason: " " }], ["unbounded reason", { ...payload, reason: "a".repeat(2049) }],
    ["caller token", { ...payload, ownershipToken: "a".repeat(64) }], ["caller path", { ...payload, workspace: "C:/repo" }],
    ["caller command id", { ...payload, commandId: "forged" }], ["caller containment", { ...payload, childDead: true }],
  ])("refuses %s", (_name, input) => expect(decodeRepositoryRecoveryPayload(input)).toBeNull());
  it("does not invoke accessors or accept inherited request fields", () => {
    let reads = 0;
    const input = { ...payload }; Object.defineProperty(input, "reason", { get: () => { reads += 1; return payload.reason; }, enumerable: true });
    expect(decodeRepositoryRecoveryPayload(input)).toBeNull(); expect(reads).toBe(0);
    expect(decodeRepositoryRecoveryPayload(Object.create(payload))).toBeNull();
  });
});
