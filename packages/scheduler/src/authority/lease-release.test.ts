import { describe, expect, it } from "vitest";

import { DRAIN_REASONS, DRAIN_REASON_RANKS, type DrainReason } from "./lease-state.js";
import {
  applyDrainReason,
  releaseWork,
  type DrainDisposition,
  type ReleaseRequest,
} from "./lease-drain.js";
import { handoff, lease, proof, release } from "./test-fixtures.js";

function disposition(...reasons: readonly DrainReason[]): DrainDisposition {
  let current: DrainDisposition | null = null;
  for (const reason of reasons) {
    const result = applyDrainReason(current, reason);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("drain seed rejected");
    current = result.value;
  }
  if (current === null) throw new Error("no reasons supplied");
  return current;
}

describe("drain disposition (design 348: frozen, persisted, monotonic precedence)", () => {
  it("ranks the design vocabulary in the published order", () => {
    expect([...DRAIN_REASONS]).toEqual([
      "URGENT_REVOKE", "GRAPH_REMOVE_OR_SUPERSESSION", "GOAL_CANCEL", "WORK_CANCEL",
      "DEPENDENCY_INVALIDATED", "WORK_RELEASE_OR_PAUSE", "SUBMISSION_FINALIZE",
    ]);
    expect(DRAIN_REASONS.map((reason) => DRAIN_REASON_RANKS[reason]))
      .toEqual([70, 60, 50, 40, 30, 20, 10]);
  });

  it("unions the first reason into a resumable release disposition", () => {
    const value = disposition("WORK_RELEASE_OR_PAUSE");
    expect(value.reasons).toEqual(["WORK_RELEASE_OR_PAUSE"]);
    expect(value.strongestReason).toBe("WORK_RELEASE_OR_PAUSE");
    expect(value.terminalTarget).toBe("RELEASED");
    expect(value.resumable).toBe(true);
    expect(Object.isFrozen(value.reasons)).toBe(true);
  });

  it("lets a higher rank change the target while keeping every reason", () => {
    const value = disposition("WORK_RELEASE_OR_PAUSE", "GOAL_CANCEL");
    expect(value.reasons).toEqual(["GOAL_CANCEL", "WORK_RELEASE_OR_PAUSE"]);
    expect(value.strongestReason).toBe("GOAL_CANCEL");
    expect(value.terminalTarget).toBe("RELEASED");
    expect(value.resumable).toBe(false);
  });

  it("never lets a lower rank downgrade the strongest reason", () => {
    const value = disposition("GOAL_CANCEL", "SUBMISSION_FINALIZE", "WORK_RELEASE_OR_PAUSE");
    expect(value.strongestReason).toBe("GOAL_CANCEL");
    expect(value.reasons).toEqual([
      "GOAL_CANCEL", "SUBMISSION_FINALIZE", "WORK_RELEASE_OR_PAUSE",
    ]);
    expect(value.resumable).toBe(false);
  });

  it("is idempotent on an equal-rank repeat of the same reason", () => {
    const once = disposition("WORK_CANCEL");
    const twice = disposition("WORK_CANCEL", "WORK_CANCEL");
    expect(twice).toEqual(once);
  });

  it("maps privileged removal ranks to a REVOKED terminal target", () => {
    expect(disposition("URGENT_REVOKE").terminalTarget).toBe("REVOKED");
    expect(disposition("GRAPH_REMOVE_OR_SUPERSESSION").terminalTarget).toBe("REVOKED");
    expect(disposition("WORK_CANCEL").terminalTarget).toBe("RELEASED");
  });

  it("refuses a reason outside the frozen vocabulary", () => {
    const result = applyDrainReason(null, "SOMETHING_ELSE");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
  });

  it("refuses a forged disposition whose strongest reason is not in its own set", () => {
    const result = applyDrainReason(
      { reasons: ["WORK_CANCEL"], strongestReason: "GOAL_CANCEL", terminalTarget: "RELEASED", resumable: false },
      "WORK_CANCEL",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
  });
});

describe("release and handoff (design 765: three branches)", () => {
  it("finishes RELEASED at a safe boundary with every effect and resource terminal", () => {
    const result = releaseWork(lease(), proof(), release());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("RELEASED");
    if (result.value.outcome !== "RELEASED") return;
    expect(result.value.lease.state).toBe("RELEASED");
    expect(result.value.lease.epoch).toBe(3);
    expect(result.value.lease.version).toBe(8);
    expect(result.value.releasePending).toBe(false);
    expect(result.value.resumable).toBe(true);
    expect(result.value.handoff.completedSteps).toEqual(["step-1"]);
    expect(result.value.handoff.artifactDigest).toBe("c".repeat(64));
    expect(result.value.handoff.truthClass).toBe("DAEMON_VERIFIED");
    expect(Object.isFrozen(result.value.handoff)).toBe(true);
  });

  const pending: readonly (readonly [string, Partial<ReleaseRequest>])[] = [
    ["no safe boundary observation", { safeBoundaryObserved: false }],
    ["an active effect", { effectsTerminal: false }],
    ["an active resource", { resourcesTerminal: false }],
  ];
  for (const [name, over] of pending) {
    it(`commits DRAINING with releasePending when there is ${name}`, () => {
      const result = releaseWork(lease(), proof(), release({
        ...over, intentRefs: ["intent:cancel-1", "intent:reconcile-1"],
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe("DRAINING");
      if (result.value.outcome !== "DRAINING") return;
      expect(result.value.lease.state).toBe("DRAINING");
      expect(result.value.releasePending).toBe(true);
      expect(result.value.resumable).toBe(false);
      expect(result.value.intentRefs).toEqual(["intent:cancel-1", "intent:reconcile-1"]);
      expect(JSON.stringify(result.value)).not.toContain("released");
    });
  }

  it("carries a stronger prior drain reason into the release disposition", () => {
    const result = releaseWork(lease(), proof(), release({
      disposition: disposition("GOAL_CANCEL"), safeBoundaryObserved: false,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.outcome !== "DRAINING") throw new Error("expected DRAINING");
    expect(result.value.disposition.strongestReason).toBe("GOAL_CANCEL");
    expect(result.value.disposition.reasons)
      .toEqual(["GOAL_CANCEL", "WORK_RELEASE_OR_PAUSE"]);
    expect(result.value.disposition.resumable).toBe(false);
  });

  it("marks a tentative handoff non-resumable once a stronger reason lands", () => {
    const result = releaseWork(lease(), proof(), release({
      disposition: disposition("DEPENDENCY_INVALIDATED"),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.outcome !== "RELEASED") throw new Error("expected RELEASED");
    expect(result.value.resumable).toBe(false);
    expect(result.value.disposition.strongestReason).toBe("DEPENDENCY_INVALIDATED");
  });

  const invalid: readonly (readonly [string, Record<string, unknown>])[] = [
    ["a non-hex digest", handoff({ inputDigest: "not-a-digest" })],
    ["an unknown truth class", handoff({ truthClass: "GUESSED" })],
    ["a missing digest family", (() => {
      const { artifactDigest: _dropped, ...rest } = handoff();
      return rest;
    })()],
    ["an unbounded completed-step list", handoff({
      completedSteps: Array.from({ length: 200 }, (_unused, index) => `step-${index}`),
    })],
    ["an empty next safe action", handoff({ nextSafeAction: "" })],
  ];
  for (const [name, value] of invalid) {
    it(`leaves authority untouched when the handoff carries ${name}`, () => {
      const record = lease();
      const before = structuredClone(record);
      const result = releaseWork(record, proof(), release({ handoff: value }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
      expect(result.securityRecord).toBeNull();
      expect(record).toEqual(before);
      expect(JSON.stringify(result)).not.toContain("DRAINING");
    });
  }

  it("keeps a SUSPECT lease SUSPECT when the handoff cannot commit", () => {
    const record = lease({ state: "SUSPECT" });
    const before = structuredClone(record);
    const result = releaseWork(record, proof(), release({ handoff: handoff({ truthClass: "GUESSED" }) }));
    expect(result.ok).toBe(false);
    expect(record).toEqual(before);
  });

  for (const state of ["RELEASED", "REVOKED"] as const) {
    it(`treats a release against a ${state} lease as an idempotent no-op`, () => {
      const record = lease({ state });
      const result = releaseWork(record, proof(), release());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe("NO_OP");
      if (result.value.outcome !== "NO_OP") return;
      expect(result.value.lease).toEqual(record);
      expect(result.value.releasePending).toBe(false);
    });
  }

  it("still fences a stale token on a terminal lease", () => {
    const result = releaseWork(lease({ state: "RELEASED" }), proof({ leaseToken: "x" }), release());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_STALE_LEASE"]);
  });

  it("refuses a release observation that is not a bounded intent-ref list", () => {
    const result = releaseWork(lease(), proof(), release({
      safeBoundaryObserved: false, intentRefs: [""],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
  });

  it("does not echo the lease token on any rejected release path", () => {
    const rejected = [
      releaseWork(lease(), proof({ epoch: 1 }), release()),
      releaseWork(lease(), proof({ leaseToken: "token-stale" }), release()),
      releaseWork(lease(), proof(), release({ handoff: handoff({ truthClass: "GUESSED" }) })),
      releaseWork(lease(), proof(), release({ reason: "NOPE" as never })),
    ];
    for (const outcome of rejected) {
      expect(outcome.ok).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain("token-current");
      expect(JSON.stringify(outcome)).not.toContain("token-stale");
    }
  });

  it("returns the authoritative lease record, token included, on accepted paths", () => {
    const accepted = releaseWork(lease(), proof(), release());
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.lease.leaseToken).toBe("token-current");
  });
});
