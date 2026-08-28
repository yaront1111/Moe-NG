/**
 * THE REFUSAL ROSTER of a replacement supersession (task-9e52f850), DoD 1 and DoD 2.
 *
 * EVERY ARM ASSERTS BOTH ABSENCES, not just the code. A refusal that CONSUMED the preparation has
 * destroyed the very thing a retry needs; one that ADVANCED AN EPOCH has moved the graph without
 * replacing it. Both are worse than the original failure and both are invisible to a return-value
 * assertion, so `expectNoResidue` re-reads the six aggregates' event counts, the still-current
 * generation and the live graph epoch after every single refusal.
 *
 * AND EVERY ARM ASSERTS THE REFUSING AUTHORITY, not only the code. Four authorities can answer
 * here — this service, the graph-revision aggregate, the goal aggregate and the store — and an
 * operator repairs each in a different place.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { readCurrentActiveGraph } from "./active-graph-projection.js";
import {
  approvableStore, closeStores, contextFor, requestFor,
} from "./graph-activation-test-fixtures.js";
import {
  GRAPH_SUPERSEDE_AUTHORITIES, GRAPH_SUPERSEDE_CODES, GRAPH_SUPERSEDE_FORBIDDEN_KEYS,
  GRAPH_SUPERSEDE_REQUEST_KEYS,
} from "./graph-supersede-contracts.js";
import { readSupersedeFacts } from "./graph-supersede-facts.js";
import type { SupersedeBudgetPort } from "./graph-supersede-facts.js";
import { supersedeActiveGraph } from "./graph-supersede-service.js";
import type { GraphSupersedeResult } from "./graph-supersede-service.js";
import {
  GOAL_ID, GRAPH_REVISION_REF, PROJECT_ID, SUCCESSOR_GRAPH_CONTENT_HASH, SUCCESSOR_REVISION_REF,
  THIRD_GRAPH_CONTENT_HASH,
  currentPreparationFence, supersedableStore, supersededStore, supersedeContext, supersedeInput,
  supersedeRequest, unpreparedStore, unsealedSuccessorStore,
} from "./graph-supersede-test-fixtures.js";
import {
  fundingAggregateId, planningFenceAggregateId, preparationAggregateId,
} from "./supersession-preparation-contracts.js";
import { foldPreparationHistory } from "./supersession-preparation-history.js";

const PREPARATION = preparationAggregateId(PROJECT_ID, GOAL_ID);

const AGGREGATES = Object.freeze([
  GOAL_ID,
  `graph-revision:${PROJECT_ID}:${GRAPH_REVISION_REF}`,
  `graph-revision:${PROJECT_ID}:${SUCCESSOR_REVISION_REF}`,
  PREPARATION,
  fundingAggregateId(PROJECT_ID, GOAL_ID),
  planningFenceAggregateId(PROJECT_ID, GOAL_ID),
] as const);

interface Residue {
  readonly counts: readonly number[];
  readonly currentGeneration: number | null;
  readonly graphEpoch: number | null;
}

function residueOf(store: SqliteEventStore): Residue {
  const history = foldPreparationHistory(store, PREPARATION);
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  return {
    counts: AGGREGATES.map((aggregateId) => store.readEvents(aggregateId).length),
    currentGeneration: history.ok && history.current !== null
      ? history.current.binding.generation : null,
    graphEpoch: active.ok ? active.graphEpoch : null,
  };
}

function refusal(result: GraphSupersedeResult): Extract<GraphSupersedeResult, { ok: false }> {
  if (result.ok) throw new Error("expected a refusal, got an accepted supersession");
  return result;
}

/**
 * Run one arm and prove it consumed nothing, advanced nothing and wrote nothing.
 *
 * THE RESIDUE ASSERTIONS COME FIRST, and the order is load-bearing rather than stylistic. Asserting
 * "it refused" before "it left nothing behind" makes the refusal the only failure a mutation can
 * report, and the residue check then rides along untested. Checked first, a mutant that lets a
 * refusal path commit is reported BY the residue assertion — which is the property DoD 2 names.
 */
function expectRefusedWithNoResidue(
  store: SqliteEventStore, run: () => GraphSupersedeResult,
): Extract<GraphSupersedeResult, { ok: false }> {
  const before = residueOf(store);
  const horizonBefore = store.readEventHorizon();
  const result = run();
  expect(residueOf(store)).toStrictEqual(before);
  expect(store.readEventHorizon()).toBe(horizonBefore);
  return refusal(result);
}

describe("the supersede vocabulary is closed and pinned (task-9e52f850)", () => {
  it("pins the exact code, authority, request-key and forbidden-key denominators", () => {
    expect(GRAPH_SUPERSEDE_CODES).toHaveLength(17);
    expect(GRAPH_SUPERSEDE_CODES).toContain("GRAPH_SUPERSEDE_DISPOSITION_INCOMPLETE");
    expect(GRAPH_SUPERSEDE_CODES).toContain("GRAPH_SUPERSEDE_PREPARATION_EXPIRED");
    expect(GRAPH_SUPERSEDE_AUTHORITIES).toHaveLength(4);
    expect(GRAPH_SUPERSEDE_REQUEST_KEYS).toHaveLength(11);
    expect(GRAPH_SUPERSEDE_FORBIDDEN_KEYS).toHaveLength(8);
    expect(new Set(GRAPH_SUPERSEDE_CODES).size).toBe(GRAPH_SUPERSEDE_CODES.length);
    expect(new Set(GRAPH_SUPERSEDE_REQUEST_KEYS).size).toBe(GRAPH_SUPERSEDE_REQUEST_KEYS.length);
    expect(new Set(GRAPH_SUPERSEDE_FORBIDDEN_KEYS).size)
      .toBe(GRAPH_SUPERSEDE_FORBIDDEN_KEYS.length);
    // A forbidden key that is ALSO an accepted key would make its arm unfalsifiable.
    for (const key of GRAPH_SUPERSEDE_FORBIDDEN_KEYS) {
      expect(GRAPH_SUPERSEDE_REQUEST_KEYS).not.toContain(key);
    }
  });
});

describe("DoD 1: the request may identify targets and fence versions, nothing else", () => {
  it.each(GRAPH_SUPERSEDE_FORBIDDEN_KEYS)(
    "refuses a request smuggling the server-owned fact %s", (key) => {
      const store = supersedableStore();
      const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
        supersedeContext(store, "cmd-supersede-1",
          { ...supersedeRequest(store), [key]: "smuggled" }),
        supersedeInput(),
      ));
      expect(answer.code).toBe("GRAPH_SUPERSEDE_REQUEST_INVALID");
      expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
      expect(answer.layer).toBe("GRAPH_SUPERSEDE");
      closeStores();
    });

  /**
   * The two new SERVER-OWNED facts, hostile-tested by name (task-7eddd612, epic rail 7B).
   *
   * Neither is in GRAPH_SUPERSEDE_FORBIDDEN_KEYS, so the `it.each` sweep above cannot see them —
   * they are refused by the EXACT-KEY decode instead. Landing a coverage gate and a deadline gate
   * without these arms would leave the interesting question ("can a caller supply its own coverage
   * or push its own deadline out?") answered only by inspection.
   */
  it.each([
    ["coverage", "COMPLETE"], ["deadlineEpochMs", 0], ["dispositionCoverage", "COMPLETE"],
  ])("refuses a request supplying the server-owned %s", (key, value) => {
    const store = supersedableStore();
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", { ...supersedeRequest(store), [key]: value }),
      supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_REQUEST_INVALID");
    expect(answer.layer).toBe("GRAPH_SUPERSEDE");
    expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    // The roster stayed closed: neither key was quietly admitted to buy the arm a pass.
    expect(GRAPH_SUPERSEDE_REQUEST_KEYS).not.toContain(key);
    closeStores();
  });

  it("refuses a request missing a selector", () => {
    const store = supersedableStore();
    const payload = supersedeRequest(store);
    delete payload["successorRevisionRef"];
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", payload), supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_REQUEST_INVALID");
    closeStores();
  });

  it("refuses a non-integer fence, a zero generation and a non-hex successor hash", () => {
    const store = supersedableStore();
    for (const override of [
      { expectedPreparationVersion: "1" }, { generation: 0 }, { generation: 1.5 },
      { expectedPreparationVersion: -1 }, { successorGraphContentHash: "not-hex" },
    ]) {
      const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
        supersedeContext(store, "cmd-supersede-1", supersedeRequest(store, override)),
        supersedeInput(),
      ));
      expect(answer.code, JSON.stringify(override)).toBe("GRAPH_SUPERSEDE_REQUEST_INVALID");
    }
    closeStores();
  });

  it("refuses a payload naming a FOREIGN project, before any current fact is read", () => {
    const store = supersedableStore();
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1",
        supersedeRequest(store, { projectId: "project-2" })),
      supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_TARGET_FOREIGN");
    expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    closeStores();
  });

  it("refuses with the projection's OWN code and layer when no graph is active", () => {
    const store = approvableStore();
    const answer = refusal(supersedeActiveGraph(contextFor(store, requestFor("cmd-supersede-1", {
      commandId: "cmd-supersede-1", correlationId: "corr-supersede",
      decidedAt: "2026-08-26T00:10:00.000Z", expectedPredecessorRevisionRef: GRAPH_REVISION_REF,
      expectedPreparationVersion: 0, generation: 1, goalRef: GOAL_ID,
      principalId: "principal-1", projectId: PROJECT_ID,
      successorGraphContentHash: SUCCESSOR_GRAPH_CONTENT_HASH,
      successorRevisionRef: SUCCESSOR_REVISION_REF,
    } as JsonObject)), supersedeInput()));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_CURRENT_GRAPH_UNAVAILABLE");
    expect(answer.sourceCode).toBe("ACTIVE_GRAPH_ABSENT");
    expect(answer.sourceLayer).toBe("ACTIVE_GRAPH_PROJECTION");
    closeStores();
  });

  it("refuses an unreadable goal record at the production fact reader", () => {
    const store = supersedableStore();
    const decoded = supersedeRequest(store) as unknown as Parameters<typeof readSupersedeFacts>[1];
    // The GOAL fault a caller can actually produce is a record this module cannot read at all;
    // a foreign goalRef is answered earlier by the predecessor's own provenance.
    const answer = readSupersedeFacts(store, decoded, undefined);
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error("expected a refusal");
    expect(answer.code).toBe("GRAPH_SUPERSEDE_GOAL_UNREADABLE");
    expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    closeStores();
  });
});

describe("DoD 2: every refusal class, pinned and residue-free", () => {
  it("WRONG PREDECESSOR: an expected predecessor that is not the active revision", () => {
    const store = supersedableStore();
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1",
        supersedeRequest(store, { expectedPredecessorRevisionRef: "graph-revision-9" })),
      supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_PREDECESSOR_MISMATCH");
    expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    closeStores();
  });

  it("WRONG PREDECESSOR: a goal that does not own the active graph", () => {
    const store = supersedableStore();
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", supersedeRequest(store, { goalRef: "goal-9" })),
      supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_PREDECESSOR_MISMATCH");
    closeStores();
  });

  it("WRONG SUCCESSOR: a successor that IS the predecessor", () => {
    const store = supersedableStore();
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1",
        supersedeRequest(store, { successorRevisionRef: GRAPH_REVISION_REF })),
      supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_SUCCESSOR_INVALID");
    closeStores();
  });

  it("WRONG SUCCESSOR: a successor whose aggregate already has a history", () => {
    // After one accepted supersession the now-SUPERSEDED `graph-revision-1` is neither the
    // predecessor nor empty, so it is the one revision ref that can reach this guard.
    const store = supersededStore();
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-2", {
        commandId: "cmd-supersede-2", correlationId: "corr-supersede-2",
        decidedAt: "2026-08-26T00:40:00.000Z",
        expectedPredecessorRevisionRef: SUCCESSOR_REVISION_REF,
        expectedPreparationVersion: 2, generation: 1, goalRef: GOAL_ID,
        principalId: "principal-1", projectId: PROJECT_ID,
        successorGraphContentHash: THIRD_GRAPH_CONTENT_HASH,
        successorRevisionRef: GRAPH_REVISION_REF,
      }), supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_SUCCESSOR_ALREADY_RECORDED");
    expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    closeStores();
  });

  it("CONTENT OUTSIDE THE SEAL: a successor hash naming bytes nothing has sealed", () => {
    const store = unsealedSuccessorStore();
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1"), supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_SUCCESSOR_CONTENT_UNSEALED");
    expect(answer.sourceCode).toBe("GRAPH_BODY_ABSENT");
    expect(answer.sourceLayer).toBe("GRAPH_BODY_RECORD");
    closeStores();
  });

  it("PREPARATION ABSENT: no generation is current", () => {
    const store = unpreparedStore();
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", {
        commandId: "cmd-supersede-1", correlationId: "corr-supersede",
        decidedAt: "2026-08-26T00:10:00.000Z", expectedPredecessorRevisionRef: GRAPH_REVISION_REF,
        expectedPreparationVersion: 0, generation: 1, goalRef: GOAL_ID,
        principalId: "principal-1", projectId: PROJECT_ID,
        successorGraphContentHash: SUCCESSOR_GRAPH_CONTENT_HASH,
        successorRevisionRef: SUCCESSOR_REVISION_REF,
      }), supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_PREPARATION_ABSENT");
    closeStores();
  });

  it("NEAR-MISS GENERATION: a generation one away from the current one refuses", () => {
    const store = supersedableStore();
    const fence = currentPreparationFence(store);
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1",
        supersedeRequest(store, { generation: fence.generation + 1 })),
      supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_PREPARATION_STALE");
    expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    closeStores();
  });

  it("STALE VERSION: the right generation at a version one away refuses", () => {
    const store = supersedableStore();
    const fence = currentPreparationFence(store);
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", supersedeRequest(store, {
        expectedPreparationVersion: fence.expectedPreparationVersion + 1,
      })), supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_PREPARATION_STALE");
    closeStores();
  });

  it("DRIFT: a goal record whose epoch disagrees with the live active graph", () => {
    const store = supersedableStore();
    const request = supersedeRequest(store) as unknown as Parameters<typeof readSupersedeFacts>[1];
    const answer = readSupersedeFacts(store, request, {
      activeGraphRevisionRef: GRAPH_REVISION_REF, graphEpoch: 2, version: 2,
    } as unknown as JsonObject);
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error("expected a refusal");
    expect(answer.code).toBe("GRAPH_SUPERSEDE_PREPARATION_DRIFT");
    expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    closeStores();
  });

  it("DRIFT: a goal record naming a different active revision than the projection", () => {
    const store = supersedableStore();
    const request = supersedeRequest(store) as unknown as Parameters<typeof readSupersedeFacts>[1];
    const answer = readSupersedeFacts(store, request, {
      activeGraphRevisionRef: "graph-revision-9", graphEpoch: 1, version: 2,
    } as unknown as JsonObject);
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error("expected a refusal");
    expect(answer.code).toBe("GRAPH_SUPERSEDE_PREPARATION_DRIFT");
    closeStores();
  });

  it("FUNDING NO LONGER BACKS THE HOLD: refused through the injected budget port", () => {
    const store = supersedableStore();
    const shrunk: SupersedeBudgetPort = () => Object.freeze({
      code: "BUDGET_PROJECTION_ABSENT", layer: "BUDGET_CURRENT_PROJECTION", ok: false as const,
    }) as ReturnType<SupersedeBudgetPort>;
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1"), supersedeInput(), shrunk,
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_FUNDING_UNAVAILABLE");
    expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    closeStores();
  });

  it("PREPARATION UNVERIFIABLE: an unreadable history refuses with the fold's own code", () => {
    const store = supersedableStore();
    // A corrupt durable history cannot be produced by a production writer; that is what makes it
    // corrupt. The event is appended straight to the aggregate so the FOLD is what answers.
    store.commit({
      aggregateId: PREPARATION,
      commandBytes: new TextEncoder().encode("corrupt"),
      commandId: "corrupt-preparation",
      committedAt: "2026-08-26T00:50:00.000Z",
      events: [{
        eventId: "corrupt-preparation-1", eventType: "SupersessionPreparationCommitted",
        payload: new TextEncoder().encode("{}"),
      }],
      expectedVersion: 1,
    });
    const fence = { expectedPreparationVersion: 2, generation: 1 };
    const answer = refusal(supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1", {
      commandId: "cmd-supersede-1", correlationId: "corr-supersede",
      decidedAt: "2026-08-26T00:10:00.000Z", expectedPredecessorRevisionRef: GRAPH_REVISION_REF,
      expectedPreparationVersion: fence.expectedPreparationVersion,
      generation: fence.generation, goalRef: GOAL_ID, principalId: "principal-1",
      projectId: PROJECT_ID, successorGraphContentHash: SUCCESSOR_GRAPH_CONTENT_HASH,
      successorRevisionRef: SUCCESSOR_REVISION_REF,
    }), supersedeInput()));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_PREPARATION_UNVERIFIABLE");
    expect(answer.sourceCode).toBe("PREPARATION_HISTORY_MALFORMED");
    expect(answer.sourceLayer).toBe("SUPERSESSION_PREPARATION_HISTORY");
    closeStores();
  });
});

/**
 * DoD 3: a preparation whose window has closed cannot authorize a supersession (task-7eddd612).
 *
 * THE BOUNDARY IS READ BACK, NEVER HAND-COMPUTED. `deadlineEpochMs` is
 * `Date.parse(prepare.decidedAt) + PREPARATION_WINDOW_MS`; an arm that hardcoded the sum would
 * silently detach the day the window moves, so both arms derive it from the committed generation
 * through the production fold.
 *
 * DIVERGENCE (epic rail 7A), measured rather than asserted: at this row's step 1 the supersession
 * `deadlineEpochMs` had ZERO production readers repo-wide, so no other mechanism ANYWHERE can
 * answer on it. `supersedableStore` additionally presents a lineage roster and digest that match
 * the generation, so PREPARATION_DRIFT cannot fire, and funding still backs it. The deadline
 * compare is therefore the only thing that can refuse arm A — loosen it and arm A goes green.
 */
function currentDeadlineEpochMs(store: SqliteEventStore): number {
  const history = foldPreparationHistory(store, PREPARATION);
  if (!history.ok || history.current === null) {
    throw new Error("fixture has no current generation to read a deadline from");
  }
  return history.current.binding.deadlineEpochMs;
}

describe("DoD 3: the preparation window is closed by the command's own decidedAt (task-7eddd612)", () => {
  it("EXPIRED: one millisecond past the deadline refuses and consumes nothing", () => {
    const store = supersedableStore();
    const deadline = currentDeadlineEpochMs(store);
    const decidedAt = new Date(deadline + 1).toISOString();
    // Round-trip proof that `Date.parse` reads back exactly what the daemon stamps.
    expect(Date.parse(decidedAt)).toBe(deadline + 1);

    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-expired",
        supersedeRequest(store, { commandId: "cmd-supersede-expired", decidedAt })),
      supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_PREPARATION_EXPIRED");
    expect(answer.layer).toBe("GRAPH_SUPERSEDE");
    expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    // The generation is still CURRENT, so a caller inside the window can still retry.
    expect(currentPreparationFence(store)).toStrictEqual({
      expectedPreparationVersion: 1, generation: 1,
    });
    closeStores();
  });

  it("UNPARSEABLE: a decidedAt that is not an instant refuses at DECODE, before any fact", () => {
    const store = supersedableStore();
    // Without the decoder's clause this is the window's bypass, not a cosmetic fault:
    // `Date.parse("not-a-date")` is NaN and `NaN > deadline` is FALSE, so an unreadable stamp
    // would sail PAST a closed window instead of being caught by it.
    const answer = expectRefusedWithNoResidue(store, () => supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-unparseable",
        supersedeRequest(store, {
          commandId: "cmd-supersede-unparseable", decidedAt: "not-a-date",
        })),
      supersedeInput(),
    ));
    expect(answer.code).toBe("GRAPH_SUPERSEDE_REQUEST_INVALID");
    expect(answer.layer).toBe("GRAPH_SUPERSEDE");
    expect(answer.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    closeStores();
  });

  it("BOUNDARY: decidedAt EXACTLY at the deadline is inside the window and decides", () => {
    const store = supersedableStore();
    const deadline = currentDeadlineEpochMs(store);
    const decidedAt = new Date(deadline).toISOString();
    expect(Date.parse(decidedAt)).toBe(deadline);

    const outcome = supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-boundary",
        supersedeRequest(store, { commandId: "cmd-supersede-boundary", decidedAt })),
      supersedeInput(),
    );
    // `>` not `>=`: the window is inclusive of its own last instant. This arm is the ONLY thing
    // that reddens the off-by-one mutant, so it asserts acceptance rather than "not EXPIRED".
    expect(outcome.ok).toBe(true);
    closeStores();
  });
});
