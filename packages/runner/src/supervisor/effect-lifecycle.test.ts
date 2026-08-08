import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../canonical.js";
import {
  EFFECT_COMMANDS,
  EFFECT_STATES,
  TERMINAL_EFFECT_STATES,
  type EffectCommand,
  type EffectState,
} from "./effect-kernel.js";
import {
  ADMITTED_EFFECT_TRANSITIONS,
  applyEffectCommand,
  applyEffectTombstone,
  type LifecycleOutcome,
} from "./effect-lifecycle.js";
import { MAX_SUPERVISOR_COUNT } from "./effect-shape.js";
import {
  AT,
  DIGEST,
  makeIntent,
  makeSettlement,
  makeTombstone,
  makeUncertainty,
  withExtraKey,
  withGetter,
} from "./effect-test-fixtures.js";

/**
 * Hand-written from the pinned design lines 774-776. This list is NOT derived
 * from `ADMITTED_EFFECT_TRANSITIONS`: a matrix whose expectations came from the
 * table it is checking would stay green after a row was deleted from that table.
 * Design 776 (`ACTIVE -> CANCEL_REQUESTED`) was added by child 2 to both this
 * list and the production table; the cell still answers `MUST_DRAIN` to a bare
 * command, which the matrix below pins separately.
 */
const DESIGN_ARCS = [
  { from: "PENDING", command: "claim", to: ["CLAIMED"] },
  { from: "PENDING", command: "requestCancel", to: ["CANCEL_REQUESTED"] },
  { from: "CLAIMED", command: "arm", to: ["ARMED"] },
  { from: "CLAIMED", command: "requestCancel", to: ["CANCEL_REQUESTED"] },
  { from: "ARMED", command: "activate", to: ["ACTIVE"] },
  { from: "ARMED", command: "requestCancel", to: ["CANCEL_REQUESTED"] },
  { from: "ACTIVE", command: "requestCancel", to: ["CANCEL_REQUESTED"] },
  { from: "ACTIVE", command: "settle", to: ["SUCCEEDED", "FAILED", "UNKNOWN"] },
  { from: "CANCEL_REQUESTED", command: "settle", to: ["CANCELLED", "UNKNOWN"] },
] as const;

function settleCommand(target: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "settle",
    target,
    settlement: makeSettlement(),
    uncertainty: target === "UNKNOWN" ? makeUncertainty() : null,
    adoptedAt: AT,
    ...overrides,
  };
}

function commandFor(from: EffectState, command: EffectCommand): unknown {
  if (command !== "settle") {
    return { kind: command };
  }
  const arc = DESIGN_ARCS.find((entry) => entry.from === from && entry.command === "settle");
  return settleCommand(arc?.to[0] ?? "SUCCEEDED");
}

function refusalOf(outcome: LifecycleOutcome): { code: string; state: string | null; command: string | null } {
  if (outcome.kind !== "REFUSED") {
    throw new Error(`expected a refusal, received ${outcome.kind}`);
  }
  return {
    code: outcome.failure.code,
    state: outcome.failure.detail.state,
    command: outcome.failure.detail.command,
  };
}

describe("admitted transition table", () => {
  it("matches the design 774-775 arcs exactly", () => {
    expect(ADMITTED_EFFECT_TRANSITIONS.map((arc) => ({ ...arc, to: [...arc.to] }))).toEqual(
      DESIGN_ARCS.map((arc) => ({ from: arc.from, command: arc.command, to: [...arc.to] })),
    );
  });

  it("is frozen so a consumer cannot extend it in place", () => {
    expect(Object.isFrozen(ADMITTED_EFFECT_TRANSITIONS)).toBe(true);
  });
});

describe("state x command matrix", () => {
  const cases = EFFECT_STATES.flatMap((from) =>
    EFFECT_COMMANDS.map((command) => ({ from, command })),
  );

  it("sweeps every generated cell", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.length).toBe(EFFECT_STATES.length * EFFECT_COMMANDS.length);
    expect(cases.length).toBe(54);
  });

  it.each(cases)("$from x $command", ({ from, command }) => {
    const intent = makeIntent({ state: from });
    const outcome = applyEffectCommand(intent, commandFor(from, command));
    const arc = DESIGN_ARCS.find((entry) => entry.from === from && entry.command === command);

    if (from === "ACTIVE" && command === "requestCancel") {
      expect(outcome.kind).toBe("MUST_DRAIN");
      return;
    }
    if (arc !== undefined) {
      expect(outcome.kind).toBe("TRANSITIONED");
      if (outcome.kind === "TRANSITIONED") {
        expect(outcome.intent.state).toBe(arc.to[0]);
        expect(outcome.versionDelta).toBe(1);
        expect(outcome.intent.version).toBe(intent.version + 1);
      }
      return;
    }
    const refusal = refusalOf(outcome);
    expect(refusal.code).toBe(
      (TERMINAL_EFFECT_STATES as readonly string[]).includes(from)
        ? "EFFECT_TERMINAL_ABSORBED"
        : "EFFECT_TRANSITION_NOT_ADMITTED",
    );
    expect(refusal.state).toBe(from);
    expect(refusal.command).toBe(command);
  });
});

describe("kernel parse refusals", () => {
  const hostile: ReadonlyArray<readonly [string, unknown]> = [
    ["extra key", withExtraKey(makeIntent(), "shadow", "x")],
    ["getter property", withGetter(makeIntent(), "state", "ARMED")],
    ["negative zero version", makeIntent({ version: -0 })],
    ["unsafe integer counter", makeIntent({ expectedGraphEpoch: Number.MAX_SAFE_INTEGER })],
    ["bigint-shaped string where a number belongs", makeIntent({ version: "5" })],
    ["unknown state", makeIntent({ state: "ARMING" })],
    ["counter above the mirrored ceiling", makeIntent({ version: MAX_SUPERVISOR_COUNT + 1 })],
  ];

  it.each(hostile)("refuses %s", (_label, intent) => {
    const outcome = applyEffectCommand(intent, { kind: "arm" });
    expect(refusalOf(outcome).code).toBe("EFFECT_INTENT_MALFORMED");
    if (outcome.kind === "REFUSED") {
      expect(outcome.failure.layer).toBe("KERNEL");
    }
  });

  it("refuses an unknown command kind with its own code", () => {
    const outcome = applyEffectCommand(makeIntent({ state: "PENDING" }), { kind: "detonate" });
    expect(refusalOf(outcome).code).toBe("EFFECT_COMMAND_MALFORMED");
  });

  it("refuses a record parked at the counter ceiling before it transitions", () => {
    const intent = makeIntent({ state: "PENDING", version: MAX_SUPERVISOR_COUNT });
    expect(refusalOf(applyEffectCommand(intent, { kind: "claim" })).code).toBe(
      "EFFECT_COUNTER_EXHAUSTED",
    );
  });
});

describe("settlement is evidence-bound", () => {
  const active = makeIntent({ state: "ACTIVE" });

  it("binds the evidence digest into the adopted result", () => {
    const outcome = applyEffectCommand(active, settleCommand("SUCCEEDED"));
    expect(outcome.kind).toBe("TRANSITIONED");
    if (outcome.kind !== "TRANSITIONED" || outcome.result === null) {
      throw new Error("expected an adopted result");
    }
    expect(outcome.intent.state).toBe("SUCCEEDED");
    expect(outcome.result.terminalState).toBe("SUCCEEDED");
    expect(outcome.result.outcomeClass).toBe("PROVEN_RESULT");
    expect(outcome.result.adoptedAt).toBe(AT);
    expect(outcome.result.settlementDigest).toBe(
      canonicalDigest({
        settlement: {
          reconciliationVersion: "moe-claude-reconciliation/1",
          reconciliationDigest: DIGEST.reconciliation,
          outcomeClass: "PROVEN_RESULT",
        },
        uncertainty: null,
      }),
    );
  });

  it("produces a different result digest for different reconciliation evidence", () => {
    const first = applyEffectCommand(active, settleCommand("SUCCEEDED"));
    const second = applyEffectCommand(
      active,
      settleCommand("SUCCEEDED", {
        settlement: makeSettlement({ reconciliationDigest: DIGEST.reconciliationOther }),
      }),
    );
    if (first.kind !== "TRANSITIONED" || second.kind !== "TRANSITIONED") {
      throw new Error("expected two settlements");
    }
    expect(first.result?.settlementDigest).not.toBe(second.result?.settlementDigest);
  });

  it("refuses malformed settlement evidence with no state change", () => {
    const outcome = applyEffectCommand(
      active,
      settleCommand("SUCCEEDED", { settlement: { reconciliationVersion: "v1" } }),
    );
    expect(refusalOf(outcome).code).toBe("EFFECT_SETTLEMENT_EVIDENCE_INVALID");
    expect(active.state).toBe("ACTIVE");
    expect(Object.keys(outcome)).toEqual(["kind", "failure"]);
  });

  it("requires uncertainty evidence for an UNKNOWN settlement", () => {
    const outcome = applyEffectCommand(
      active,
      settleCommand("UNKNOWN", { uncertainty: null }),
    );
    expect(refusalOf(outcome).code).toBe("EFFECT_UNCERTAINTY_EVIDENCE_REQUIRED");
  });

  it("refuses uncertainty evidence on a proven settlement", () => {
    const outcome = applyEffectCommand(
      active,
      settleCommand("SUCCEEDED", { uncertainty: makeUncertainty() }),
    );
    expect(refusalOf(outcome).code).toBe("EFFECT_UNCERTAINTY_EVIDENCE_UNEXPECTED");
  });

  it("refuses a settlement target the arc does not admit", () => {
    const outcome = applyEffectCommand(active, settleCommand("CANCELLED"));
    expect(refusalOf(outcome).code).toBe("EFFECT_SETTLEMENT_TARGET_NOT_ADMITTED");
  });

  it("discriminates the cancel arcs by evidence kind", () => {
    const cancelling = makeIntent({ state: "CANCEL_REQUESTED" });
    const cancelled = applyEffectCommand(cancelling, settleCommand("CANCELLED"));
    const unknown = applyEffectCommand(cancelling, settleCommand("UNKNOWN"));
    if (cancelled.kind !== "TRANSITIONED" || unknown.kind !== "TRANSITIONED") {
      throw new Error("expected both cancel arcs to be admitted");
    }
    expect(cancelled.intent.state).toBe("CANCELLED");
    expect(unknown.intent.state).toBe("UNKNOWN");
    expect(cancelled.result?.settlementDigest).not.toBe(unknown.result?.settlementDigest);
  });
});

describe("tombstone dominance", () => {
  it.each(["PENDING", "CLAIMED", "ARMED"] as const)("dominates a %s intent", (state) => {
    const outcome = applyEffectTombstone(makeIntent({ state }), makeTombstone());
    expect(outcome.kind).toBe("TRANSITIONED");
    if (outcome.kind !== "TRANSITIONED") {
      throw new Error("expected dominance");
    }
    expect(outcome.intent.state).toBe("CANCELLED");
    expect(outcome.versionDelta).toBe(1);
    expect(outcome.result?.terminalState).toBe("CANCELLED");
    expect(outcome.result?.outcomeClass).toBe("GOAL_CANCEL");
  });

  it.each(["ACTIVE", "CANCEL_REQUESTED", "SUCCEEDED", "FAILED", "UNKNOWN", "CANCELLED"] as const)(
    "never dominates a %s intent",
    (state) => {
      const outcome = applyEffectTombstone(makeIntent({ state }), makeTombstone());
      const refusal = refusalOf(outcome);
      expect(refusal.code).toBe("EFFECT_TOMBSTONE_DOES_NOT_DOMINATE");
      expect(refusal.state).toBe(state);
    },
  );

  it("refuses a malformed tombstone with its own code", () => {
    const outcome = applyEffectTombstone(
      makeIntent({ state: "PENDING" }),
      makeTombstone({ terminalizedAt: "yesterday" }),
    );
    expect(refusalOf(outcome).code).toBe("EFFECT_TOMBSTONE_MALFORMED");
  });

  it("refuses a tombstone naming a different intent", () => {
    const outcome = applyEffectTombstone(
      makeIntent({ state: "PENDING" }),
      makeTombstone({ intentId: "intent-other" }),
    );
    expect(refusalOf(outcome).code).toBe("EFFECT_TOMBSTONE_DOES_NOT_DOMINATE");
  });
});

describe("cancelling an ACTIVE effect", () => {
  const outcome = applyEffectCommand(makeIntent({ state: "ACTIVE" }), { kind: "requestCancel" });

  it("is neither a success nor a refusal", () => {
    expect(outcome.kind).toBe("MUST_DRAIN");
    expect("ok" in outcome).toBe(false);
    expect("failure" in outcome).toBe(false);
  });

  it("leaves the effect active and mandates a drain", () => {
    if (outcome.kind !== "MUST_DRAIN") {
      throw new Error("expected MUST_DRAIN");
    }
    expect(outcome.drainRequired).toBe(true);
    expect(outcome.intent.state).toBe("ACTIVE");
    expect(outcome.versionDelta).toBe(0);
  });
});
