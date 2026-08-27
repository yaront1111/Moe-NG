import { describe, expect, it } from "vitest";

import { EMDASH } from "../glyphs.js";
import type { SurfaceStep } from "../../live/live-board-feed.js";
import { receiptFor } from "./work-board-receipt.js";

/**
 * The receipt behind a work-board card. It is a pure re-statement of the fields
 * the frame already carries - source, command, target, status, version, claim,
 * missing prerequisites - and it carries no affordance: opening it dispatches
 * nothing. Its truth class is OBSERVED because that is what a surface read is;
 * DAEMON_VERIFIED would claim a verification the surface never performed.
 */

function step(overrides: Partial<SurfaceStep> & Pick<SurfaceStep, "status">): SurfaceStep {
  return Object.freeze({
    aggregateId: null,
    claim: null,
    kind: "node.deliver",
    missing: [],
    version: null,
    ...overrides,
  });
}

function rowsOf(payload: ReturnType<typeof receiptFor>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of payload.rows ?? []) out[row.k] = row.v;
  return out;
}

describe("the work-board receipt restates the daemon's own fields", () => {
  it("names the read that produced the card and every field it carried", () => {
    const payload = receiptFor(step({
      aggregateId: "e2e-proj-t0abzx", kind: "project.register", status: "COMMITTED", version: 3,
    }));

    expect(payload.factId).toBe("board.project.register@e2e-proj-t0abzx");
    expect(payload.label).toBe("Register the project");
    expect(payload.value).toBe("Already recorded");
    expect(payload.truthClass).toBe("OBSERVED");
    expect(rowsOf(payload)).toEqual({
      COMMAND: "project.register",
      MEANS: "Already written into the daemon's own record.",
      SOURCE: "POST /affordances/read",
      STATUS: "COMMITTED",
      TARGET: "e2e-proj-t0abzx",
      VERSION: "3",
    });
  });

  it("renders an absent target and an absent version as an em-dash, never a zero", () => {
    const rows = rowsOf(receiptFor(step({ kind: "plan.propose", status: "BLOCKED" })));
    expect(rows["TARGET"]).toBe(EMDASH);
    expect(rows["VERSION"]).toBe(EMDASH);
  });

  it("keeps version 0 as 0 rather than collapsing it into the absent case", () => {
    const rows = rowsOf(receiptFor(step({ aggregateId: "a", kind: "session.open", status: "READY", version: 0 })));
    expect(rows["VERSION"]).toBe("0");
  });

  it("carries a durable claim as its two fields", () => {
    const rows = rowsOf(receiptFor(step({
      aggregateId: "node-1",
      claim: { claimedBy: "agent-7", expiresAt: "2026-08-22T12:00:00Z" },
      kind: "node.deliver",
      status: "READY",
    })));
    expect(rows["HELD BY"]).toBe("agent-7");
    expect(rows["HOLD EXPIRES"]).toBe("2026-08-22T12:00:00Z");
  });

  it("omits the claim rows entirely when the surface reported no claim", () => {
    const rows = rowsOf(receiptFor(step({ aggregateId: "node-1", status: "READY" })));
    expect(Object.keys(rows)).not.toContain("HELD BY");
    expect(Object.keys(rows)).not.toContain("HOLD EXPIRES");
  });

  it("shows missing prerequisites in words AND in the daemon's raw tokens", () => {
    const rows = rowsOf(receiptFor(step({
      kind: "project.activate",
      missing: ["project.register", "provider.probe"],
      status: "BLOCKED",
    })));
    expect(rows["STILL NEEDS"]).toBe("Register the project, Probe the model provider");
    expect(rows["RAW PREREQUISITES"]).toBe("project.register, provider.probe");
  });

  it("says why a minted target moves between reads, on the card that has one", () => {
    const minted = rowsOf(receiptFor(step({
      aggregateId: "goal-b8ae16be", kind: "goal.create", status: "READY", version: 0,
    })));
    expect(minted["TARGET"]).toBe("goal-b8ae16be");
    expect(minted["TARGET MINTED"])
      .toBe("fresh on every read; the command is one, this id is not durable");
    const durable = rowsOf(receiptFor(step({ aggregateId: "run-live-1", kind: "plan.propose", status: "READY" })));
    expect(Object.keys(durable)).not.toContain("TARGET MINTED");
  });

  it("gives an unmapped kind the raw kind as its label and never a made-up one", () => {
    const payload = receiptFor(step({ aggregateId: "x", kind: "node.plan", status: "READY" }));
    expect(payload.label).toBe("node.plan");
    expect(rowsOf(payload)["COMMAND"]).toBe("node.plan");
  });

  it("says in its note that the screen computed none of it", () => {
    const note = receiptFor(step({ status: "READY" })).note ?? "";
    expect(note).toContain("copied");
    expect(note).toContain("changes nothing");
  });
});
