import { describe, expect, it } from "vitest";

import {
  FAIRNESS_BYPASSES_PER_LEVEL,
  FAIRNESS_FORCED_BYPASS_BOUND,
  FAIRNESS_PRIORITY_LADDER,
  ageWorkItem,
  bypassesToForced,
} from "./fairness-aging.js";
import type { FairnessAgedStanding } from "./fairness-aging.js";
import { FAIRNESS_PRIORITY_CLASSES } from "./fairness-contract.js";
import type {
  FairnessContractIssue,
  FairnessContractRefusal,
  FairnessContractResult,
} from "./fairness-contract.js";

const DIMENSION = "dim.alpha";
const RESOURCE = "res.a";

function workItem(priority: string, overrides: { readonly workItemId?: string } = {}): unknown {
  return {
    workItemId: overrides.workItemId ?? "wi.claimant",
    dimensionId: DIMENSION,
    priority,
    resourceId: RESOURCE,
    dispatchability: { state: "DISPATCHABLE", observationRef: "obs.claimant" },
  };
}

/** A claim whose attested count IS the proven count; the contract counts, never copies. */
function claim(count: number, overrides: { readonly observed?: boolean } = {}): unknown {
  const attestations = Array.from({ length: count }, (_, index) => ({
    opportunityRef: `opp.${index}`,
    winnerWorkItemId: `wi.winner.${index}`,
    observationRef: overrides.observed === false ? null : `obs.${index}`,
  }));
  return { workItemId: "wi.claimant", claimedBypasses: count, attestations };
}

function capacity(capacityUnits: number, inFlightUnits = 0): unknown {
  return { resourceId: RESOURCE, capacityUnits, inFlightUnits };
}

function revision(parts: {
  readonly dimensionId?: string;
  readonly toCapUnits?: number;
  readonly drained?: readonly string[];
}): unknown {
  return {
    revisionRef: "rev.1",
    dimensionId: parts.dimensionId ?? DIMENSION,
    fromCapUnits: 64,
    toCapUnits: parts.toCapUnits ?? 64,
    drainedWorkItemIds: parts.drained ?? [],
    migrations: [],
  };
}

function request(parts: {
  readonly workItem?: unknown;
  readonly bypassClaim?: unknown;
  readonly capacity?: unknown;
  readonly capRevision?: unknown;
  readonly forcedHead?: unknown;
}): unknown {
  return {
    workItem: parts.workItem ?? workItem("P3"),
    bypassClaim: parts.bypassClaim ?? claim(0),
    capacity: parts.capacity ?? capacity(64),
    capRevision: parts.capRevision ?? null,
    forcedHead: parts.forcedHead ?? null,
  };
}

function soleIssue(result: FairnessContractResult<unknown>): FairnessContractIssue {
  expect(result.ok).toBe(false);
  const refusal = result as FairnessContractRefusal;
  expect(refusal.issues).toHaveLength(1);
  return refusal.issues[0] as FairnessContractIssue;
}

function standing(result: FairnessContractResult<FairnessAgedStanding>): FairnessAgedStanding {
  if (!result.ok) throw new Error(`expected a standing, got ${JSON.stringify(result.issues)}`);
  return result.value;
}

function age(parts: Parameters<typeof request>[0]): FairnessAgedStanding {
  return standing(ageWorkItem(request(parts)));
}

describe("aging constants", () => {
  it("mirrors the reference ladder and bypass quantum without drift", () => {
    // Values duplicated from the DEVELOPMENT_ONLY reference, which production
    // cannot import: fairness-policy.ts:25 (BYPASSES_PER_LEVEL) and :17-22
    // (PRIORITY_LADDER). Changing either is a fairness-constant change and is
    // outside this task's scope, so both are pinned here.
    expect(FAIRNESS_BYPASSES_PER_LEVEL).toBe(8);
    expect(FAIRNESS_PRIORITY_LADDER).toEqual(["P0", "P1", "P2", "P3"]);
    expect(FAIRNESS_FORCED_BYPASS_BOUND).toBe(32);
  });

  it("orders exactly the contract's closed class set, adding order and nothing else", () => {
    // fairness-contract.ts:80-83 states FAIRNESS_PRIORITY_CLASSES carries NO
    // ordering meaning. The ladder supplies the order; it must not also supply a
    // different membership, or the two would silently disagree.
    expect([...FAIRNESS_PRIORITY_LADDER].sort()).toEqual([...FAIRNESS_PRIORITY_CLASSES].sort());
  });

  it("states the bypasses needed to force from each class", () => {
    // Mirrors bucketsToForced (fairness-policy.ts:35-49) scaled by the quantum.
    expect(bypassesToForced("P0")).toBe(8);
    expect(bypassesToForced("P1")).toBe(16);
    expect(bypassesToForced("P2")).toBe(24);
    expect(bypassesToForced("P3")).toBe(32);
  });

  it("demands the maximum evidence for a class outside the ladder, never zero", () => {
    // Unreachable through ageWorkItem — validateWorkItem constrains priority to
    // the closed set — but bypassesToForced is published on the package root, so
    // an untyped caller can reach it. indexOf would answer -1, which computes to
    // ZERO bypasses and forces for free. Unknown must never buy standing.
    const outsideLadder = "P9" as unknown as Parameters<typeof bypassesToForced>[0];
    expect(bypassesToForced(outsideLadder)).toBe(FAIRNESS_FORCED_BYPASS_BOUND);
  });
});

describe("aging promotion bound", () => {
  it("promotes one class per proven bypass quantum", () => {
    expect(age({ bypassClaim: claim(7) }).effectivePriority).toBe("P3");
    expect(age({ bypassClaim: claim(8) }).effectivePriority).toBe("P2");
    expect(age({ bypassClaim: claim(16) }).effectivePriority).toBe("P1");
    expect(age({ bypassClaim: claim(24) }).effectivePriority).toBe("P0");
  });

  it("forces at exactly the stated bound and not one bypass earlier", () => {
    // The bound is the number DoD 1 calls starvation-bounded: an item that is
    // never chosen is forced after FAIRNESS_FORCED_BYPASS_BOUND compatible
    // opportunities pass it, not "eventually".
    expect(age({ bypassClaim: claim(FAIRNESS_FORCED_BYPASS_BOUND - 1) }).forced).toBe(false);
    expect(age({ bypassClaim: claim(FAIRNESS_FORCED_BYPASS_BOUND) }).forced).toBe(true);
  });

  it("forces a P0 item after one quantum, since it cannot be promoted further", () => {
    const item = workItem("P0");
    expect(age({ workItem: item, bypassClaim: claim(7) }).forced).toBe(false);
    expect(age({ workItem: item, bypassClaim: claim(8) }).forced).toBe(true);
  });

  it("never promotes past the top of the ladder", () => {
    const top = age({ bypassClaim: claim(64) });
    expect(top.effectivePriority).toBe("P0");
    expect(top.levelsPromoted).toBe(3);
  });

  it("counts the standing from the evidence, never from the claimed number", () => {
    const forged = { workItemId: "wi.claimant", claimedBypasses: 32, attestations: [] };
    const issue = soleIssue(ageWorkItem(request({ bypassClaim: forged })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_BYPASS_EVIDENCE_MISSING");
    expect(issue.layer).toBe("OPPORTUNITY_EVIDENCE");
  });
});

describe("aging monotonicity", () => {
  const SWEEP_LENGTH = FAIRNESS_FORCED_BYPASS_BOUND + 4;
  const sweep = Array.from({ length: SWEEP_LENGTH }, (_, count) => count);

  it("generated the full monotonicity sweep", () => {
    expect(sweep.length).toBe(36);
    expect(sweep[sweep.length - 1]).toBe(35);
  });

  it("never regresses a standing as more opportunities are proven", () => {
    let previousLevels = -1;
    let previousRank: number = FAIRNESS_PRIORITY_LADDER.length;
    let forcedSeen = false;
    for (const count of sweep) {
      const aged = age({ bypassClaim: claim(count) });
      const rank = FAIRNESS_PRIORITY_LADDER.indexOf(aged.effectivePriority);
      expect(aged.levelsPromoted).toBeGreaterThanOrEqual(previousLevels);
      expect(rank).toBeLessThanOrEqual(previousRank);
      if (forcedSeen) expect(aged.forced).toBe(true);
      forcedSeen = forcedSeen || aged.forced;
      previousLevels = aged.levelsPromoted;
      previousRank = rank;
    }
    expect(forcedSeen).toBe(true);
  });
});

describe("aging evidence", () => {
  it("returns UNKNOWN naming the missing observation and confers no promotion", () => {
    const result = ageWorkItem(request({ bypassClaim: claim(8, { observed: false }) }));
    const issue = soleIssue(result);
    expect((result as FairnessContractRefusal).disposition).toBe("UNKNOWN");
    expect(issue.code).toBe("FAIRNESS_CONTRACT_OPPORTUNITY_UNOBSERVED");
    expect(issue.layer).toBe("OPPORTUNITY_EVIDENCE");
    expect(issue.missingInput).toBe("attestations[0].observationRef");
  });

  it("refuses a self-attested bypass", () => {
    const selfAttested = {
      workItemId: "wi.claimant", claimedBypasses: 1,
      attestations: [{
        opportunityRef: "opp.0", winnerWorkItemId: "wi.claimant", observationRef: "obs.0",
      }],
    };
    const issue = soleIssue(ageWorkItem(request({ bypassClaim: selfAttested })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_BYPASS_SELF_ATTESTED");
    expect(issue.layer).toBe("OPPORTUNITY_EVIDENCE");
  });

  it("refuses a claim raised on behalf of a different work item", () => {
    const foreign = { workItemId: "wi.other", claimedBypasses: 0, attestations: [] };
    const issue = soleIssue(ageWorkItem(request({ bypassClaim: foreign })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_INVALID_IDENTITY");
    expect(issue.layer).toBe("OPPORTUNITY_EVIDENCE");
  });

  it("refuses a hostile claimant identity at the work-item layer", () => {
    const issue = soleIssue(ageWorkItem(request({
      workItem: workItem("P3", { workItemId: "-hostile" }),
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_INVALID_IDENTITY");
    expect(issue.layer).toBe("WORK_ITEM");
  });
});

describe("aging precedence over capacity", () => {
  it("refuses a promotion at a resource that is already at capacity", () => {
    // Aging changes ORDER. If a promotion could be issued at a full resource,
    // aging would have quietly become a capacity-raising mechanism.
    const issue = soleIssue(ageWorkItem(request({
      bypassClaim: claim(8), capacity: capacity(4, 4),
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED");
    expect(issue.layer).toBe("RESOURCE");
  });

  it("still reports an unpromoted standing at a full resource", () => {
    // Refusing here too would make the precedence test vacuous: it would pass
    // whether or not the refusal was actually tied to the promotion.
    const aged = age({ bypassClaim: claim(7), capacity: capacity(4, 4) });
    expect(aged.levelsPromoted).toBe(0);
    expect(aged.effectivePriority).toBe("P3");
  });

  it("refuses a promotion that a cap revision has already closed", () => {
    const issue = soleIssue(ageWorkItem(request({
      bypassClaim: claim(8), capacity: capacity(64, 12),
      capRevision: revision({ toCapUnits: 8 }),
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED");
    expect(issue.layer).toBe("CAP_REVISION");
  });

  it("refuses a promotion for a work item the revision has drained", () => {
    const issue = soleIssue(ageWorkItem(request({
      bypassClaim: claim(8), capRevision: revision({ drained: ["wi.claimant"] }),
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_MIGRATION_TARGET_DRAINED");
    expect(issue.layer).toBe("CAP_REVISION");
  });

  it("refuses a revision scoped to a different dimension", () => {
    const issue = soleIssue(ageWorkItem(request({
      capRevision: revision({ dimensionId: "dim.beta" }),
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_DIMENSION_MISMATCH");
    expect(issue.layer).toBe("CAP_REVISION");
  });

  it("refuses a capacity record naming a different resource than the work item", () => {
    const issue = soleIssue(ageWorkItem(request({
      capacity: { resourceId: "res.b", capacityUnits: 8, inFlightUnits: 0 },
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE");
    expect(issue.layer).toBe("RESOURCE");
  });
});

describe("aging and a declared forced head", () => {
  it("withholds forcing when another work item already holds the forced head", () => {
    // Two forced heads is not a stronger claim, it is an ambiguous one. The
    // promotion still stands; only the forcing is withheld, and visibly so.
    const aged = age({
      bypassClaim: claim(FAIRNESS_FORCED_BYPASS_BOUND), forcedHead: "wi.other",
    });
    expect(aged.forced).toBe(false);
    expect(aged.forcedWithheld).toBe(true);
    expect(aged.effectivePriority).toBe("P0");
  });

  it("forces when this work item is itself the declared forced head", () => {
    const aged = age({
      bypassClaim: claim(FAIRNESS_FORCED_BYPASS_BOUND), forcedHead: "wi.claimant",
    });
    expect(aged.forced).toBe(true);
    expect(aged.forcedWithheld).toBe(false);
  });

  it("does not report a withheld forcing when no forcing was earned", () => {
    const aged = age({ bypassClaim: claim(8), forcedHead: "wi.other" });
    expect(aged.forced).toBe(false);
    expect(aged.forcedWithheld).toBe(false);
  });

  it("refuses a hostile forced-head identity", () => {
    const issue = soleIssue(ageWorkItem(request({ forcedHead: ".hostile" })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_INVALID_IDENTITY");
    expect(issue.layer).toBe("WORK_ITEM");
  });

  it("refuses a malformed aging request record", () => {
    const issue = soleIssue(ageWorkItem({ workItem: null }));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_MALFORMED_INPUT");
    expect(issue.layer).toBe("WORK_ITEM");
  });
});
