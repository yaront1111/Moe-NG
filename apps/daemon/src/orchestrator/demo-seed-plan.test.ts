import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { COMMAND_PREREQUISITES } from "../bootstrap/bootstrap-sequence.js";
import { DEMO_SEED_KINDS, buildDemoSeedPlan, toWireEnvelope } from "./demo-seed-plan.js";
import { DEMO_VALIDATABLE_POLICY_REF } from "./demo-seed-payloads.js";
import type { DemoSeedInput, SeedCommand } from "./demo-seed-plan.js";
import { formatDaemonRefusal, readDaemonRefusal } from "./demo-seed-refusal.js";

/**
 * The seed's shapes are pinned against PRODUCTION authority, not against a second
 * hand-written list: the order property is checked against `COMMAND_PREREQUISITES`
 * (the table the daemon itself enforces) and the schema version against the
 * bootstrap contract. A hand-written expectation on both sides would be a
 * tautology that stays green while the daemon's rule moves.
 */

const NODE = Object.freeze({
  instructions: "Create math.mjs exporting add and multiply so test.mjs passes.",
  nodeRef: "node-code-1",
  test: "node test.mjs",
  title: "Implement the math module",
  workspace: "D:/demo/workspace",
});

const INPUT: DemoSeedInput = Object.freeze({
  correlationId: "corr-demo",
  decidedAt: "2026-08-18T00:00:00.000Z",
  goalId: "goal-demo",
  node: NODE,
  principalId: "principal-demo",
  projectId: "project-demo",
  runId: "run-demo",
});

const byKind = (plan: readonly SeedCommand[], kind: string): SeedCommand => {
  const found = plan.find((command) => command.commandKind === kind);
  if (found === undefined) throw new Error(`the plan never builds ${kind}`);
  return found;
};

describe("buildDemoSeedPlan order", () => {
  it("builds the J1 chain in an order the daemon's own prerequisite table admits", () => {
    const plan = buildDemoSeedPlan(INPUT);
    const seen = new Set<string>();

    // A sweep that generates zero checks passes while testing nothing.
    expect(plan.length).toBeGreaterThan(0);
    let checkedPrerequisites = 0;
    for (const command of plan) {
      const required =
        COMMAND_PREREQUISITES[command.commandKind as keyof typeof COMMAND_PREREQUISITES];
      expect(required).toBeDefined();
      for (const prerequisite of required) {
        checkedPrerequisites += 1;
        expect({ kind: command.commandKind, missing: prerequisite, satisfied: seen.has(prerequisite) })
          .toEqual({ kind: command.commandKind, missing: prerequisite, satisfied: true });
      }
      seen.add(command.commandKind);
    }
    expect(checkedPrerequisites).toBeGreaterThan(0);
  });

  it("ends on approval.decide, the commit that puts a node on the surface", () => {
    const plan = buildDemoSeedPlan(INPUT);

    expect(plan[plan.length - 1]?.commandKind).toBe("approval.decide");
  });

  it("names provider.probe, which project.activate requires and a shorter chain omits", () => {
    const plan = buildDemoSeedPlan(INPUT);
    const kinds = plan.map((command) => command.commandKind);

    expect(COMMAND_PREREQUISITES["project.activate"]).toContain("provider.probe");
    expect(kinds.indexOf("provider.probe")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("provider.probe")).toBeLessThan(kinds.indexOf("project.activate"));
    expect(kinds).toEqual([...DEMO_SEED_KINDS]);
  });
});

describe("buildDemoSeedPlan envelopes", () => {
  it("carries the project's version choreography on the project stream", () => {
    const plan = buildDemoSeedPlan(INPUT);

    expect(byKind(plan, "project.register").expectedVersion).toBe(0);
    expect(byKind(plan, "project.bind_repository").expectedVersion).toBe(1);
    expect(byKind(plan, "project.activate").expectedVersion).toBe(2);
  });

  it("starts probe, goal, plan and approval at version 0 on their own streams", () => {
    const plan = buildDemoSeedPlan(INPUT);

    for (const kind of ["provider.probe", "goal.create", "plan.propose", "approval.decide"]) {
      expect({ kind, version: byKind(plan, kind).expectedVersion })
        .toEqual({ kind, version: 0 });
    }
  });

  it("carries the caller's correlation id and an honest target aggregate", () => {
    const plan = buildDemoSeedPlan(INPUT);

    for (const command of plan) {
      expect(command.correlationId).toBe(INPUT.correlationId);
    }
    // Probe rides its own stream, which is what keeps it out of the project's
    // 0 -> 1 -> 2 version line (bootstrap-sequence.ts aggregateIdFor).
    expect(byKind(plan, "provider.probe").targetAggregateId).toBe(`${INPUT.projectId}-provider`);
    expect(byKind(plan, "project.activate").targetAggregateId).toBe(INPUT.projectId);
    expect(byKind(plan, "goal.create").targetAggregateId).toBe(INPUT.goalId);
    expect(byKind(plan, "approval.decide").targetAggregateId).toBe(INPUT.runId);
  });

  it("gives every command a distinct id so a durable commit is attributable", () => {
    const plan = buildDemoSeedPlan(INPUT);
    const ids = plan.map((command) => command.commandId);

    expect(new Set(ids).size).toBe(plan.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it("installs a validatable policy at the 64-hex address the payload hint names", () => {
    // Live run 2026-08-20: with only the two non-hex installs, the seeded surface offered
    // policy.validate as a READY step no input could satisfy — BOOTSTRAP_POLICY_UNKNOWN on
    // every shape — and the wrapper restaffed it forever. The third install is the one
    // address `evaluatePolicy` can accept and the development hint actually names.
    const plan = buildDemoSeedPlan(INPUT);
    const installs = plan.filter((command) => command.commandKind === "policy.install");

    expect(installs).toHaveLength(3);
    expect(installs.map((command) => command.expectedVersion)).toEqual([0, 1, 2]);
    const validatable = installs[2]?.payload["slice"] as Record<string, unknown>;
    expect(validatable["sliceRef"]).toBe(DEMO_VALIDATABLE_POLICY_REF);
    expect(validatable["sliceRef"]).toMatch(/^[0-9a-f]{64}$/u);
    // The verifier and calibration slices live at deliberately NON-hex addresses: they can
    // never be named as policy revisions, which is exactly why they cannot carry validate.
    for (const install of installs.slice(0, 2)) {
      const slice = install.payload["slice"] as Record<string, unknown>;
      expect(String(slice["sliceRef"])).not.toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("approves at goal version 1, the version goal.create leaves behind", () => {
    const approval = byKind(buildDemoSeedPlan(INPUT), "approval.decide");
    const activation = approval.payload["activation"] as Record<string, unknown>;

    expect(activation["expectedGoalVersion"]).toBe(1);
  });

  it("scopes the approval to the demo node so the approved node is the seeded one", () => {
    const approval = byKind(buildDemoSeedPlan(INPUT), "approval.decide");
    const record = approval.payload["record"] as Record<string, unknown>;

    expect(record["approvedNodeScope"]).toEqual([NODE.nodeRef]);
  });

  it("proposes the planning chain against the caller's run", () => {
    const propose = byKind(buildDemoSeedPlan(INPUT), "plan.propose");
    const commands = propose.payload["commands"] as readonly Record<string, unknown>[];

    expect(propose.payload["runId"]).toBe(INPUT.runId);
    expect(commands.map((command) => command["kind"])).toEqual([
      "planning.create_draft",
      "planning.ready",
      "planning.claim",
      "plan.propose",
    ]);
    expect(commands.map((command) => command["expectedVersion"])).toEqual([0, 1, 2, 3]);
  });

  it("is deterministic: no clock and no randomness leak into the bytes", () => {
    const first = JSON.stringify(buildDemoSeedPlan(INPUT));
    const second = JSON.stringify(buildDemoSeedPlan(INPUT));

    expect(first).toBe(second);
  });

  it("hands back frozen envelopes, so a caller cannot rewrite one in flight", () => {
    const plan = buildDemoSeedPlan(INPUT);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.every((command) => Object.isFrozen(command))).toBe(true);
  });
});

describe("readDaemonRefusal", () => {
  it("echoes a listener refusal's code and layer verbatim", () => {
    const echo = readDaemonRefusal({ code: "LISTENER_CSRF_INVALID", layer: "CONTROL_ROOM_LISTENER" });

    expect(echo?.code).toBe("LISTENER_CSRF_INVALID");
    expect(echo?.layer).toBe("CONTROL_ROOM_LISTENER");
    expect(echo?.source).toBe("LISTENER");
  });

  it("echoes a port refusal's own code and layer, not a boundary translation", () => {
    const echo = readDaemonRefusal({
      httpStatus: 409,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: {
        code: "STORE_VERSION_CONFLICT",
        detail: "expected version 0",
        httpStatus: 409,
        layer: "STATE",
      },
      stage: "DISPATCH",
    });

    expect(echo?.code).toBe("STORE_VERSION_CONFLICT");
    expect(echo?.layer).toBe("STATE");
    expect(echo?.detail).toBe("expected version 0");
    expect(echo?.stage).toBe("DISPATCH");
  });

  it("reports a runtime-error refusal's stage and states that it named no layer", () => {
    const echo = readDaemonRefusal({
      error: { code: "COMMAND_UNAUTHENTICATED", details: {} },
      httpStatus: 401,
      ok: false,
      outcome: "REFUSED",
      stage: "AUTHENTICATE",
    });

    expect(echo?.code).toBe("COMMAND_UNAUTHENTICATED");
    expect(echo?.layer).toBeNull();
    expect(echo?.stage).toBe("AUTHENTICATE");
    expect(echo?.source).toBe("ERROR");
  });

  it("refuses to invent a code for a body that states none", () => {
    expect(readDaemonRefusal({ outcome: "ACCEPTED" })).toBeNull();
    expect(readDaemonRefusal("not json at all")).toBeNull();
    expect(readDaemonRefusal(null)).toBeNull();
  });
});

describe("formatDaemonRefusal", () => {
  it("prints the daemon's code and its layer, both verbatim", () => {
    const echo = readDaemonRefusal({ code: "LISTENER_ORIGIN_INVALID", layer: "CONTROL_ROOM_LISTENER" });
    if (echo === null) throw new Error("expected a readable refusal");
    const line = formatDaemonRefusal("project.register", echo);

    expect(line).toContain("LISTENER_ORIGIN_INVALID");
    expect(line).toContain("CONTROL_ROOM_LISTENER");
    expect(line).toContain("project.register");
  });

  it("says the daemon stated no layer rather than printing a plausible one", () => {
    const echo = readDaemonRefusal({
      error: { code: "COMMAND_UNAUTHENTICATED", details: {} },
      httpStatus: 401,
      ok: false,
      outcome: "REFUSED",
      stage: "AUTHENTICATE",
    });
    if (echo === null) throw new Error("expected a readable refusal");
    const line = formatDaemonRefusal("goal.create", echo);

    expect(line).toContain("COMMAND_UNAUTHENTICATED");
    expect(line).toContain("layer=(none stated)");
    expect(line).toContain("stage=AUTHENTICATE");
  });
});

describe("toWireEnvelope", () => {
  const first = buildDemoSeedPlan(INPUT)[0] as SeedCommand;

  it("seals the runtime envelope POST /command decodes, not the internal one", () => {
    const sealed = toWireEnvelope(first, "operator-secret");

    expect(sealed.schemaVersion).toBe(RUNTIME_COMMAND_ENVELOPE_VERSION);
    expect(sealed.commandKind).toBe(first.commandKind);
    expect(sealed.sessionCredential).toBe("operator-secret");
    expect(sealed.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("digests the REQUEST, so the same request under two credentials has one identity", () => {
    const mine = toWireEnvelope(first, "credential-a");
    const theirs = toWireEnvelope(first, "credential-b");

    expect(mine.requestDigest).toBe(theirs.requestDigest);
  });

  it("is a real digest: a different payload is a different request identity", () => {
    const other = buildDemoSeedPlan({ ...INPUT, projectId: "other-project" })[0] as SeedCommand;

    expect(toWireEnvelope(other, "credential-a").requestDigest)
      .not.toBe(toWireEnvelope(first, "credential-a").requestDigest);
  });
});
