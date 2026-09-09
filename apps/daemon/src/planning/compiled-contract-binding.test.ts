import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GOAL_ID, PROJECT_ID, RUN_ID, closeStores } from "../bootstrap/bootstrap-test-fixtures.js";
import { approveGate1, boundWorld, committedRevision, submit } from "./plan-reject-test-fixtures.js";

afterEach(closeStores);
const aggregate = (projectId: string, runId: string): string => `compiled-contract/${createHash("sha256")
  .update(JSON.stringify(["moe-compiled-contract/1", projectId, runId])).digest("hex")}`;

describe("compiled Product Contract binding", () => {
  it("atomically records the full approved revision on the same decision as its planned run", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    const result = submit(store, ref);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const rows = store.readAggregateEvents(aggregate(PROJECT_ID, RUN_ID), 0, 2).items;
    expect(rows).toHaveLength(1);
    const event = rows[0]!;
    expect(event.eventType).toBe("CompiledContractBound");
    expect(JSON.parse(Buffer.from(event.payload).toString("utf8"))).toMatchObject({
      version: "moe-compiled-contract/1", projectId: PROJECT_ID, goalRef: GOAL_ID,
      planningRunRef: RUN_ID, contractRef: ref, graphContentHash: result.graphContentHash,
      submissionHash: result.submissionHash,
    });
    const proposed = store.readAggregateEvents(RUN_ID, 0, 2).items.find((item) => item.eventType === "PlanProposed");
    expect(event.decisionTrace).toEqual(proposed?.decisionTrace);
    expect(submit(store, ref)).toMatchObject({ ok: true, disposition: "REPLAYED" });
    expect(store.getAggregateVersion(aggregate(PROJECT_ID, RUN_ID))).toBe(1);
  });

  it("a refused plan cannot leave a contract binding behind", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    expect(submit(store, ref, { structure: { completionNodeKey: "missing", nodes: [] } }).ok).toBe(false);
    expect(store.getAggregateVersion(aggregate(PROJECT_ID, RUN_ID))).toBe(0);
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });
});
