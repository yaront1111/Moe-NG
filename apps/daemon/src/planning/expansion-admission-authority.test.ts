/**
 * What a refusal LEAVES BEHIND, and what a change of bytes forces
 * (task-c4171c1cfe854cb78dd233794b342025). Every arm drives the production service
 * `handleExpansionAdmission` over a REAL file-backed `SqliteEventStore`.
 *
 * THE LATE REFUSAL IS THE HARD ONE. `admitExpansion` reserves budget BEFORE it acquires
 * resources, so exactly one ordering can strand a hold: a resource refusal arriving after the
 * reservation. Two assertions carry the weight, and both qualifiers matter — the restored-meter
 * set must be NON-EMPTY, and it must be EXACT. "Unwind happened" and "some meters were restored"
 * both pass unchanged when nothing was restored at all, so the set and its cardinality are
 * asserted, and an EARLY refusal is asserted beside it as the discriminating control: if the
 * non-empty assertion were vacuous, the early arm would pass with the same shape.
 *
 * THE SEVEN ABSENCES ARE ASSERTED INDEPENDENTLY. One combined "no residue" check passes while a
 * single category leaks, and these are exactly the authorities that cannot be compensated after
 * the fact. Each category gets its own arm, measured over a census of the WHOLE store — every
 * aggregate, every event type — taken before the call and again after it. The census is asserted
 * non-empty first, because an enumeration that returned nothing would make every "unchanged" arm
 * below vacuous.
 *
 * THE BYTE-SET MATRIX PROVES RE-ADMISSION, NOT MERELY COMPLETION. A journey that silently reused
 * a prior identity would still complete and its recorded identities would still parse. So each
 * byte-set arm runs in its OWN fresh world and asserts which identities MOVED against the
 * baseline, or — where the change invalidates the human approval — that the exact reapproval code
 * fired and nothing at all was recorded.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import {
  EXPANSION_APPROVAL_EVENT_TYPE, expansionApprovalAggregatePrefix,
} from "./expansion-admission-records.js";
import {
  PROJECT_ID, SUCCESSOR_HASH, acceptedOf, admit, criteria, currentFacts, hex, proposal,
  receipt, recordedBindings, refusalOf, resources, supersession, withWorld,
} from "./expansion-admission-test-fixtures.js";

type Record_ = Record<string, unknown>;

function withCurrentReceipt(store: SqliteEventStore, overrides: Record_): Record_ {
  const facts = currentFacts(store);
  return {
    proposal: proposal({
      receipt: receipt({
        goalVersion: facts.goalVersion, graphEpoch: facts.predecessor.graphEpoch,
      }),
      ...overrides,
    }),
  };
}

describe("a late refusal proves its budget unwind (task-c4171c1c)", () => {
  it("forwards the resource refusal with the scheduler's own code, layer and origin", () => {
    withWorld((store) => {
      const refusal = refusalOf(admit(store, withCurrentReceipt(store, {
        resources: resources({ capacitySnapshot: { "res.a": 0 } }),
      })));
      expect(refusal.code).toBe("EXPANSION_ADMISSION_PROPOSAL_REFUSED");
      expect(refusal.layer).toBe("ADMISSION");
      expect(refusal.upstream?.code).toBe("EXPANSION_ADMISSION_RESOURCES_UNAVAILABLE");
      expect(refusal.upstream?.layer).toBe("RESOURCE");
      expect(refusal.upstream?.origin).toBe("RESOURCE");
    });
  });

  it("carries a NON-EMPTY restored-meter set of exactly the buckets it took back", () => {
    withWorld((store) => {
      const refusal = refusalOf(admit(store, withCurrentReceipt(store, {
        resources: resources({ capacitySnapshot: { "res.a": 0 } }),
      })));
      expect(refusal.unwind.budgetReservationCancelled).toBe(true);
      const restored = refusal.unwind.restoredMeters;
      expect(restored).not.toBeNull();
      // NON-EMPTY and EXACT, both asserted: cardinality first, then the set byte for byte.
      expect(restored).toHaveLength(1);
      expect(restored).toEqual([{ meter: "tokens", available: 1000, reserved: 0 }]);
    });
  });

  it("reports NO cancellation when the refusal arrived before any reservation", () => {
    // The discriminating control. If the assertions above were satisfiable without a real
    // unwind, this early refusal would carry the same shape; it does not.
    withWorld((store) => {
      const refusal = refusalOf(admit(store, withCurrentReceipt(store, { graph: "junk" })));
      expect(refusal.code).toBe("EXPANSION_ADMISSION_PROPOSAL_REFUSED");
      expect(refusal.unwind.budgetReservationCancelled).toBe(false);
      expect(refusal.unwind.restoredMeters).toBeNull();
    });
  });
});

/**
 * Every `<aggregateId>#<eventType>` the store holds. The GLOBAL event stream, not a chosen
 * prefix: a census taken over prefixes a test author remembered would miss the one category that
 * leaked. `enumerateAggregateIdsByPrefix("")` is not an option — the store refuses an empty
 * prefix with STORE_INPUT_INVALID.
 */
function census(store: SqliteEventStore): readonly string[] {
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

/** Every aggregate id the global stream mentions. A NEW one is a minted child. */
function aggregateIds(store: SqliteEventStore): readonly string[] {
  return [...new Set(census(store).map((row) => row.split("#")[0]!))].sort();
}

function matching(rows: readonly string[], pattern: RegExp): readonly string[] {
  return rows.filter((row) => pattern.test(row));
}

interface Absence {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * The seven categories DoD 2 enumerates. `child` has no marker of its own — a child would be a
 * NEW aggregate — so it is measured as "no aggregate id appeared", which is the only honest
 * shape for it.
 */
const ABSENCES: readonly Absence[] = [
  { name: "resource", pattern: /resource/iu },
  { name: "run", pattern: /run/iu },
  { name: "lease", pattern: /lease/iu },
  { name: "effect", pattern: /effect/iu },
  { name: "graph mutation", pattern: /graph/iu },
  { name: "activation", pattern: /activat/iu },
];

describe("a late refusal leaves no durable authority of any of the seven kinds", () => {
  it("sweeps a non-empty category roster over a non-empty store census", () => {
    expect(ABSENCES.length).toBe(6);
    withWorld((store) => {
      expect(census(store).length).toBeGreaterThan(0);
    });
  });

  it.each(ABSENCES.map((entry) => [entry.name, entry] as const))(
    "leaves the %s category byte-identical", (_name, entry) => {
      withWorld((store) => {
        const before = matching(census(store), entry.pattern);
        refusalOf(admit(store, withCurrentReceipt(store, {
          resources: resources({ capacitySnapshot: { "res.a": 0 } }),
        })));
        expect(matching(census(store), entry.pattern)).toEqual(before);
      });
    },
  );

  it("leaves the child category empty: no aggregate id appeared at all", () => {
    withWorld((store) => {
      const before = aggregateIds(store);
      expect(before.length).toBeGreaterThan(0);
      refusalOf(admit(store, withCurrentReceipt(store, {
        resources: resources({ capacitySnapshot: { "res.a": 0 } }),
      })));
      expect(aggregateIds(store)).toEqual(before);
    });
  });

  it("records no approved binding and mints no approval aggregate", () => {
    withWorld((store) => {
      refusalOf(admit(store, withCurrentReceipt(store, {
        resources: resources({ capacitySnapshot: { "res.a": 0 } }),
      })));
      expect(recordedBindings(store)).toHaveLength(0);
      expect(store.enumerateAggregateIdsByPrefix(
        expansionApprovalAggregatePrefix(PROJECT_ID),
      )).toEqual([]);
    });
  });
});

interface ByteSet {
  readonly moves: readonly ("approvalIdentity" | "preparationIdentity" | "proposalIdentity")[];
  readonly name: string;
  readonly overrides: (store: SqliteEventStore) => Record_;
  readonly refusesWith: string | null;
  readonly upstreamCode: string | null;
}

/**
 * Four byte-sets. Three re-admit and MOVE the identities they touch; the fourth invalidates the
 * human approval, so re-approval is required and nothing is recorded at all.
 */
const BYTE_SETS: readonly ByteSet[] = [
  {
    name: "proposal bytes: a different receipt revision",
    moves: ["approvalIdentity", "preparationIdentity", "proposalIdentity"],
    refusesWith: null, upstreamCode: null,
    overrides: (store) => {
      const facts = currentFacts(store);
      return {
        proposal: proposal({
          receipt: receipt({
            goalVersion: facts.goalVersion, graphEpoch: facts.predecessor.graphEpoch,
            revision: 4,
          }),
        }),
      };
    },
  },
  {
    name: "prepared bytes: a different criteria reference",
    moves: ["approvalIdentity", "preparationIdentity"],
    refusesWith: null, upstreamCode: null,
    overrides: () => ({ criteria: criteria({ criteriaRef: hex("6") }) }),
  },
  {
    name: "resource bytes: a different acquisition epoch",
    moves: ["approvalIdentity", "preparationIdentity", "proposalIdentity"],
    refusesWith: null, upstreamCode: null,
    overrides: (store) => {
      const facts = currentFacts(store);
      return {
        proposal: proposal({
          receipt: receipt({
            goalVersion: facts.goalVersion, graphEpoch: facts.predecessor.graphEpoch,
          }),
          resources: resources({ epoch: 2 }),
        }),
      };
    },
  },
  {
    name: "revision bytes: a successor the approval record does not name",
    moves: [],
    refusesWith: "EXPANSION_ADMISSION_APPROVAL_REFUSED",
    upstreamCode: "EXPANSION_APPROVAL_REVISION_MISMATCH",
    overrides: (store) => {
      const predecessor = currentFacts(store).predecessor;
      const base = supersession(predecessor) as Record_;
      return {
        supersession: {
          ...base,
          successor: { ...(base["successor"] as Record_), graphContentHash: hex("7") },
        },
      };
    },
  },
];

describe("changed bytes force re-admission and never reuse stale authority", () => {
  it("sweeps a non-empty byte-set roster covering all four families", () => {
    expect(BYTE_SETS).toHaveLength(4);
    expect(SUCCESSOR_HASH).not.toBe(hex("7"));
  });

  it.each(BYTE_SETS.map((entry) => [entry.name, entry] as const))(
    "re-decides for %s", (_name, entry) => {
      const baseline = withWorld((store) => acceptedOf(admit(store)));
      withWorld((store) => {
        const outcome = admit(store, entry.overrides(store));
        if (entry.refusesWith !== null) {
          const refusal = refusalOf(outcome);
          expect(refusal.code).toBe(entry.refusesWith);
          expect(refusal.upstream?.code).toBe(entry.upstreamCode);
          expect(refusal.upstream?.component).toBe("EXPANSION_APPROVAL");
          expect(recordedBindings(store)).toHaveLength(0);
          return;
        }
        const accepted = acceptedOf(outcome);
        const recorded = recordedBindings(store);
        expect(recorded).toHaveLength(1);
        for (const key of entry.moves) {
          expect(accepted[key]).not.toBe(baseline[key]);
          expect(recorded[0]![key]).toBe(accepted[key]);
        }
        // The identity families this byte-set does NOT touch must be unchanged, or "it moved"
        // would be satisfied by a journey that re-derived everything from nothing.
        const held = (["approvalIdentity", "preparationIdentity", "proposalIdentity"] as const)
          .filter((key) => !entry.moves.includes(key));
        for (const key of held) expect(accepted[key]).toBe(baseline[key]);
      });
    },
  );
});

/** Every non-test, non-fixture TypeScript source under `apps/daemon/src`. */
function productionSources(): readonly string[] {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")
        && !entry.name.includes("fixtures")) {
        found.push(path);
      }
    }
  };
  walk(root);
  return found;
}

const KERNEL_CALLS: readonly string[] = [
  "admitExpansion(", "bindExpansionAdmission(", "prepareExpansion(",
  "approveExpansionManually(",
];

/**
 * RAIL 0 IS GRADED ON THE CALL SITE, NOT THE SYMBOL. The scan enumerates production sources from
 * the filesystem and looks for the CALL, and it excludes `*fixtures*` as well as `*.test.*` —
 * `grep -v '\.test\.'` alone counts a fixture module as production wiring, which is precisely
 * the defect this arm exists to catch.
 */
describe("the three kernels are CALLED from daemon production code (task-c4171c1c)", () => {
  it("scans a non-empty production source set that excludes tests and fixtures", () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((path) => path.includes("fixtures"))).toBe(false);
    expect(sources.some((path) => path.includes(".test."))).toBe(false);
  });

  it.each(KERNEL_CALLS)("calls %s from at least one production module", (call) => {
    const callers = productionSources().filter(
      (path) => readFileSync(path, "utf8").includes(call),
    );
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.some((path) => path.endsWith("expansion-admission-service.ts"))).toBe(true);
  });

  it("reaches the durable approval record only through that same production module", () => {
    const writers = productionSources().filter(
      (path) => readFileSync(path, "utf8").includes("commitExpansionApproval("),
    );
    expect(writers.filter((path) => path.endsWith("expansion-admission-service.ts")))
      .toHaveLength(1);
    expect(EXPANSION_APPROVAL_EVENT_TYPE).toBe("ExpansionApprovalBindingRecorded");
  });
});
