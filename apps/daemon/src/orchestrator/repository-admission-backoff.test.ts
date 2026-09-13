import { describe, expect, it } from "vitest";
import type { SpawnReport } from "./agent-spawn-contract.js";
import { createRepositoryAdmissionBackoff } from "./repository-admission-backoff.js";
import { deliveryRefusal } from "./repository-delivery-contracts.js";

const blocked: SpawnReport = { kind: "node.deliver", outcome: "REPOSITORY_DELIVERY_BASELINE_UNAVAILABLE",
  refusal: deliveryRefusal("REPOSITORY_DELIVERY_BASELINE_UNAVAILABLE"), sessionId: "closed-seat", workItemId: "node.deliver@n" };

describe("repository admission automatic rechecks", () => {
  it("rechecks admission if the wall clock moves backwards during a wait", () => {
    const backoff = createRepositoryAdmissionBackoff();
    backoff.record(blocked, 1, 3_600_000);
    expect(backoff.waiting(blocked.workItemId, 1, 3_605_000)).not.toBeNull();
    expect(backoff.waiting(blocked.workItemId, 1, 3_604_000)).toBeNull();
    backoff.record(blocked, 1, 1_000);
    expect(backoff.waiting(blocked.workItemId, 1, 1_000)?.retryAt).toBe(16_000);
  });
  it("slows an unchanged refusal but always allows a fresh recheck within one minute", () => {
    const backoff = createRepositoryAdmissionBackoff();
    let now = 1_000;
    for (const delay of [15_000, 30_000, 60_000, 60_000, 60_000]) {
      backoff.record(blocked, 1, now);
      expect(backoff.waiting(blocked.workItemId, 1, now)).toMatchObject({ retryAt: now + delay });
      expect(backoff.waiting(blocked.workItemId, 1, now + delay - 1)).not.toBeNull();
      now += delay;
      expect(backoff.waiting(blocked.workItemId, 1, now)).toBeNull();
    }
  });
  it("does not delay an independent item or a new version of the work", () => {
    const backoff = createRepositoryAdmissionBackoff();
    backoff.record(blocked, 1, 1_000);
    expect(backoff.waiting("node.deliver@other", 1, 1_001)).toBeNull();
    expect(backoff.waiting(blocked.workItemId, 2, 1_001)).toBeNull();
    backoff.record(blocked, 2, 1_001);
    expect(backoff.waiting(blocked.workItemId, 2, 1_001)?.retryAt).toBe(16_001);
  });
  it("re-arms when work leaves READY or a start succeeds", () => {
    const backoff = createRepositoryAdmissionBackoff();
    backoff.record(blocked, 1, 1_000);
    backoff.retain(new Set([blocked.workItemId]));
    expect(backoff.waiting(blocked.workItemId, 1, 1_000)).not.toBeNull();
    backoff.retain(new Set());
    expect(backoff.waiting(blocked.workItemId, 1, 1_000)).toBeNull();
    backoff.record(blocked, 1, 1_000);
    backoff.record({ ...blocked, refusal: null, outcome: "SPAWNED" }, 1, 1_000);
    expect(backoff.waiting(blocked.workItemId, 1, 1_000)).toBeNull();
  });
});
