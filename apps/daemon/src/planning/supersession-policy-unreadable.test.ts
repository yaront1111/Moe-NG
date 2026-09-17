import { describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { readSupersessionPolicyDecision } from "./supersession-policy-decision.js";

/**
 * AN UNREADABLE POLICY AGGREGATE IS NOT AN UNEVALUATED ONE.
 *
 * `policyEvents` answered `[]` on a store throw, and the newest-first walk below it then never
 * executes, so the tail refuses SUPERSESSION_POLICY_DECISION_ABSENT — the affirmative claim that
 * no policy decision was ever evaluated for this project. `graph-supersede-approval-binding`
 * carries that code upward as its upstream diagnosis, so a SQLITE_BUSY reads to the operator as
 * a missing policy evaluation. They re-install the policy, the write succeeds, the refusal
 * persists, because the READ is what is failing.
 *
 * Same shape, and same fix, as the landed ADMISSION_GATE_EVIDENCE_UNREADABLE.
 */

const SUCCESSOR = "graph-revision-2";

const throwingStore = (): SqliteEventStore => ({
  readEvents: (): never => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  },
}) as unknown as SqliteEventStore;

const emptyStore = (): SqliteEventStore =>
  ({ readEvents: () => [] }) as unknown as SqliteEventStore;

describe("readSupersessionPolicyDecision", () => {
  it("refuses UNREADABLE, not ABSENT, when the policy aggregate cannot be read", () => {
    expect(readSupersessionPolicyDecision(throwingStore(), "project-1", SUCCESSOR))
      .toMatchObject({
        code: "SUPERSESSION_POLICY_DECISION_UNREADABLE",
        layer: "DAEMON_SUPERSESSION_POLICY_DECISION",
        ok: false,
      });
  });

  it("still refuses ABSENT when the project genuinely has no policy decision", () => {
    expect(readSupersessionPolicyDecision(emptyStore(), "project-1", SUCCESSOR))
      .toMatchObject({ code: "SUPERSESSION_POLICY_DECISION_ABSENT", ok: false });
  });

  it("confers nothing on either arm, so the fence direction is unchanged", () => {
    for (const store of [throwingStore(), emptyStore()]) {
      const result = readSupersessionPolicyDecision(store, "project-1", SUCCESSOR);

      expect(result.ok).toBe(false);
      expect("decision" in result).toBe(false);
    }
  });
});
