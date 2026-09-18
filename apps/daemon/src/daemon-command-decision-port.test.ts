import { DurableStoreError } from "@moe/store";
import { describe, expect, it } from "vitest";

import { DomainRefusal } from "./daemon-command-dispatch.js";
import { createCommandDecisionPort } from "./daemon-command-decision-port.js";
import type { CommandStoreFault } from "./daemon-command-decision-port.js";
import type { DecisionKey, DurableDecision } from "./http/http-contract.js";

const KEY: DecisionKey = { commandId: "cmd-1", principalId: "operator-local", projectId: "project-1" };
const STORE_FAULT = new DurableStoreError("OUTCOME_UNKNOWN", "disk I/O error at /var/lib/moe/events.db");

function harness(): {
  readonly faults: CommandStoreFault[];
  readonly port: ReturnType<typeof createCommandDecisionPort>;
} {
  const faults: CommandStoreFault[] = [];
  return { faults, port: createCommandDecisionPort({ onStoreFault: (fault) => { faults.push(fault); } }) };
}

describe("createCommandDecisionPort store-fault disclosure", () => {
  it("reports a store fault under a synchronous commit, beside the unchanged 503 refusal", () => {
    const { faults, port } = harness();

    const result = port.decide(KEY, "digest", () => { throw STORE_FAULT; });

    expect(result).toEqual({
      outcome: "REFUSED",
      refusal: {
        code: "OUTCOME_UNKNOWN", detail: STORE_FAULT.message, httpStatus: 503, layer: "DURABLE_STORE",
      },
    });
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      code: "OUTCOME_UNKNOWN",
      detail: STORE_FAULT.message,
      key: KEY,
      thrown: { code: "OUTCOME_UNKNOWN", name: "DurableStoreError" },
    });
    expect(faults[0]?.thrown.stack).toContain("daemon-command-decision-port.test");
  });

  it("reports a store fault under a rejected asynchronous commit the same way", async () => {
    const { faults, port } = harness();
    if (port.decideAsync === undefined) throw new Error("the daemon port serves the async half");

    const result = await port.decideAsync(KEY, "digest", async () => { throw STORE_FAULT; });

    expect(result.outcome).toBe("REFUSED");
    expect(faults.map((fault) => [fault.code, fault.key.commandId])).toEqual([["OUTCOME_UNKNOWN", "cmd-1"]]);
  });

  it("reports nothing for a thrown domain refusal: a verdict is not a fault", () => {
    const { faults, port } = harness();

    const result = port.decide(KEY, "digest", () => {
      throw new DomainRefusal("GOAL_NOT_FOUND", "DAEMON_GOALS", "no such goal", 404);
    });

    expect(result).toMatchObject({ outcome: "REFUSED", refusal: { code: "GOAL_NOT_FOUND", httpStatus: 404 } });
    expect(faults).toEqual([]);
  });

  it("reports nothing for a decided commit", () => {
    const { faults, port } = harness();
    const decision = { outcome: "ACCEPTED" } as unknown as DurableDecision;
    expect(port.decide(KEY, "digest", () => decision)).toEqual({ decision, outcome: "DECIDED" });
    expect(faults).toEqual([]);
  });

  it("still re-throws an unrecognised error, unreported: each transport reports that one itself", () => {
    const { faults, port } = harness();
    expect(() => port.decide(KEY, "digest", () => { throw new TypeError("handler bug"); })).toThrow("handler bug");
    expect(faults).toEqual([]);
  });

  it("keeps the 503 refusal when the observer itself throws", () => {
    const port = createCommandDecisionPort({ onStoreFault: () => { throw new Error("sink closed"); } });
    const result = port.decide(KEY, "digest", () => { throw STORE_FAULT; });
    expect(result).toMatchObject({ outcome: "REFUSED", refusal: { httpStatus: 503 } });
  });

  it("answers identically with no observer, so an unwired composition changes nothing", () => {
    const result = createCommandDecisionPort().decide(KEY, "digest", () => { throw STORE_FAULT; });
    expect(result).toMatchObject({ outcome: "REFUSED", refusal: { code: "OUTCOME_UNKNOWN", httpStatus: 503 } });
  });
});
