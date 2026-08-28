/**
 * The durable half, against a REAL SqliteEventStore (task-32c1ba45).
 *
 * Every world here is built by production writers: the ACTIVE graph by `activateApprovedGraph`,
 * the preparation by `commitPreparation`, the release by `releasePreparation`. Nothing
 * hand-commits a preparation, funding or fence event, so an arm that reads one back is reading
 * what the production path wrote.
 *
 * RAW COUNTS, NOT STATE EQUALITY. A replay that duplicated a money-shaped record would leave the
 * folded state identical, so the replay arms assert raw event, decision and reservation-event
 * counts rather than the projection they fold to.
 */
import { describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { decisionCount } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import {
  fundingAggregateId, planningFenceAggregateId, preparationAggregateId,
} from "./supersession-preparation-contracts.js";
import {
  PREPARATION_EVENT_TYPES, RELEASE_ACTIVATION_EVIDENCE, commitPreparation,
  foldPreparationHistory, releasePreparation,
} from "./supersession-preparation-ledger.js";
import type { PreparationLedgerResult } from "./supersession-preparation-ledger.js";
import { proposeSupersessionPreparation } from "./supersession-preparation-service.js";
import {
  PROJECT_ID_FOR_PREPARATION as PROJECT_ID,
  GOAL_ID_FOR_PREPARATION as GOAL_ID,
  activatedStore, prepareContext, prepareRequest, releaseContext,
} from "./supersession-preparation-service.test.js";
import { approvableStore } from "./graph-activation-test-fixtures.js";

const PREPARATION = preparationAggregateId(PROJECT_ID, GOAL_ID);
const FUNDING = fundingAggregateId(PROJECT_ID, GOAL_ID);
const FENCE = planningFenceAggregateId(PROJECT_ID, GOAL_ID);

/** The three aggregates the pair lives on, named once so an arm cannot silently drop one. */
const PAIR_AGGREGATES = Object.freeze([PREPARATION, FUNDING, FENCE] as const);

function accept(result: PreparationLedgerResult): Extract<PreparationLedgerResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected an accepted ledger move, got ${result.code}/${result.sourceCode ?? "-"}`);
  }
  return result;
}

function counts(store: SqliteEventStore): readonly number[] {
  return PAIR_AGGREGATES.map((aggregateId) => store.readEvents(aggregateId).length);
}

/** The activated world with no preparation yet, named so the matrix rows can cite it. */
function preparedFreeStore(): SqliteEventStore {
  return activatedStore();
}

function preparedStore(): SqliteEventStore {
  const store = activatedStore();
  accept(commitPreparation(prepareContext(store, "cmd-prepare-1")));
  return store;
}

describe("commitPreparation lands the pair in one decision or none (task-32c1ba45)", () => {
  it("names exactly three aggregates so no arm can drop a member", () => {
    expect(PAIR_AGGREGATES).toHaveLength(3);
    expect(new Set(PAIR_AGGREGATES).size).toBe(3);
  });

  it("ACCEPTED CONTROL: one decision writes the record, the HELD hold and the ACTIVE fence", () => {
    const store = activatedStore();
    expect(counts(store)).toEqual([0, 0, 0]);
    const decisionsBefore = decisionCount(store);

    const committed = accept(commitPreparation(prepareContext(store, "cmd-prepare-1")));

    expect(counts(store)).toEqual([1, 1, 1]);
    expect(decisionCount(store)).toBe(decisionsBefore + 1);
    expect(store.readEvents(PREPARATION)[0]?.eventType).toBe(PREPARATION_EVENT_TYPES.PREPARED);
    expect(store.readEvents(FUNDING)[0]?.eventType)
      .toBe(PREPARATION_EVENT_TYPES.FUNDING_RESERVED);
    expect(store.readEvents(FENCE)[0]?.eventType).toBe(PREPARATION_EVENT_TYPES.FENCE_OPENED);
    expect(committed.generation.funding.lifecycle).toBe("HELD");
    expect(committed.generation.fence.lifecycle).toBe("ACTIVE");
    expect(committed.generation.binding.generation).toBe(1);
  });

  it("binds the same plan identity and shared fields into all three payloads", () => {
    const store = preparedStore();
    const payloads = PAIR_AGGREGATES.map((aggregateId) => {
      const [event] = store.readEvents(aggregateId);
      if (event === undefined) throw new Error(`no event on ${aggregateId}`);
      return JSON.parse(new TextDecoder().decode(event.payload)) as Record<string, unknown>;
    });
    const identities = payloads.map((payload) => payload["supersessionPlanId"]);
    expect(new Set(identities).size).toBe(1);
    for (const key of ["deadlineEpochMs", "factHorizonDigest", "generation", "goalRef",
      "targetRevisionRef"]) {
      expect(new Set(payloads.map((payload) => payload[key])).size).toBe(1);
    }
  });

  it("reads the secondary versions from the store, so a second generation fences correctly", () => {
    const store = preparedStore();
    // versionOf(readDurableLedger(...)) folds ONLY the primary target and would answer 0 here.
    expect(store.getAggregateVersion(FUNDING)).toBe(1);
    expect(store.getAggregateVersion(FENCE)).toBe(1);
    expect(store.getAggregateVersion(PREPARATION)).toBe(1);
  });

  it("refuses a second prepare while a generation is current, with zero residue", () => {
    const store = preparedStore();
    const before = counts(store);
    const decisionsBefore = decisionCount(store);
    const second = commitPreparation(prepareContext(store, "cmd-prepare-2"));
    expect(second).toMatchObject({
      code: "SUPERSESSION_PREPARATION_GENERATION_CURRENT",
      layer: "SUPERSESSION_PREPARATION",
      ok: false,
      refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
    });
    expect(counts(store)).toEqual(before);
    expect(decisionCount(store)).toBe(decisionsBefore);
  });

  it("INTERLEAVING: two prepares built from the same captured state, exactly one wins", () => {
    const store = activatedStore();
    const first = prepareContext(store, "cmd-prepare-a");
    const second = prepareContext(store, "cmd-prepare-b");
    const winner = commitPreparation(first);
    const loser = commitPreparation(second);

    expect(winner.ok).toBe(true);
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("expected the second prepare to lose");
    expect(loser.code).toBe("SUPERSESSION_PREPARATION_GENERATION_CURRENT");
    expect(loser.layer).toBe("SUPERSESSION_PREPARATION");
    expect(loser.refusedBy).toBe("SUPERSESSION_PREPARATION_SERVICE");
    // No second hold and no second fence survived the loss.
    expect(counts(store)).toEqual([1, 1, 1]);
  });

  it("fences the SECOND generation at the moved version, not at zero", () => {
    const store = preparedStore();
    accept(releasePreparation(releaseContext(store, "cmd-release-1", 1, 1)));
    // Every one of the three aggregates advanced; a writer still fencing at 0 would lose here.
    expect(counts(store)).toEqual([2, 2, 2]);
    const second = accept(commitPreparation(prepareContext(store, "cmd-prepare-2")));
    expect(second.generation.binding.generation).toBe(2);
    expect(counts(store)).toEqual([3, 3, 3]);
    expect(store.getAggregateVersion(FUNDING)).toBe(3);
    expect(store.getAggregateVersion(FENCE)).toBe(3);
  });

  it("REPLAY: identical bytes return the original with no new event or decision", () => {
    const store = preparedStore();
    const before = counts(store);
    const decisionsBefore = decisionCount(store);
    const replayed = accept(commitPreparation(prepareContext(store, "cmd-prepare-1")));
    expect(replayed.disposition).toBe("REPLAYED");
    expect(counts(store)).toEqual(before);
    expect(decisionCount(store)).toBe(decisionsBefore);
  });

  it("refuses the same identity carrying different bytes", () => {
    const store = preparedStore();
    const before = counts(store);
    const drifted = commitPreparation(prepareContext(
      store, "cmd-prepare-1", prepareRequest({ correlationId: "corr-other" }),
    ));
    expect(drifted).toMatchObject({
      code: "SUPERSESSION_PREPARATION_BYTES_CONFLICT",
      layer: "SUPERSESSION_PREPARATION",
      ok: false,
      sourceCode: "BOOTSTRAP_COMMAND_BYTES_CONFLICT",
      sourceLayer: "DAEMON_PREREQUISITE",
    });
    expect(counts(store)).toEqual(before);
  });
});

describe("releasePreparation moves both members or neither (task-32c1ba45)", () => {
  it("ACCEPTED CONTROL: one decision releases the fence and refunds the hold", () => {
    const store = preparedStore();
    const decisionsBefore = decisionCount(store);
    const released = accept(releasePreparation(releaseContext(store, "cmd-release-1", 1, 1)));

    expect(counts(store)).toEqual([2, 2, 2]);
    expect(decisionCount(store)).toBe(decisionsBefore + 1);
    expect(released.generation.funding.lifecycle).toBe("RELEASED");
    expect(released.generation.fence.lifecycle).toBe("RELEASED");
    expect(released.generation.funding.refunded).toBe(released.generation.funding.quantity);
    // THE DEFAULT PORT IS THE PRODUCTION READER: this arm passed no port at all, so the
    // activation evidence above came from `readCurrentActiveGraph` and not from a fake.
    expect(RELEASE_ACTIVATION_EVIDENCE).toBe(readCurrentActiveGraph);
    const history = foldPreparationHistory(store, PREPARATION);
    if (!history.ok) throw new Error("expected a readable history");
    expect(history.current).toBeNull();
    expect(history.nextGeneration).toBe(2);
  });

  it("REPLAY: an exact release replay adds no event and no decision", () => {
    const store = preparedStore();
    accept(releasePreparation(releaseContext(store, "cmd-release-1", 1, 1)));
    const before = counts(store);
    const decisionsBefore = decisionCount(store);
    const replayed = accept(releasePreparation(releaseContext(store, "cmd-release-1", 1, 1)));
    expect(replayed.disposition).toBe("REPLAYED");
    expect(counts(store)).toEqual(before);
    expect(decisionCount(store)).toBe(decisionsBefore);
  });

  it.each([
    ["a near-match generation", 2, 1],
    ["a near-match version fence", 1, 2],
  ])("refuses %s without moving either member", (_label, generation, version) => {
    const store = preparedStore();
    const before = counts(store);
    const refused = releasePreparation(
      releaseContext(store, "cmd-release-near", generation, version),
    );
    expect(refused).toMatchObject({
      code: "SUPERSESSION_RELEASE_GENERATION_STALE",
      layer: "SUPERSESSION_PREPARATION",
      ok: false,
      refusedBy: "SUPERSESSION_PREPARATION_LEDGER",
    });
    expect(counts(store)).toEqual(before);
  });

  it("refuses a release when no generation is current", () => {
    const store = activatedStore();
    expect(releasePreparation(releaseContext(store, "cmd-release-1", 1, 0))).toMatchObject({
      code: "SUPERSESSION_RELEASE_GENERATION_ABSENT",
      layer: "SUPERSESSION_PREPARATION",
      refusedBy: "SUPERSESSION_PREPARATION_LEDGER",
    });
  });

  it("refuses a release once a later graph epoch is committed", () => {
    const store = preparedStore();
    const before = counts(store);
    const refused = releasePreparation(
      releaseContext(store, "cmd-release-1", 1, 1),
      (inner, projectId) => {
        const read = readCurrentActiveGraph(inner, projectId);
        return read.ok ? { ...read, graphEpoch: read.graphEpoch + 1 } : read;
      },
    );
    expect(refused).toMatchObject({
      code: "SUPERSESSION_RELEASE_ACTIVATION_COMMITTED",
      layer: "SUPERSESSION_PREPARATION",
      refusedBy: "SUPERSESSION_PREPARATION_LEDGER",
    });
    expect(counts(store)).toEqual(before);
  });

  it("refuses a release whose activation evidence is unreadable", () => {
    const store = activatedStore();
    accept(commitPreparation(prepareContext(store, "cmd-prepare-1")));
    const refused = releasePreparation(
      releaseContext(store, "cmd-release-1", 1, 1),
      () => ({
        code: "ACTIVE_GRAPH_ABSENT", layer: "ACTIVE_GRAPH_PROJECTION", ok: false,
        sourceCode: null, sourceLayer: null,
      }),
    );
    expect(refused).toMatchObject({
      code: "SUPERSESSION_RELEASE_ACTIVATION_UNVERIFIABLE",
      layer: "SUPERSESSION_PREPARATION",
      refusedBy: "SUPERSESSION_PREPARATION_LEDGER",
    });
  });

  it("refuses a release naming a foreign goal", () => {
    const store = preparedStore();
    const refused = releasePreparation(releaseContext(
      store, "cmd-release-foreign", 1, 1, { goalRef: "goal-does-not-exist" },
    ));
    expect(refused).toMatchObject({
      code: "SUPERSESSION_RELEASE_GENERATION_ABSENT",
      layer: "SUPERSESSION_PREPARATION",
    });
  });
});

describe("the preparation history fold fails closed (task-32c1ba45)", () => {
  it("answers a virgin aggregate with no current generation and version zero", () => {
    const store = activatedStore();
    const history = foldPreparationHistory(store, PREPARATION);
    if (!history.ok) throw new Error("expected a readable history");
    expect(history).toMatchObject({ current: null, nextGeneration: 1, version: 0 });
  });

  it("refuses rather than answering when the proposal itself refuses", () => {
    const store = activatedStore();
    const refused = proposeSupersessionPreparation(
      store, prepareRequest({ approvedTargetRevisionRef: "rev-foreign" }),
    );
    expect(refused).toMatchObject({ code: "SUPERSESSION_PREPARATION_TARGET_FOREIGN" });
  });
});

/**
 * THE HOSTILE MATRIX, as a named immutable roster with a pinned denominator.
 *
 * Each case names the EXACT code, layer and refusing service it expects, so an arm that starts
 * being answered by a different layer goes red instead of staying green on "not ok". Deleting a
 * member reddens the length assertion below, which is what stops the sweep shrinking silently.
 */
const HOSTILE_PREPARE_CASES = Object.freeze([
  {
    code: "SUPERSESSION_PREPARATION_REQUEST_INVALID",
    label: "a request smuggling a current graph fact",
    payload: () => ({ ...prepareRequest(), graphEpoch: "1" }),
    refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
    world: preparedFreeStore,
  },
  {
    code: "SUPERSESSION_PREPARATION_TARGET_FOREIGN",
    label: "a target the approved plan does not name",
    payload: () => prepareRequest({ approvedTargetRevisionRef: "rev-foreign" }),
    refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
    world: preparedFreeStore,
  },
  {
    code: "SUPERSESSION_PREPARATION_PLAN_UNAVAILABLE",
    label: "a goal with no sealed approved plan",
    payload: () => prepareRequest({ goalRef: "goal-does-not-exist" }),
    refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
    world: preparedFreeStore,
  },
  {
    code: "SUPERSESSION_PREPARATION_GRAPH_UNAVAILABLE",
    label: "a project with no ACTIVE graph",
    payload: () => prepareRequest(),
    refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
    world: approvableStore,
  },
  {
    code: "SUPERSESSION_PREPARATION_GENERATION_CURRENT",
    label: "a second prepare over a live generation",
    payload: () => prepareRequest(),
    refusedBy: "SUPERSESSION_PREPARATION_SERVICE",
    world: preparedStore,
  },
] as const);

const HOSTILE_RELEASE_CASES = Object.freeze([
  {
    code: "SUPERSESSION_RELEASE_REQUEST_INVALID", generation: 1,
    label: "a release carrying an extra field", overrides: { fenceLifecycle: "RELEASED" },
    version: 1,
  },
  {
    code: "SUPERSESSION_RELEASE_GENERATION_STALE", generation: 2,
    label: "a near-match generation", overrides: {}, version: 1,
  },
  {
    code: "SUPERSESSION_RELEASE_GENERATION_STALE", generation: 1,
    label: "a near-match version fence", overrides: {}, version: 2,
  },
  {
    code: "SUPERSESSION_RELEASE_GENERATION_ABSENT", generation: 1,
    label: "a foreign goal", overrides: { goalRef: "goal-does-not-exist" }, version: 1,
  },
] as const);

describe("hostile prepare and release matrices (task-32c1ba45)", () => {
  it("pins both matrix denominators so a deleted case cannot pass silently", () => {
    expect(HOSTILE_PREPARE_CASES).toHaveLength(5);
    expect(HOSTILE_RELEASE_CASES).toHaveLength(4);
    expect(new Set(HOSTILE_PREPARE_CASES.map((entry) => entry.label)).size).toBe(5);
    expect(new Set(HOSTILE_RELEASE_CASES.map((entry) => entry.label)).size).toBe(4);
  });

  it.each(HOSTILE_PREPARE_CASES)(
    "refuses $label with an exact code and zero residue", (entry) => {
      const store = entry.world();
      const before = counts(store);
      const decisionsBefore = decisionCount(store);
      const refused = commitPreparation(prepareContext(store, "cmd-hostile", entry.payload()));
      expect(refused).toMatchObject({
        code: entry.code, layer: "SUPERSESSION_PREPARATION", ok: false, refusedBy: entry.refusedBy,
      });
      expect(counts(store)).toEqual(before);
      expect(decisionCount(store)).toBe(decisionsBefore);
    },
  );

  it.each(HOSTILE_RELEASE_CASES)(
    "refuses $label without moving either member", (entry) => {
      const store = preparedStore();
      const before = counts(store);
      const decisionsBefore = decisionCount(store);
      const refused = releasePreparation(releaseContext(
        store, "cmd-hostile-release", entry.generation, entry.version, entry.overrides,
      ));
      expect(refused).toMatchObject({
        code: entry.code, layer: "SUPERSESSION_PREPARATION", ok: false,
        refusedBy: "SUPERSESSION_PREPARATION_LEDGER",
      });
      expect(counts(store)).toEqual(before);
      expect(decisionCount(store)).toBe(decisionsBefore);
    },
  );

  it("REPEATED CONFLICT: a losing release stays losing and never half-moves the pair", () => {
    const store = preparedStore();
    const before = counts(store);
    for (const attempt of ["cmd-conflict-1", "cmd-conflict-2", "cmd-conflict-3"]) {
      const refused = releasePreparation(releaseContext(store, attempt, 1, 99));
      expect(refused).toMatchObject({ code: "SUPERSESSION_RELEASE_GENERATION_STALE", ok: false });
    }
    expect(counts(store)).toEqual(before);
  });
});

describe("the history fold refuses an unreadable aggregate (task-32c1ba45)", () => {
  it("refuses a foreign aggregate's events with its own code and layer", () => {
    const store = preparedStore();
    // A REAL committed aggregate that is not a preparation: its events carry no generation.
    const refused = foldPreparationHistory(store, GOAL_ID);
    expect(refused).toEqual({
      code: "PREPARATION_HISTORY_MALFORMED",
      layer: "SUPERSESSION_PREPARATION_HISTORY",
      ok: false,
    });
  });
});

describe("a stale transport context cannot false-refuse a correctly fenced prepare (task-32c1ba45)", () => {
  it("commits generation 2 from a context whose ledger snapshot predates generation 1", () => {
    const store = activatedStore();
    // Built FIRST, so its ledger snapshot sees version 0 on every aggregate below.
    const staleContext = prepareContext(store, "cmd-prepare-stale");
    accept(commitPreparation(prepareContext(store, "cmd-prepare-1")));
    accept(releasePreparation(releaseContext(store, "cmd-release-1", 1, 1)));
    expect(store.getAggregateVersion(PREPARATION)).toBe(2);

    // The proposal fences against the version it just read (2), not against the stale snapshot.
    const second = accept(commitPreparation(staleContext));
    expect(second.generation.binding.generation).toBe(2);
    expect(counts(store)).toEqual([3, 3, 3]);
  });
});

describe("the transport envelope owns the project, not the payload (task-32c1ba45)", () => {
  it("refuses a prepare whose payload names a foreign project, before any read", () => {
    const store = preparedFreeStore();
    const before = counts(store);
    const refused = commitPreparation(prepareContext(
      store, "cmd-prepare-foreign", prepareRequest({ projectId: "project-somewhere-else" }),
    ));
    expect(refused).toMatchObject({
      code: "SUPERSESSION_PREPARATION_TARGET_FOREIGN",
      layer: "SUPERSESSION_PREPARATION",
      ok: false,
      refusedBy: "SUPERSESSION_PREPARATION_LEDGER",
    });
    expect(counts(store)).toEqual(before);
  });

  it("refuses a release whose payload names a foreign project, moving neither member", () => {
    const store = preparedStore();
    const before = counts(store);
    const refused = releasePreparation(releaseContext(
      store, "cmd-release-foreign-project", 1, 1, { projectId: "project-somewhere-else" },
    ));
    expect(refused).toMatchObject({
      code: "SUPERSESSION_RELEASE_TARGET_FOREIGN",
      layer: "SUPERSESSION_PREPARATION",
      ok: false,
      refusedBy: "SUPERSESSION_PREPARATION_LEDGER",
    });
    expect(counts(store)).toEqual(before);
  });
});

/**
 * DoD 1: disposition coverage is a DURABLE, VERIFIED field of the generation record (task-7eddd612).
 *
 * Coverage was already folded into `factHorizonDigest` and written as a top-level `coverage` key on
 * the PREPARED event, but `foldPreparationHistory` reads only `record` and `horizonGraphEpoch` — so
 * nothing downstream could read it back, and `graph.supersede` could not gate on it. Making it a
 * field of the record is only half the fix: without a clause in `isGenerationRecord` a forged or
 * legacy record carrying no coverage (or a value outside the closed vocabulary) still folds as
 * current, which is the hole these arms pin.
 *
 * FORGED, NOT PRODUCED — deliberately. A production writer cannot emit a record with a missing or
 * invented coverage; that is what makes such a record evidence of tampering or of a schema the
 * fold must refuse. The event goes in through the store's own commit API at the correct expected
 * version, never by editing SQLite, so the FOLD is what answers.
 */
const forgeEncoder = new TextEncoder();

interface ForgeableGeneration {
  binding: Record<string, unknown>;
  dispositionCoverage?: unknown;
  fence: Record<string, unknown>;
  funding: Record<string, unknown>;
}

function preparedPayload(store: SqliteEventStore): Record<string, unknown> {
  const [event] = store.readEvents(PREPARATION);
  if (event === undefined) throw new Error("no PREPARED event to copy");
  return JSON.parse(new TextDecoder().decode(event.payload)) as Record<string, unknown>;
}

/** Generation 1's record, re-stamped as generation 2, with coverage set or removed. */
function forgedSecondRecord(
  payload: Record<string, unknown>, coverage: string | undefined,
): ForgeableGeneration {
  const record = JSON.parse(JSON.stringify(payload["record"])) as ForgeableGeneration;
  record.binding["generation"] = 2;
  record.fence["generation"] = 2;
  record.funding["generation"] = 2;
  if (coverage === undefined) delete record.dispositionCoverage;
  else record.dispositionCoverage = coverage;
  return record;
}

function commitForgedSecondPrepared(
  store: SqliteEventStore, commandId: string, coverage: string | undefined,
): void {
  const payload = preparedPayload(store);
  store.commit({
    aggregateId: PREPARATION,
    commandBytes: forgeEncoder.encode(commandId),
    commandId,
    committedAt: "2026-08-26T00:30:00.000Z",
    events: [{
      eventId: `${commandId}-prepared`,
      eventType: PREPARATION_EVENT_TYPES.PREPARED,
      payload: forgeEncoder.encode(JSON.stringify({
        ...payload, generation: 2, record: forgedSecondRecord(payload, coverage),
      })),
    }],
    expectedVersion: store.getAggregateVersion(PREPARATION),
  });
}

/** Generation 1 released first, so a SECOND PREPARED at generation 2 is otherwise well ordered. */
function releasedStore(): SqliteEventStore {
  const store = preparedStore();
  accept(releasePreparation(releaseContext(store, "cmd-release-1", 1, 1)));
  return store;
}

describe("the fold refuses a generation record without readable coverage (task-7eddd612)", () => {
  it.each([
    ["MISSING: no dispositionCoverage at all — the legacy shape", undefined],
    ["OUTSIDE THE VOCABULARY: a plausible-looking FULL", "FULL"],
  ])("refuses a second PREPARED whose record has %s", (_label, coverage) => {
    const store = releasedStore();
    commitForgedSecondPrepared(store, `cmd-forged-${coverage ?? "missing"}`, coverage);

    expect(foldPreparationHistory(store, PREPARATION)).toEqual({
      code: "PREPARATION_HISTORY_OUT_OF_ORDER",
      layer: "SUPERSESSION_PREPARATION_HISTORY",
      ok: false,
    });
  });

  it("READ-BACK: the PRODUCTION writer's own record exposes its coverage through the fold", () => {
    const store = preparedStore();
    const history = foldPreparationHistory(store, PREPARATION);
    if (!history.ok || history.current === null) throw new Error("expected a current generation");
    // Nothing forged: this is `commitPreparation`'s own record, read back through the same fold
    // `graph.supersede` uses. PARTIAL is the delivered tree's answer (see the row's step-1 comment);
    // the day a producer can reach COMPLETE, this pin moves instead of the change going silent.
    expect(history.current.dispositionCoverage).toBe("PARTIAL");
  });

  it("CONTROL: the same forged event with COMPLETE or PARTIAL coverage folds as current", () => {
    for (const coverage of ["COMPLETE", "PARTIAL"]) {
      const store = releasedStore();
      commitForgedSecondPrepared(store, `cmd-forged-${coverage}`, coverage);

      const history = foldPreparationHistory(store, PREPARATION);
      // Without this control the arms above would still pass if the fold refused EVERY second
      // PREPARED for an unrelated reason — ordering, say — and coverage were never read at all.
      expect(history.ok, coverage).toBe(true);
      if (!history.ok) throw new Error(`expected a readable history for ${coverage}`);
      expect(history.current?.binding.generation).toBe(2);
    }
  });
});
