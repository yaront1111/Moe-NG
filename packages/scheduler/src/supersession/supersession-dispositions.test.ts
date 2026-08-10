/**
 * Scheduler half of the graph supersession engine.
 *
 * Every fact this file feeds a producer is driven through the REAL landed
 * primitive — `applyDrainReason`/`releaseWork` for drain, `deriveReservationId`
 * and the reservation transitions for budget, `validateIntentionalWait` for the
 * consumer edge. No helper here recomputes drain, resource or budget authority:
 * a fixture that recomputed it would make every assertion below decorative.
 *
 * The kind sweep is generated from `SUPERSESSION_DISPOSITION_KINDS` imported
 * from `@moe/core`, never from a local list of six strings, and the generated
 * case count is asserted non-zero AND equal to that constant's length.
 */
import { expect, it } from "vitest";

import { SUPERSESSION_DISPOSITION_KINDS, type SupersessionDispositionKind } from "@moe/core";

import { validateIntentionalWait } from "../admission/admission-wait.js";
import { applyDrainReason } from "../authority/lease-drain.js";
import { adapterFail, reserveAll } from "../authority/lease-resource.js";
import { deriveReservationId } from "../budget/budget-reservation.js";
import {
  SUPERSESSION_BOUND_DISPOSITION_FIELDS,
  SUPERSESSION_DISPOSITION_FAMILIES,
  digestDispositions,
  type SupersessionDispositionResult,
  type SupersessionFamilyDisposition,
} from "./supersession-disposition-contract.js";
import {
  buildSupersessionDispositions,
  carryWaitProjection,
  type SupersessionNodeFacts,
} from "./supersession-dispositions.js";

const DIGEST = "a".repeat(64);
const LEASE = {
  leaseId: "lease:1", kind: "RESOURCE", ownerSessionRef: "session:1", leaseToken: "token:1",
  epoch: 3, state: "ACTIVE", serverWallDeadline: 90, bootId: "boot:1", monotonicObservation: 12,
  authorityHashRef: DIGEST, version: 7,
};
const PROOF = {
  leaseToken: "token:1", epoch: 3, authorityHashRef: DIGEST, ownerSessionRef: "session:1",
  expectedVersion: 7,
};
const HANDOFF = {
  completedSteps: ["step:1"], activeProcessResourceFacts: [], inputDigest: DIGEST,
  worktreeDigest: DIGEST, contextDigest: DIGEST, journalDigest: DIGEST, artifactDigest: DIGEST,
  nextSafeAction: "supersede", truthClass: "OBSERVED",
};
const RELEASE_REQUEST = {
  reason: "GRAPH_REMOVE_OR_SUPERSESSION", safeBoundaryObserved: true, effectsTerminal: true,
  resourcesTerminal: true, handoff: HANDOFF, intentRefs: [], disposition: null,
};

const METER = { meter: "usd", available: 100, reserved: 0, quarantined: 0, committed: 0 };
const VIEW = { accountId: "account:1", state: "OPEN", version: 4, meters: [METER] };
const HELD_VIEW = {
  ...VIEW, meters: [{ ...METER, available: 90, reserved: 10 }],
};
const PURPOSES = [
  "EXECUTION", "VERIFICATION", "INDEPENDENT_REVIEW", "FINAL_ACCEPTANCE", "CONTINGENCY",
] as const;
const RESERVATION = {
  reservationId: deriveReservationId("account:1", "admission:1"), accountId: "account:1",
  admissionRef: "admission:1", state: "RESERVED", version: 0,
  lines: PURPOSES.map((purpose) => ({ purpose, meter: "usd", quantity: 2 })),
  attemptRef: null, neverStartedProofRef: null,
};

const CARRIED: readonly SupersessionDispositionKind[] = ["CARRY", "REQUALIFY"];
const RERUN: readonly SupersessionDispositionKind[] = ["REEXECUTE", "CHANGE"];

function budgetFacts(view: unknown, neverStartedProofRef: string | null): unknown {
  return {
    view, reservation: RESERVATION, expectedVersion: 0, settlementState: null,
    successorAttemptRef: "attempt:2", neverStartedProofRef,
  };
}

function resourceFacts(patch: Record<string, unknown>): unknown {
  return { slotState: null, drainDisposition: null, release: null, successorCapacity: null, ...patch };
}

/**
 * One healthy node per declared kind. An unrecognised kind THROWS rather than
 * defaulting, so a seventh kind added to `@moe/core` reddens this file instead
 * of quietly producing a five-sixths sweep.
 */
function nodeFor(kind: SupersessionDispositionKind): SupersessionNodeFacts {
  const nodeKey = `node:${kind.toLowerCase()}`;
  if (kind === "ADD") {
    return {
      kind, nodeKey, attemptLifecycle: "CREATED", effectsTerminal: true,
      resource: resourceFacts({}) as SupersessionNodeFacts["resource"], budget: null,
    } as SupersessionNodeFacts;
  }
  if (CARRIED.includes(kind)) {
    return {
      kind, nodeKey, attemptLifecycle: "SUCCEEDED", effectsTerminal: true,
      resource: resourceFacts({ slotState: "ACTIVE" }) as SupersessionNodeFacts["resource"],
      budget: budgetFacts(VIEW, null),
    } as SupersessionNodeFacts;
  }
  if (RERUN.includes(kind)) {
    return {
      kind, nodeKey, attemptLifecycle: "RUNNING", effectsTerminal: true,
      resource: resourceFacts({ slotState: "ACTIVE" }) as SupersessionNodeFacts["resource"],
      budget: budgetFacts(VIEW, null),
    } as SupersessionNodeFacts;
  }
  if (kind === "REMOVE") {
    return {
      kind, nodeKey, attemptLifecycle: "RUNNING", effectsTerminal: true,
      resource: resourceFacts({
        slotState: "ACTIVE",
        release: { lease: LEASE, authority: PROOF, request: RELEASE_REQUEST },
      }) as SupersessionNodeFacts["resource"],
      budget: budgetFacts(HELD_VIEW, "never:1"),
    } as SupersessionNodeFacts;
  }
  throw new Error(`no fixture for supersession disposition kind ${String(kind)}`);
}

const HEALTHY: readonly SupersessionNodeFacts[] = SUPERSESSION_DISPOSITION_KINDS.map(nodeFor);

function withNode(kind: SupersessionDispositionKind, patch: Partial<SupersessionNodeFacts>)
  : readonly SupersessionNodeFacts[] {
  return HEALTHY.map((node) => (node.kind === kind ? { ...node, ...patch } : node));
}

function accepted(result: SupersessionDispositionResult): readonly SupersessionFamilyDisposition[] {
  if (!result.ok) throw new Error(`${result.code} refused by ${result.layer}`);
  return result.dispositions;
}

function refusal(result: SupersessionDispositionResult): unknown {
  expect(result.ok).toBe(false);
  return result.ok ? null : { code: result.code, layer: result.layer, ok: result.ok };
}

function digestOf(result: SupersessionDispositionResult): string {
  if (!result.ok) throw new Error(`${result.code} refused by ${result.layer}`);
  return result.digest;
}

function familyOf(
  dispositions: readonly SupersessionFamilyDisposition[],
  kind: SupersessionDispositionKind,
  family: string,
): SupersessionFamilyDisposition | undefined {
  return dispositions.find((entry) => entry.kind === kind && entry.family === family);
}

// ---------------------------------------------------------------------------
// DoD 1 — completeness over the declared kind set.
// ---------------------------------------------------------------------------

const SWEEP: readonly SupersessionDispositionKind[] = [...SUPERSESSION_DISPOSITION_KINDS];

it("generates one sweep case per declared kind and never zero", () => {
  expect(SWEEP.length).toBeGreaterThan(0);
  expect(SWEEP.length).toBe(SUPERSESSION_DISPOSITION_KINDS.length);
  expect(HEALTHY.length).toBe(SUPERSESSION_DISPOSITION_KINDS.length);
});

it.each(SWEEP)("disposes every family for kind %s", (kind) => {
  const dispositions = accepted(buildSupersessionDispositions(HEALTHY));
  const families = dispositions.filter((entry) => entry.kind === kind).map((e) => e.family).sort();
  expect(families).toEqual([...SUPERSESSION_DISPOSITION_FAMILIES].sort());
});

it("covers the whole declared kind set with no omission", () => {
  const dispositions = accepted(buildSupersessionDispositions(HEALTHY));
  expect([...new Set(dispositions.map((entry) => entry.kind))].sort())
    .toEqual([...SUPERSESSION_DISPOSITION_KINDS].sort());
  expect(dispositions.length)
    .toBe(SUPERSESSION_DISPOSITION_KINDS.length * SUPERSESSION_DISPOSITION_FAMILIES.length);
});

it("refuses a kind with no disposition rather than omitting it", () => {
  const partial = HEALTHY.filter((node) => node.kind !== "REMOVE");
  expect(refusal(buildSupersessionDispositions(partial)))
    .toEqual({ code: "PLANNING_DISPOSITION_UNKNOWN", layer: "SCHEDULER_SUPERSESSION_SET", ok: false });
});

// ---------------------------------------------------------------------------
// DoD 2 — determinism, canonical ordering, one digest over the bound fields.
// ---------------------------------------------------------------------------

it("produces a byte-identical set and digest for identical input", () => {
  const first = buildSupersessionDispositions(HEALTHY);
  const second = buildSupersessionDispositions(HEALTHY);
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
});

it("orders canonically, not by discovery: reversed input is byte-identical", () => {
  const forward = buildSupersessionDispositions(HEALTHY);
  const reversed = buildSupersessionDispositions([...HEALTHY].reverse());
  const rotated = buildSupersessionDispositions([...HEALTHY.slice(3), ...HEALTHY.slice(0, 3)]);
  // The forward fixture is already in declared-kind order, so only the reversed
  // and rotated runs can distinguish a canonical comparator from input order.
  expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  expect(JSON.stringify(rotated)).toBe(JSON.stringify(forward));
  expect(digestOf(reversed)).toBe(digestOf(forward));
});

it("binds the digest to exactly the declared field list", () => {
  const dispositions = accepted(buildSupersessionDispositions(HEALTHY));
  const sample = dispositions[0];
  expect(sample).toBeDefined();
  expect(Object.keys(sample as object).sort())
    .toEqual([...SUPERSESSION_BOUND_DISPOSITION_FIELDS].sort());
  expect(digestDispositions(dispositions)).toBe(digestOf(buildSupersessionDispositions(HEALTHY)));
});

it("refuses to digest a disposition carrying a field outside the bound list", () => {
  const dispositions = accepted(buildSupersessionDispositions(HEALTHY));
  const smuggled = dispositions.map((entry, index) =>
    (index === 0 ? { ...entry, smuggled: "escapes-the-hash" } : entry));
  expect(digestDispositions(smuggled as readonly SupersessionFamilyDisposition[])).toBeNull();
});

it("changes the digest when a bound field changes", () => {
  const baseline = digestOf(buildSupersessionDispositions(HEALTHY));
  const moved = digestOf(buildSupersessionDispositions(
    HEALTHY.map((node) => (node.kind === "ADD" ? { ...node, nodeKey: "node:add2" } : node)),
  ));
  expect(moved).not.toBe(baseline);
  expect(baseline).toMatch(/^[0-9a-f]{64}$/u);
});

// ---------------------------------------------------------------------------
// DoD 3 — composition of the landed drain, resource and budget primitives.
// ---------------------------------------------------------------------------

it("releases a REMOVE slot through the real releaseWork, not a local drain", () => {
  const dispositions = accepted(buildSupersessionDispositions(HEALTHY));
  expect(familyOf(dispositions, "REMOVE", "RESOURCE")?.outcome).toBe("SLOT_RELEASED_RELEASED");
});

it("keeps a REMOVE release pending when the caller's boundary is not settled", () => {
  const pending = withNode("REMOVE", {
    resource: resourceFacts({
      slotState: "ACTIVE",
      release: {
        lease: LEASE, authority: PROOF,
        request: { ...RELEASE_REQUEST, resourcesTerminal: false },
      },
    }),
  } as Partial<SupersessionNodeFacts>);
  expect(familyOf(accepted(buildSupersessionDispositions(pending)), "REMOVE", "RESOURCE")?.outcome)
    .toBe("SLOT_RELEASED_DRAINING");
});

it("drains a re-run slot through the real applyDrainReason union", () => {
  const existing = applyDrainReason(null, "WORK_RELEASE_OR_PAUSE");
  expect(existing.ok).toBe(true);
  const nodes = withNode("CHANGE", {
    resource: resourceFacts({
      slotState: "ACTIVE", drainDisposition: existing.ok ? existing.value : null,
    }),
  } as Partial<SupersessionNodeFacts>);
  // GRAPH_REMOVE_OR_SUPERSESSION outranks WORK_RELEASE_OR_PAUSE, so the union revokes.
  expect(familyOf(accepted(buildSupersessionDispositions(nodes)), "CHANGE", "RESOURCE")?.outcome)
    .toBe("SLOT_DRAINED_REVOKED");
});

it("activates and cancels budget through the real reservation transitions", () => {
  const dispositions = accepted(buildSupersessionDispositions(HEALTHY));
  expect(familyOf(dispositions, "CARRY", "BUDGET")?.outcome).toBe("BUDGET_ACTIVATED");
  expect(familyOf(dispositions, "REMOVE", "BUDGET")?.outcome).toBe("BUDGET_CANCELLED");
  expect(familyOf(dispositions, "ADD", "BUDGET")?.outcome).toBe("BUDGET_UNRESERVED");
});

it("marks only the carrying kinds as carried", () => {
  const dispositions = accepted(buildSupersessionDispositions(HEALTHY));
  const carried = [...new Set(dispositions.filter((e) => e.carried).map((e) => e.kind))].sort();
  expect(carried).toEqual([...CARRIED].sort());
});

// ---------------------------------------------------------------------------
// DoD 4 — a changed or UNKNOWN fact refuses carry, naming code AND layer.
// ---------------------------------------------------------------------------

it("refuses an UNKNOWN attempt fact and never upgrades it to a safe carry", () => {
  const nodes = withNode("CARRY", { attemptLifecycle: "UNKNOWN" } as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "PLANNING_DISPOSITION_UNKNOWN", layer: "SCHEDULER_SUPERSESSION_ATTEMPT", ok: false,
  });
});

it("refuses a CHANGED attempt result rather than carrying it", () => {
  const nodes = withNode("CARRY", { attemptLifecycle: "FAILED" } as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "SUPERSESSION_CONSEQUENCE_CHANGED", layer: "SCHEDULER_SUPERSESSION_ATTEMPT", ok: false,
  });
});

it("refuses an attempt lifecycle outside the contract vocabulary", () => {
  const nodes = withNode("CARRY", { attemptLifecycle: "WEDGED" } as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_ATTEMPT", ok: false,
  });
});

it("refuses to carry an effect that is still in flight", () => {
  const nodes = withNode("CARRY", { effectsTerminal: false } as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "SUPERSESSION_CONSEQUENCE_CHANGED", layer: "SCHEDULER_SUPERSESSION_EFFECT", ok: false,
  });
});

it("refuses an UNKNOWN effect fact at the effect layer", () => {
  const nodes = withNode("CARRY", { effectsTerminal: null } as unknown as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "PLANNING_DISPOSITION_UNKNOWN", layer: "SCHEDULER_SUPERSESSION_EFFECT", ok: false,
  });
});

it("refuses to carry a slot the resource model has already released", () => {
  const nodes = withNode("CARRY", {
    resource: resourceFacts({ slotState: "RELEASED" }),
  } as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "STALE_LEASE", layer: "SCHEDULER_SUPERSESSION_RESOURCE", ok: false,
  });
});

it("refuses to carry a slot that is already draining", () => {
  const draining = applyDrainReason(null, "WORK_CANCEL");
  const nodes = withNode("CARRY", {
    resource: resourceFacts({
      slotState: "ACTIVE", drainDisposition: draining.ok ? draining.value : null,
    }),
  } as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "SUPERSESSION_CONSEQUENCE_CHANGED", layer: "SCHEDULER_SUPERSESSION_RESOURCE", ok: false,
  });
});

it("refuses a self-inconsistent drain disposition at the resource layer", () => {
  const nodes = withNode("CHANGE", {
    resource: resourceFacts({
      slotState: "ACTIVE",
      drainDisposition: {
        reasons: ["WORK_CANCEL"], strongestReason: "URGENT_REVOKE",
        terminalTarget: "REVOKED", resumable: false,
      },
    }),
  } as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_RESOURCE", ok: false,
  });
});

it("refuses a REMOVE whose release proof is fenced out by a stale epoch", () => {
  const nodes = withNode("REMOVE", {
    resource: resourceFacts({
      slotState: "ACTIVE",
      release: { lease: LEASE, authority: { ...PROOF, epoch: 2 }, request: RELEASE_REQUEST },
    }),
  } as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "STALE_LEASE", layer: "SCHEDULER_SUPERSESSION_RESOURCE", ok: false,
  });
});

it("refuses a budget fact whose version has moved under the supersession", () => {
  const nodes = withNode("CARRY", {
    budget: { ...(budgetFacts(VIEW, null) as object), expectedVersion: 9 },
  } as unknown as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "SUPERSESSION_CONSEQUENCE_CHANGED", layer: "SCHEDULER_SUPERSESSION_BUDGET", ok: false,
  });
});

it("refuses a malformed budget view at the budget layer", () => {
  const nodes = withNode("CARRY", {
    budget: budgetFacts(null, null),
  } as unknown as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_BUDGET", ok: false,
  });
});

it("refuses a malformed node set at the set layer", () => {
  for (const hostile of [null, "nodes", [null], [{ kind: "ADD" }], [{ ...HEALTHY[0], extra: 1 }]]) {
    expect(refusal(buildSupersessionDispositions(hostile)))
      .toEqual({ code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_SET", ok: false });
  }
});

it("refuses two nodes claiming the same kind rather than silently disposing one", () => {
  expect(refusal(buildSupersessionDispositions([...HEALTHY, nodeFor("CARRY")])))
    .toEqual({ code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_SET", ok: false });
});

// ---------------------------------------------------------------------------
// DoD 5 — the landed consumer edge into admission-wait's own surface.
// ---------------------------------------------------------------------------

const WAIT = {
  waitRef: "wait:1", ownerNodeKey: "node:carry", reason: "awaiting review",
  predicate: {
    predicateRef: "predicate:1", schemaId: "schema:1", schemaVersion: 1,
    parametersDigest: DIGEST,
  },
  affectedScope: ["node:carry"], recheckAtGate: "STEP_START", deadlineGate: "RESULT_SEAL",
  escalation: { kind: "NO_ESCALATION", ref: "escalation:1" },
  binding: {
    graphIdentity: "graph:1",
    sourceFactVersions: [{ sourceFactRef: "fact:1", version: 1 }],
  },
};

it("carries a wait projection whose owner node has a disposition", () => {
  const carried = carryWaitProjection(WAIT, HEALTHY);
  expect(familyOf(accepted(carried), "CARRY", "ATTEMPT")?.nodeKey).toBe("node:carry");
});

it("refuses a wait admission-wait's own validator rejects, naming the set layer", () => {
  // A recheck past its own deadline is ADMISSION_WAIT_HORIZON_INVALID inside
  // validateIntentionalWait: only the real validator refuses this shape.
  const unbounded = { ...WAIT, recheckAtGate: "GOAL_COMPLETION", deadlineGate: "STEP_START" };
  // Pin WHY it is rejected: the fixture is otherwise well formed, so only
  // admission-wait's horizon rule can be refusing it. Without this the case
  // could be passing on some unrelated malformation and prove nothing.
  const direct = validateIntentionalWait(unbounded);
  expect(direct.ok).toBe(false);
  expect(direct.ok ? [] : direct.issues.map((issue) => issue.code))
    .toEqual(["ADMISSION_WAIT_HORIZON_INVALID"]);
  expect(validateIntentionalWait(WAIT).ok).toBe(true);
  expect(refusal(carryWaitProjection(unbounded, HEALTHY)))
    .toEqual({ code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_SET", ok: false });
  expect(refusal(carryWaitProjection(null, HEALTHY)))
    .toEqual({ code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_SET", ok: false });
});

it("refuses a wait whose owner node has no disposition in the set", () => {
  const orphan = { ...WAIT, ownerNodeKey: "node:absent", affectedScope: ["node:absent"] };
  expect(refusal(carryWaitProjection(orphan, HEALTHY))).toEqual({
    code: "PLANNING_DISPOSITION_UNKNOWN", layer: "SCHEDULER_SUPERSESSION_SET", ok: false,
  });
});

it("propagates a producer refusal through the consumer edge with code and layer intact", () => {
  const nodes = withNode("CARRY", { attemptLifecycle: "UNKNOWN" } as Partial<SupersessionNodeFacts>);
  expect(refusal(carryWaitProjection(WAIT, nodes))).toEqual({
    code: "PLANNING_DISPOSITION_UNKNOWN", layer: "SCHEDULER_SUPERSESSION_ATTEMPT", ok: false,
  });
});

// ---------------------------------------------------------------------------
// DoD 3 — successor capacity and settlement, composed not restated.
// ---------------------------------------------------------------------------

const RESERVE_REQUEST = {
  requestId: "req:1",
  declaredResources: [
    { resourceId: "res:local", capacityUnits: 1, external: false, fenceable: true },
    { resourceId: "res:remote", capacityUnits: 1, external: true, fenceable: true },
  ],
  capacitySnapshot: { "res:local": 4, "res:remote": 4 }, epoch: 1,
  eligibilityEventSequenceRef: "seq:1", continuouslyEligibleSinceRef: "since:1",
  callerObservation: "obs:1",
};

/** Rows come from the real reserveAll, never from a hand-built row literal. */
function reservedRows(): unknown {
  const outcome = reserveAll(RESERVE_REQUEST);
  if (!outcome.ok || outcome.value.outcome !== "RESERVED") throw new Error("fixture reserve failed");
  return outcome.value.rows;
}

function quarantinedRows(): unknown {
  const held = adapterFail(reservedRows(), "res:remote", 1, "UNKNOWN");
  if (!held.ok) throw new Error("fixture quarantine failed");
  expect(held.value.rows.some((row) => row.state === "QUARANTINED")).toBe(true);
  return held.value.rows;
}

function removeWithCapacity(successorCapacity: unknown): readonly SupersessionNodeFacts[] {
  return withNode("REMOVE", {
    resource: resourceFacts({
      slotState: "ACTIVE", successorCapacity,
      release: { lease: LEASE, authority: PROOF, request: RELEASE_REQUEST },
    }),
  } as Partial<SupersessionNodeFacts>);
}

function removeWithBudget(patch: Record<string, unknown>): readonly SupersessionNodeFacts[] {
  return withNode("REMOVE", {
    budget: { ...(budgetFacts(HELD_VIEW, "never:1") as object), ...patch },
  } as unknown as Partial<SupersessionNodeFacts>);
}

it("grants successor capacity through the real lease-resource grant", () => {
  const nodes = removeWithCapacity({ rows: reservedRows(), proofRef: null });
  expect(familyOf(accepted(buildSupersessionDispositions(nodes)), "REMOVE", "RESOURCE")?.outcome)
    .toBe("SLOT_RELEASED_RELEASED");
});

it("refuses successor capacity a quarantined acquisition cannot prove", () => {
  expect(refusal(buildSupersessionDispositions(
    removeWithCapacity({ rows: quarantinedRows(), proofRef: null }),
  ))).toEqual({ code: "STALE_LEASE", layer: "SCHEDULER_SUPERSESSION_RESOURCE", ok: false });
});

it("grants the same quarantined capacity once a proof is supplied", () => {
  const nodes = removeWithCapacity({ rows: quarantinedRows(), proofRef: "proof:1" });
  expect(familyOf(accepted(buildSupersessionDispositions(nodes)), "REMOVE", "RESOURCE")?.outcome)
    .toBe("SLOT_RELEASED_RELEASED");
});

it("refuses a carrying node that also claims successor capacity", () => {
  const nodes = withNode("CARRY", {
    resource: resourceFacts({ slotState: "ACTIVE", successorCapacity: { rows: reservedRows(), proofRef: null } }),
  } as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "SUPERSESSION_CONSEQUENCE_CHANGED", layer: "SCHEDULER_SUPERSESSION_RESOURCE", ok: false,
  });
});

it("reports a settled predecessor from the settlement vocabulary, without re-deciding it", () => {
  const nodes = removeWithBudget({ settlementState: "SETTLED" });
  expect(familyOf(accepted(buildSupersessionDispositions(nodes)), "REMOVE", "BUDGET")?.outcome)
    .toBe("BUDGET_SETTLED");
});

it("refuses to discard a QUARANTINED settlement rather than upgrading it", () => {
  expect(refusal(buildSupersessionDispositions(removeWithBudget({ settlementState: "QUARANTINED" }))))
    .toEqual({
      code: "PLANNING_DISPOSITION_UNKNOWN", layer: "SCHEDULER_SUPERSESSION_BUDGET", ok: false,
    });
});

it("refuses a settlement state outside the settlement vocabulary", () => {
  expect(refusal(buildSupersessionDispositions(removeWithBudget({ settlementState: "FORGIVEN" }))))
    .toEqual({ code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_BUDGET", ok: false });
});

it("refuses to carry a node whose predecessor budget has already settled", () => {
  const nodes = withNode("CARRY", {
    budget: { ...(budgetFacts(VIEW, null) as object), settlementState: "SETTLED" },
  } as unknown as Partial<SupersessionNodeFacts>);
  expect(refusal(buildSupersessionDispositions(nodes))).toEqual({
    code: "SUPERSESSION_CONSEQUENCE_CHANGED", layer: "SCHEDULER_SUPERSESSION_BUDGET", ok: false,
  });
});
