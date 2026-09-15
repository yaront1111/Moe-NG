import { afterEach, describe, expect, it } from "vitest";

import { closeStores } from "../bootstrap/bootstrap-test-fixtures.js";
import { attributed, attributionPlan as plan, REGISTRY_CHECK } from "./review-attribution-test-fixtures.js";
import type { ReviewOutcome } from "./review-ledger.js";
import { escalationPayload } from "./review-test-fixtures.js";

/**
 * The daemon half of finding attribution (addendum 2026-09-15), against a REAL approved plan in
 * UnAI's live shape (see `attributionPlan`).
 */
afterEach(closeStores);

const OWN_GAP = Object.freeze({
  detail: "the API does not answer a signed request yet", ruleId: "api-incomplete", severity: "MAJOR",
  subject: { kind: "CRITERION", locator: "crit-api" },
});

function codeOf(outcome: ReviewOutcome): string {
  return outcome.ok ? "EFFECTS_COMMITTED" : `${outcome.refusedBy}:${outcome.code}`;
}

describe("attribution against the approved plan", () => {
  it("records a finding the owning sibling must fix without charging the reporter", () => {
    const world = plan();

    const outcome = world.round([attributed("worker", ["crit-worker"])], "cmd-attributed");

    expect(codeOf(outcome)).toBe("EFFECTS_COMMITTED");
    const latest = world.ledger().rounds.at(-1)!;
    expect(latest.routing.route).toBe("ACCEPT");
    expect(world.ledger().lineage.unsuccessfulRounds).toBe(0);
    expect(latest.lineage.records[0]?.finding.attributedTo).toEqual({ criterionIds: ["crit-worker"], nodeKey: "worker" });
  });

  it("unblocks the live shape: an exhausted node is accepted on its own evidence after one allowed attempt", () => {
    const world = plan();
    for (const id of ["r1", "r2", "r3"]) expect(codeOf(world.round([REGISTRY_CHECK], id))).toBe("EFFECTS_COMMITTED");
    expect(world.ledger().rounds.at(-1)?.routing.route).toBe("ESCALATE");
    expect(codeOf(world.send("escalation.decide", escalationPayload({ subjectRef: world.api }), "cmd-allow"))).toBe("EFFECTS_COMMITTED");

    expect(codeOf(world.round([attributed("worker", ["crit-worker"])], "r-attributed"))).toBe("EFFECTS_COMMITTED");

    expect(world.ledger().rounds.at(-1)?.routing.route).toBe("ACCEPT");
    expect(world.ledger().lineage.unsuccessfulRounds).toBe(3);
  });

  it("still charges the reporter's own gap beside an attributed one", () => {
    const world = plan();

    expect(codeOf(world.round([attributed("worker", ["crit-worker"]), OWN_GAP], "cmd-mixed"))).toBe("EFFECTS_COMMITTED");

    expect(world.ledger().rounds.at(-1)?.routing.route).toBe("REJECT_IMPLEMENTATION");
    expect(world.ledger().lineage.unsuccessfulRounds).toBe(1);
  });

  const invalid: ReadonlyArray<readonly [string, (world: ReturnType<typeof plan>) => Record<string, unknown>]> = [
    ["the reporter itself", () => attributed("api", ["crit-api"])],
    ["a node outside the plan", () => attributed("registry", ["crit-worker"])],
    ["a criterion the reporter owns", () => attributed("worker", ["crit-worker", "crit-api"])],
    ["a criterion the named node does not own", () => attributed("worker", ["crit-ui"])],
    ["an unknown criterion", () => attributed("worker", ["crit-release"])],
    ["a finding about the reporter's own node", (world) => attributed("worker", ["crit-worker"],
      { ...REGISTRY_CHECK, subject: { kind: "NODE", locator: world.api } })],
    ["a finding about the reporter's own criterion", () => attributed("worker", ["crit-worker"],
      { ...REGISTRY_CHECK, subject: { kind: "CRITERION", locator: "crit-api" } })],
    ["a criterion subject owned by a different node", () => attributed("worker", ["crit-worker"],
      { ...REGISTRY_CHECK, subject: { kind: "CRITERION", locator: "crit-ui" } })],
  ];

  it.each(invalid)("refuses attribution to %s and writes nothing", (_label, build) => {
    const world = plan();
    const before = world.ledger().version;

    const outcome = world.round([build(world)], "cmd-invalid");

    expect(codeOf(outcome)).toBe("DAEMON_PREREQUISITE:REVIEW_FINDING_ATTRIBUTION_INVALID");
    expect(world.ledger().version).toBe(before);
  });

  it("refuses attribution on a subject that no sealed plan owns", () => {
    const world = plan();

    const outcome = world.round([attributed("worker", ["crit-worker"])], "cmd-foreign-subject", "node-outside-any-plan");

    expect(codeOf(outcome)).toBe("DAEMON_PREREQUISITE:REVIEW_FINDING_ATTRIBUTION_INVALID");
  });

  it("refuses an attribution that is not the closed shape at ingress", () => {
    const world = plan();

    const outcome = world.round([{ ...REGISTRY_CHECK, attributedTo: { nodeKey: "worker" } }], "cmd-shape");

    expect(codeOf(outcome)).toBe("DAEMON_INGRESS:REVIEW_PAYLOAD_INVALID");
  });
});
