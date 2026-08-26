/**
 * ALL-OR-NONE ADMISSION, MEASURED AT THE REAL CONSUMER EDGE
 * (task-005c9896f9724ece80b27f44789d0435, DoD 0 and DoD 2).
 *
 * WHY THIS FILE EXISTS. QA rejected this row's earlier proof with one exact finding: "This suite
 * proves only exported pure surfaces." A pure test can show the kernel REFUSES a partial
 * admission; it cannot show that no child obtains AUTHORITY through an edge, because there is no
 * edge in a pure test. The live consumer edge landed with
 * task-c4171c1cfe854cb78dd233794b342025 (REVIEW at the time of writing; the ARCHIVED
 * task-9634ed3b72014fe781591c7df9674da2 it replaces can never supply one), so every arm below
 * drives the daemon production entry point `handleExpansionAdmission` over a real file-backed
 * store and measures the STORE, not a return value.
 *
 * WHAT IS ADDITIVE HERE, AND WHAT IS NOT. The consumer's own suite
 * (apps/daemon/src/planning/expansion-admission-authority.test.ts) proves the HARDEST single
 * case exhaustively: the late resource refusal, its budget unwind, and seven categories of
 * absence. It proves that for ONE partiality shape. This file proves the property is UNIVERSAL
 * over the five precondition families DoD 0 enumerates — quality, scope, dependency, capacity,
 * budget — plus the one ordering that can strand a hold, at the same real edge. Neither file
 * subsumes the other.
 *
 * THE ORIGIN SET IS THE ANTI-VACUITY DEVICE. A five-way conjunction is exactly where an
 * unevaluated precondition hides: a perturbation aimed at one family can fall through to a
 * different family's check and the arm still reads "refused". So each case pins BOTH the exact
 * upstream reason code AND the origin that answered, and a separate arm asserts the six origins
 * are DISTINCT. A perturbation that fell through collides on origin and reds.
 *
 * THE ACCEPTED CONTROL IS LOAD-BEARING. Every absence assertion below would pass over a store
 * that can never record anything at all. `the nominal payload is ACCEPTED` proves the same
 * measurement sees authority when authority is real, so the absences are absences.
 */
import { describe, expect, it } from "vitest";

import { expansionApprovalAggregatePrefix }
  from "../../apps/daemon/src/planning/expansion-admission-records.js";
import { handleExpansionAdmission }
  from "../../apps/daemon/src/planning/expansion-admission-service.js";
import {
  PROJECT_ID, admissionEnvelope, admissionPayload, budget, currentFacts, graphInput, proposal,
  receipt, recordedBindings, resources, rotation, withWorld,
} from "../../apps/daemon/src/planning/expansion-admission-test-fixtures.js";

type Record_ = Record<string, unknown>;
type Store = Parameters<Parameters<typeof withWorld>[0]>[0];

/**
 * The PRODUCTION call. Nothing between the fixture inputs and the daemon entry point judges
 * anything: `admit` builds bytes, `handleExpansionAdmission` decides, this file compares.
 */
function admitThroughDaemon(
  store: Store, proposalValue: Record_, envelope: Record_ = {},
): Record_ {
  return handleExpansionAdmission({
    envelope: admissionEnvelope(admissionPayload(store, { proposal: proposalValue }), envelope),
    store,
  }) as unknown as Record_;
}

/** The healthy proposal, bound to the world the store actually holds. */
function healthy(store: Store, overrides: Record_ = {}): Record_ {
  const facts = currentFacts(store);
  return proposal({
    receipt: receipt({
      goalVersion: facts.goalVersion, graphEpoch: facts.predecessor.graphEpoch,
    }),
    ...overrides,
  });
}

/** The healthy proposal with ONE child's completion opened. Everything else is untouched. */
function openedChild(store: Store): Record_ {
  const facts = currentFacts(store);
  const scopes = receipt()["childScopes"] as readonly Record_[];
  return proposal({
    receipt: receipt({
      childScopes: [{ ...scopes[0], completion: "OPEN" }, ...scopes.slice(1)],
      goalVersion: facts.goalVersion, graphEpoch: facts.predecessor.graphEpoch,
    }),
  });
}

/** The healthy graph minus one HARD edge's typed dependency contract. */
function unprovenDependency(store: Store): Record_ {
  const graph = graphInput();
  const contracts = graph["contracts"] as readonly unknown[];
  return healthy(store, { graph: { ...graph, contracts: contracts.slice(0, 1) } });
}

interface Family {
  /** The exact stable reason code the refusing surface mints. */
  readonly code: string;
  readonly name: string;
  /** The surface that answered. Distinct per family, which is what proves independence. */
  readonly origin: string;
  /** True only where budget was reserved BEFORE the refusal, i.e. a real partial admission. */
  readonly partial: boolean;
  readonly perturb: (store: Store) => Record_;
}

/**
 * The five precondition families DoD 0 names, plus the sixth ordering that is the ONLY one able
 * to strand a hold. Each perturbation moves exactly one family's input and leaves the other four
 * healthy, so a refusal here names its own cause.
 */
const FAMILIES: readonly Family[] = [
  {
    name: "quality", origin: "EVIDENCE", code: "EXPANSION_COMPLETION_NOT_CLOSED",
    partial: false, perturb: openedChild,
  },
  {
    name: "scope", origin: "LINEAGE", code: "ADMISSION_EXPANSION_DEPTH_EXCEEDED",
    partial: false,
    perturb: (store) => healthy(store, {
      lineage: { expansionDepth: 9, nodesAddedInExpansion: 2 },
    }),
  },
  {
    name: "dependency", origin: "GRAPH", code: "ADMISSION_HARD_DEPENDENCY_UNPROVEN",
    partial: false, perturb: unprovenDependency,
  },
  {
    name: "capacity", origin: "FAIRNESS", code: "EXPANSION_ADMISSION_NO_FAIRNESS_OPPORTUNITY",
    partial: false,
    perturb: (store) => healthy(store, {
      rotation: rotation({
        capacities: [
          { resourceId: "res.a", capacityUnits: 1, inFlightUnits: 1 },
          { resourceId: "res.b", capacityUnits: 1, inFlightUnits: 1 },
        ],
      }),
    }),
  },
  {
    name: "budget", origin: "BUDGET", code: "BUDGET_RESERVATION_STALE_VERSION",
    partial: false,
    perturb: (store) => healthy(store, {
      budget: budget({
        admission: { ...(budget()["admission"] as Record_), expectedVersion: 99 },
      }),
    }),
  },
  {
    name: "resource", origin: "RESOURCE", code: "EXPANSION_ADMISSION_RESOURCES_UNAVAILABLE",
    partial: true,
    perturb: (store) => healthy(store, {
      resources: resources({ capacitySnapshot: { "res.a": 0 } }),
    }),
  },
];

const CASES = FAMILIES.map((family) => [family.name, family] as const);

/**
 * Every `<aggregateId>#<eventType>` the GLOBAL event stream holds, taken over the whole stream
 * rather than a prefix a test author remembered.
 *
 * WHY BOTH HALVES ARE COMPARED. A child, a run and a lease each manifest as a NEW AGGREGATE, so
 * the aggregate-id set covers all three categories at once and is the only honest shape for
 * `child`, which has no marker of its own. But authority appended to an EXISTING aggregate would
 * leave that set untouched, so the full row census is compared beside it: a new event type on an
 * old aggregate moves the census and nothing else.
 */
function census(store: Store): readonly string[] {
  const rows: string[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readEventsAfter(cursor, 500);
    if (page.items.length === 0) break;
    for (const event of page.items) rows.push(`${event.aggregateId}#${event.eventType}`);
    cursor = page.items[page.items.length - 1]!.globalPosition;
  }
  return rows.sort();
}

function aggregateIds(store: Store): readonly string[] {
  return [...new Set(census(store).map((row) => row.split("#")[0]!))].sort();
}

function approvalAggregates(store: Store): readonly string[] {
  return [...store.enumerateAggregateIdsByPrefix(expansionApprovalAggregatePrefix(PROJECT_ID))];
}

describe("the five precondition families are consulted independently (task-005c9896)", () => {
  it("sweeps a non-empty case set whose origins are all DISTINCT", () => {
    // Cardinality first: a sweep that generated zero cases would pass every arm below.
    expect(CASES.length).toBe(6);
    expect(new Set(FAMILIES.map((family) => family.origin)).size).toBe(6);
    expect(FAMILIES.filter((family) => family.partial)).toHaveLength(1);
  });

  it("accepts the nominal payload, so every refusal below is caused by its own perturbation", () => {
    withWorld((store) => {
      const before = aggregateIds(store);
      expect(before.length).toBeGreaterThan(0);
      const accepted = admitThroughDaemon(store, healthy(store));
      expect(accepted["ok"]).toBe(true);
      // The control that makes every absence below meaningful: this measurement DOES see
      // authority when authority is real.
      expect(recordedBindings(store)).toHaveLength(1);
      expect(approvalAggregates(store)).toHaveLength(1);
      expect(aggregateIds(store).length).toBeGreaterThan(before.length);
    });
  });

  it.each(CASES)("refuses on %s with that family's own code and origin", (_name, family) => {
    withWorld((store) => {
      const refusal = admitThroughDaemon(store, family.perturb(store));
      const upstream = refusal["upstream"] as Record_ | null;
      expect(refusal["ok"]).toBe(false);
      expect([refusal["code"], refusal["layer"]])
        .toEqual(["EXPANSION_ADMISSION_PROPOSAL_REFUSED", "ADMISSION"]);
      expect([upstream?.["code"], upstream?.["origin"]]).toEqual([family.code, family.origin]);
    });
  });
});

describe("no child obtains authority from a partially admitted expansion (task-005c9896)", () => {
  /**
   * THE ABSENCE IS ASSERTED BEFORE THE REFUSAL, DELIBERATELY. An `ok === false` guard placed
   * first short-circuits the very defect this clause is about: a gate that leaks a child makes
   * the call SUCCEED, so the guard reds and the absence assertion never runs — leaving DoD 2
   * proven by an assertion that has never once been the thing that caught anything. Measured,
   * not reasoned: with the guard first, the skipped-scope-gate drill redded on `ok`, and the
   * store was never inspected. In this order it reds on the leaked aggregate itself.
   */
  it.each(CASES)("mints no new aggregate — no child, run or lease — on %s", (_name, family) => {
    withWorld((store) => {
      const beforeIds = aggregateIds(store);
      const beforeRows = census(store);
      expect(beforeIds.length).toBeGreaterThan(0);
      expect(beforeRows.length).toBeGreaterThan(0);
      const outcome = admitThroughDaemon(store, family.perturb(store));
      expect(aggregateIds(store)).toEqual(beforeIds);
      expect(census(store)).toEqual(beforeRows);
      expect(outcome["ok"]).toBe(false);
    });
  });

  it.each(CASES)("records no approved binding and no approval aggregate on %s", (_name, family) => {
    withWorld((store) => {
      const outcome = admitThroughDaemon(store, family.perturb(store));
      expect(recordedBindings(store)).toHaveLength(0);
      expect(approvalAggregates(store)).toEqual([]);
      expect(outcome["ok"]).toBe(false);
    });
  });

  /**
   * The discriminating arm. Only the resource ordering reserves budget before refusing, so only
   * it can be PARTIALLY admitted at all. Asserting the unwind per family — cancelled AND
   * non-empty restored meters for that one, untaken for the other five — proves the sweep
   * distinguishes "a hold existed and was given back" from "nothing was ever taken". Without it,
   * the absences above would hold trivially for six refusals that all happened early.
   */
  /**
   * TWO REQUESTS AGAINST ONE HOLD, IN ONE WORLD. The consumer's own byte-set matrix runs each
   * case in its OWN fresh world, so a SEQUENCE against a single hold is uncovered there — and a
   * sequence is what a race collapses to once the store serializes it. Two outcomes are
   * admissible and both are asserted exactly: ONE winner recorded, or an exact refusal. A second
   * durable record would be two admitted expansions against one hold.
   */
  it("admits one winner and never a second record when the same request arrives twice", () => {
    withWorld((store) => {
      const first = admitThroughDaemon(store, healthy(store));
      const second = admitThroughDaemon(store, healthy(store));
      expect([first["ok"], second["ok"]]).toEqual([true, true]);
      expect(recordedBindings(store)).toHaveLength(1);
      expect(approvalAggregates(store)).toHaveLength(1);
      // The second call is a REPLAY of the first authority, not a new grant: same identity, and
      // the disposition says so rather than the test inferring it from the count.
      expect(second["disposition"]).toBe("REPLAYED");
      expect(first["disposition"]).toBe("DECIDED");
      expect(second["approvalIdentity"]).toBe(first["approvalIdentity"]);
      expect(second["recordAggregateId"]).toBe(first["recordAggregateId"]);
    });
  });

  /**
   * THE OTHER HALF OF THE SAME RACE, and the one a retry cannot stand in for. Above, the second
   * arrival carried the SAME commandId, so idempotent replay is the correct answer. Here it is
   * an INDEPENDENT command against the same hold — two racing requests, serialized by the store
   * — and replay is NOT available to it. The exact refusal is pinned, not merely "not ok": a
   * conflict that answered with some other code would mean a different comparison rejected it.
   */
  it("refuses a second, independently-commanded request against the same hold", () => {
    withWorld((store) => {
      const first = admitThroughDaemon(store, healthy(store));
      expect(first["ok"]).toBe(true);
      const second = admitThroughDaemon(store, healthy(store), {
        commandId: "cmd-expansion-admission-2", correlationId: "corr-cmd-expansion-admission-2",
      });
      const upstream = second["upstream"] as Record_ | null;
      expect(second["ok"]).toBe(false);
      expect([second["code"], second["layer"]])
        .toEqual(["EXPANSION_ADMISSION_RECORD_CONFLICT", "RECORD"]);
      expect(upstream?.["component"]).toBe("DURABLE_STORE");
      // ONE winner: the loser added no second record and moved no identity.
      expect(recordedBindings(store)).toHaveLength(1);
      expect(approvalAggregates(store)).toHaveLength(1);
    });
  });

  /**
   * THE LOSER LEAVES NOTHING BEHIND. A refusal that half-consumed the hold would show up here
   * and nowhere else: the healthy request that follows it in the SAME world would fail, or would
   * record something different from what it records on its own.
   */
  it.each(CASES)("leaves the hold usable after a %s refusal, so the loser held nothing",
    (_name, family) => {
      withWorld((store) => {
        expect(admitThroughDaemon(store, family.perturb(store))["ok"]).toBe(false);
        expect(recordedBindings(store)).toHaveLength(0);
        const accepted = admitThroughDaemon(store, healthy(store));
        expect(accepted["ok"]).toBe(true);
        expect(accepted["disposition"]).toBe("DECIDED");
        expect(recordedBindings(store)).toHaveLength(1);
      });
    });

  it.each(CASES)("proves whether %s took anything, and gives back exactly what it took",
    (_name, family) => {
      withWorld((store) => {
        const refusal = admitThroughDaemon(store, family.perturb(store));
        const unwind = refusal["unwind"] as Record_;
        expect(unwind["budgetReservationCancelled"]).toBe(family.partial);
        if (!family.partial) {
          expect(unwind["restoredMeters"]).toBeNull();
          return;
        }
        const restored = unwind["restoredMeters"] as readonly Record_[] | null;
        expect(restored).not.toBeNull();
        expect(restored).toHaveLength(1);
        expect(restored).toEqual([{ meter: "tokens", available: 1000, reserved: 0 }]);
      });
    });
});
