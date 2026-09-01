/**
 * task-671cdd10 — the durable released-attempt selector, graded over ONE production-writer
 * world and a NAMED, IMMUTABLE roster of 33 hostile cases.
 *
 * EVERY ARM CARRIES ITS OWN POSITIVE CONTROL. Before an arm applies its mutation it runs the
 * clean selection on the released world and requires `ok:true`. An arm that only proved
 * "refused" would stay green if the selector started refusing everything, and a roster of 33
 * such arms would be 33 assertions of nothing.
 *
 * EVERY ARM PINS A CODE **AND** A LAYER, and where an upstream authority decided, its verbatim
 * `sourceCode`/`sourceLayer` too. Six different surfaces can refuse here — the request guard,
 * the store, the parent authority, the planning-authority reader, the locator, the activation
 * ledger and task-e62e3828's release reader — so "it said no" never identifies the repair.
 *
 * THE ROSTER'S CODE SET IS PINNED SET-EQUAL to the production roster: an arm for a code that
 * does not exist, or a production code no arm reaches, both fail here rather than silently.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import {
  EXPANSION_RELEASE_SELECTOR_CODES, EXPANSION_RELEASE_SELECTOR_LAYER_ROSTER,
  EXPANSION_RELEASE_SELECTOR_QUERY_KEYS,
  createExpansionReleaseAuthorityReader as rootFactory,
  readExpansionReleaseSelection as rootReader,
} from "../index.js";
import type { ExpansionReleaseSelectorCode } from "../index.js";
import * as daemonRoot from "../index.js";
import {
  createExpansionReleaseAuthorityReader, readExpansionReleaseSelection,
} from "./expansion-release-selector.js";
import type { ExpansionReleaseAuthorityReader } from "./expansion-request-service.js";
import {
  PROJECT_ID, SELECTOR_ATTEMPT_ID, SELECTOR_GOAL_ID, SELECTOR_NODE_KEY, SELECTOR_RUN_ID,
  cleanupSelectorWorlds, extraPlanningRunStore, foreignProjectStore,
  injectedStateStore, movingGraphStore, movingHorizonStore, openSelectorStore, pagerFaultStore,
  selectorQuery, selectorWorld, truncatedPagerStore, unhealthyStore, witnesslessStore,
} from "./expansion-release-selector-test-fixtures.js";
import type { SelectorManifestPatch, SelectorWorld }
  from "./expansion-release-selector-test-fixtures.js";

const LAYER = "DAEMON_EXPANSION_RELEASE_SELECTOR";
const CURRENT_AUTHORITY = "CURRENT_AUTHORITY";
const READER_LAYER = "PLANNING_AUTHORITY_READER";
const GRAPH_LAYER = "ACTIVE_GRAPH_PROJECTION";
const ACTIVATION_LAYER = "FOUNDATION_ACTIVATION_BINDING";
/** e62 carries its OWN source verbatim rather than restamping it, so a release refusal that
 *  originated in the attempt-release record arrives naming that reader — which is the layer
 *  a repair would actually have to visit. */
const RELEASE_LAYER = "DAEMON_ATTEMPT_RELEASE";

/** A patched twin ALWAYS renames its attempt: the aggregate is keyed by
 *  (project, session, attempt), so a same-slot second seal would be an expected-version
 *  conflict at seed time rather than the durable corruption an arm is about. */
const twin = (
  attemptRef: string, itemFields: Record<string, Record<string, unknown>> = {},
): SelectorManifestPatch => ({
  attemptRef,
  itemFields: {
    ...itemFields,
    "foundation.activation": { attemptRef, ...itemFields["foundation.activation"] },
  },
});

const WORLD_SPECS = Object.freeze({
  activationAbsent: { release: false, seal: false, variants: [twin("attempt-unbound")] },
  activationSession: {
    release: false, seal: false,
    variants: [{
      itemFields: { "foundation.activation": { ownerSessionRef: "session-2" } },
      sessionId: "session-2",
    }],
  },
  activationSplice: { release: false, variants: [{ attemptRef: "attempt-activation-splice" }] },
  ambiguous: { release: false, variants: [twin("attempt-twin")] },
  graphSplice: {
    release: false,
    variants: [twin("attempt-graph-splice", { "foundation.graph": { goalRef: "goal-elsewhere" } })],
  },
  main: {},
  malformed: {
    release: false,
    variants: [{ attemptRef: "attempt-malformed", unparsableBytes: true }],
  },
  noRelease: { release: false },
  noSeal: { release: false, seal: false },
  objectiveSplice: {
    release: false,
    variants: [twin("attempt-objective-splice", {
      "foundation.objective": { nodeKey: "node-elsewhere" },
    })],
  },
  planDuplicate: {
    release: false,
    variants: [{ attemptRef: "attempt-plan-duplicate", duplicateItem: "foundation.approved-plan" }],
  },
  planMissing: {
    release: false,
    variants: [{ attemptRef: "attempt-plan-missing", dropItem: "foundation.approved-plan" }],
  },
  planSplice: {
    release: false,
    variants: [twin("attempt-plan-splice", {
      "foundation.approved-plan": { runId: "run-elsewhere" },
    })],
  },
} as const);

type WorldKey = keyof typeof WORLD_SPECS;

const worlds = new Map<WorldKey, SelectorWorld>();
const worldOf = (key: WorldKey): SelectorWorld => {
  const world = worlds.get(key);
  if (world === undefined) throw new Error(`world ${key} was never built`);
  return world;
};

/** What an arm does to the clean world before the selector runs. Exactly one of the two
 *  is ever non-identity, so an arm names ONE mutation. */
interface Attack {
  readonly query?: (clean: Record<string, unknown>) => unknown;
  readonly store?: (store: SqliteEventStore) => SqliteEventStore;
}

interface HostileCase extends Attack {
  readonly code: ExpansionReleaseSelectorCode;
  readonly name: string;
  readonly sourceCode: string | null;
  readonly sourceLayer: string | null;
  readonly world: WorldKey;
}

const shorn = (drop: string) => (clean: Record<string, unknown>): unknown => {
  const { [drop]: _removed, ...rest } = clean;
  return rest;
};
const smuggled = (key: string, value: unknown) =>
  (clean: Record<string, unknown>): unknown => ({ ...clean, [key]: value });
const swapped = (key: string, value: string) =>
  (clean: Record<string, unknown>): unknown => ({ ...clean, [key]: value });

const invalid = (
  name: string, query: (clean: Record<string, unknown>) => unknown,
): HostileCase => ({
  code: "EXPANSION_RELEASE_SELECTOR_REQUEST_INVALID", name, query,
  sourceCode: null, sourceLayer: null, world: "main",
});
const parentless = (name: string, sourceCode: string, attack: Attack): HostileCase => ({
  ...attack, code: "EXPANSION_RELEASE_SELECTOR_PARENT_AUTHORITY_UNAVAILABLE", name,
  sourceCode, sourceLayer: CURRENT_AUTHORITY, world: "main",
});
const unreadable = (name: string, world: WorldKey, sourceCode: string | null): HostileCase => ({
  code: "EXPANSION_RELEASE_SELECTOR_LOCATOR_EVIDENCE_UNREADABLE", name, sourceCode,
  sourceLayer: null, world,
});
const spliced = (name: string, world: WorldKey): HostileCase => ({
  code: "EXPANSION_RELEASE_SELECTOR_LOCATOR_BINDING_MISMATCH", name,
  sourceCode: null, sourceLayer: null, world,
});

/** THIRTY-THREE, named, frozen, and asserted to be exactly that many below. */
export const EXPANSION_RELEASE_SELECTOR_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  invalid("query is not an object", () => "not-an-object"),
  invalid("project is missing", shorn("projectId")),
  invalid("goal is missing", shorn("goalRef")),
  invalid("parent run is missing", shorn("parentRunRef")),
  invalid("parent node is missing", shorn("parentNodeRef")),
  invalid("attemptRef is smuggled in", smuggled("attemptRef", SELECTOR_ATTEMPT_ID)),
  invalid("release is smuggled in", smuggled("release", { released: true })),
  invalid("decisionTrace is smuggled in", smuggled("decisionTrace", { commandId: "cmd" })),
  {
    code: "EXPANSION_RELEASE_SELECTOR_STORE_UNAVAILABLE", name: "store health throws",
    sourceCode: null, sourceLayer: null, store: unhealthyStore, world: "main",
  },
  {
    code: "EXPANSION_RELEASE_SELECTOR_STORE_PROJECT_MISMATCH",
    name: "store answers for another project",
    sourceCode: null, sourceLayer: null, store: foreignProjectStore, world: "main",
  },
  parentless("goal is absent", "EXPANSION_REQUEST_GOAL_ABSENT",
    { query: swapped("goalRef", "goal-absent") }),
  parentless("goal belongs to another project", "EXPANSION_REQUEST_GOAL_FOREIGN", {
    query: swapped("goalRef", "goal-foreign"),
    store: (store): SqliteEventStore => injectedStateStore(store, "goal-foreign", {
      generation: 1, goalId: "goal-foreign", graphEpoch: 0,
      lifecycle: "EXECUTION_ENABLED", projectId: "project-elsewhere", version: 1,
    }),
  }),
  parentless("parent run is absent", "EXPANSION_REQUEST_PARENT_RUN_ABSENT",
    { query: swapped("parentRunRef", "run-absent") }),
  parentless("parent run belongs to another goal", "EXPANSION_REQUEST_PARENT_RUN_FOREIGN", {
    query: swapped("parentRunRef", "run-foreign"),
    store: (store): SqliteEventStore => injectedStateStore(store, "run-foreign", {
      state: { goalRef: "goal-elsewhere", lifecycle: "APPROVED", runId: "run-foreign" },
    }),
  }),
  parentless("parent node is absent from the active graph", "EXPANSION_REQUEST_PARENT_NODE_ABSENT",
    { query: swapped("parentNodeRef", "node-absent") }),
  {
    code: "EXPANSION_RELEASE_SELECTOR_APPROVED_RUN_UNAVAILABLE",
    name: "the GoalExecutionEnabled witness is gone",
    sourceCode: "PLANNING_AUTHORITY_READER_APPROVAL_ABSENT", sourceLayer: READER_LAYER,
    store: (store): SqliteEventStore => witnesslessStore(store, SELECTOR_GOAL_ID), world: "main",
  },
  {
    code: "EXPANSION_RELEASE_SELECTOR_PARENT_RUN_MISMATCH",
    name: "a second durable run the approved plan does not name",
    query: swapped("parentRunRef", "run-second"), sourceCode: null, sourceLayer: null,
    store: (store): SqliteEventStore =>
      extraPlanningRunStore(store, "run-second", SELECTOR_GOAL_ID),
    world: "main",
  },
  {
    code: "EXPANSION_RELEASE_SELECTOR_GRAPH_BINDING_MISMATCH",
    name: "the active graph moves out from under the composition",
    sourceCode: "ACTIVE_GRAPH_ABSENT", sourceLayer: GRAPH_LAYER,
    store: movingGraphStore, world: "main",
  },
  {
    code: "EXPANSION_RELEASE_SELECTOR_LOCATOR_EVIDENCE_UNREADABLE",
    name: "the typed pager throws", sourceCode: null, sourceLayer: null,
    store: pagerFaultStore, world: "main",
  },
  {
    code: "EXPANSION_RELEASE_SELECTOR_LOCATOR_SCAN_INCOMPLETE",
    name: "the typed pager truncates the walk", sourceCode: null, sourceLayer: null,
    store: truncatedPagerStore, world: "main",
  },
  unreadable("the sealed bytes are not canonical items", "malformed", "CANONICAL_ITEMS_UNUSABLE"),
  unreadable("the approved-plan item is missing", "planMissing", "CANONICAL_ITEMS_UNUSABLE"),
  unreadable("the approved-plan item is duplicated", "planDuplicate", "CANONICAL_ITEMS_UNUSABLE"),
  spliced("the graph item names another goal", "graphSplice"),
  spliced("the approved-plan item names another run", "planSplice"),
  spliced("the objective item names another node", "objectiveSplice"),
  spliced("the activation item names another attempt", "activationSplice"),
  {
    code: "EXPANSION_RELEASE_SELECTOR_ATTEMPT_ABSENT", name: "no context manifest was ever sealed",
    sourceCode: null, sourceLayer: null, world: "noSeal",
  },
  {
    code: "EXPANSION_RELEASE_SELECTOR_ATTEMPT_AMBIGUOUS",
    name: "two sealed launches under one parent",
    sourceCode: null, sourceLayer: null, world: "ambiguous",
  },
  {
    code: "EXPANSION_RELEASE_SELECTOR_ACTIVATION_UNAVAILABLE",
    name: "the located attempt has no durable activation",
    sourceCode: "FOUNDATION_BINDING_NOT_FOUND", sourceLayer: ACTIVATION_LAYER,
    world: "activationAbsent",
  },
  {
    code: "EXPANSION_RELEASE_SELECTOR_ACTIVATION_MISMATCH",
    name: "the activation belongs to another session",
    sourceCode: null, sourceLayer: null, world: "activationSession",
  },
  {
    code: "EXPANSION_RELEASE_SELECTOR_RELEASE_UNAVAILABLE",
    name: "task-e62e3828's reader refuses the candidate",
    sourceCode: "ATTEMPT_RELEASE_RECORD_ABSENT", sourceLayer: RELEASE_LAYER,
    world: "noRelease",
  },
  {
    code: "EXPANSION_RELEASE_SELECTOR_CURRENTNESS_MOVED",
    name: "the ledger grows under the composition",
    sourceCode: null, sourceLayer: null, store: movingHorizonStore, world: "main",
  },
]);

/** Opens the world's store, runs `body`, and closes it even when an assertion throws: a
 *  handle held across the temp-directory removal throws EPERM on Windows and kills the
 *  worker with no output at all. */
function withWorld<T>(key: WorldKey, body: (store: SqliteEventStore) => T): T {
  const store = openSelectorStore(worldOf(key).storePath);
  try { return body(store); } finally { store.close(); }
}

/** The one reachable success, re-proved for every arm. */
function cleanSelection(): ReturnType<typeof readExpansionReleaseSelection> {
  return withWorld("main", (store) => readExpansionReleaseSelection(store, selectorQuery()));
}

/** `"BOUND"` or the refusal spelled out. Asserting the STRING rather than the boolean is what
 *  makes a positive control that stopped being reachable say WHY in its own failure. */
const reasonOf = (outcome: ReturnType<typeof readExpansionReleaseSelection>): string =>
  outcome.ok ? "BOUND" : `${outcome.code}<-${String(outcome.sourceCode)}`;

beforeAll(async () => {
  for (const key of Object.keys(WORLD_SPECS) as WorldKey[]) {
    worlds.set(key, await selectorWorld(key, WORLD_SPECS[key]));
  }
}, 300_000);

afterAll(() => { cleanupSelectorWorlds(); });

describe("task-671cdd10 expansion release selector — roster", () => {
  it("is exactly the 33 named cases, frozen", () => {
    expect(EXPANSION_RELEASE_SELECTOR_HOSTILE_CASES.length).toBe(33);
    expect(EXPANSION_RELEASE_SELECTOR_HOSTILE_CASES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(EXPANSION_RELEASE_SELECTOR_HOSTILE_CASES)).toBe(true);
    expect(new Set(EXPANSION_RELEASE_SELECTOR_HOSTILE_CASES.map((entry) => entry.name)).size)
      .toBe(33);
  });

  it("reaches every production refusal code and no other", () => {
    expect([...new Set(EXPANSION_RELEASE_SELECTOR_HOSTILE_CASES.map((entry) => entry.code))].sort())
      .toStrictEqual([...EXPANSION_RELEASE_SELECTOR_CODES].sort());
  });

  it("pins the query arity the selector admits", () => {
    expect([...EXPANSION_RELEASE_SELECTOR_QUERY_KEYS])
      .toStrictEqual(["goalRef", "parentNodeRef", "parentRunRef", "projectId"]);
    expect([...EXPANSION_RELEASE_SELECTOR_LAYER_ROSTER]).toStrictEqual([LAYER]);
  });
});

describe("task-671cdd10 expansion release selector — success", () => {
  it("binds exactly one released attempt the caller never named", () => {
    const selected = cleanSelection();
    expect(reasonOf(selected)).toBe("BOUND");
    if (!selected.ok) return;
    expect(selected.attemptRef).toBe(SELECTOR_ATTEMPT_ID);
    expect(selected.workerHandoff).toBe(selected.release.handoff);
  });

  it("deep-freezes the answer and hands out no live reference", () => {
    const first = cleanSelection();
    const second = cleanSelection();
    expect([reasonOf(first), reasonOf(second)]).toStrictEqual(["BOUND", "BOUND"]);
    if (!first.ok || !second.ok) return;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.release)).toBe(true);
    expect(Object.isFrozen(first.workerHandoff)).toBe(true);
    expect(() => {
      (first as { attemptRef: string }).attemptRef = "attempt-forged";
    }).toThrow(TypeError);
    expect(first).not.toBe(second);
    expect(first).toStrictEqual(second);
  });

  it("replays identically across close and reopen", () => {
    const before = cleanSelection();
    const after = cleanSelection();
    expect(before).toStrictEqual(after);
    expect(reasonOf(before)).toBe("BOUND");
  });
});

describe("task-671cdd10 expansion release selector — hostile roster", () => {
  let positiveControls = 0;

  for (const entry of EXPANSION_RELEASE_SELECTOR_HOSTILE_CASES) {
    it(`refuses ${entry.code} — ${entry.name}`, () => {
      const control = cleanSelection();
      expect(reasonOf(control)).toBe("BOUND");
      positiveControls += 1;

      const outcome = withWorld(entry.world, (opened) => {
        const store = entry.store === undefined ? opened : entry.store(opened);
        const query = entry.query === undefined ? selectorQuery() : entry.query(selectorQuery());
        return readExpansionReleaseSelection(store, query);
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe(entry.code);
      expect(outcome.layer).toBe(LAYER);
      expect(outcome.sourceCode).toBe(entry.sourceCode);
      expect(outcome.sourceLayer).toBe(entry.sourceLayer);
      expect(Object.isFrozen(outcome)).toBe(true);
    });
  }

  it("ran one reachable positive control for every case", () => {
    expect(positiveControls).toBe(33);
  });
});

describe("task-671cdd10 expansion release selector — production root", () => {
  it("publishes the production implementations, not a copy", () => {
    expect(rootReader).toBe(readExpansionReleaseSelection);
    expect(rootFactory).toBe(createExpansionReleaseAuthorityReader);
  });

  it("binds a store-only reader the consumer port already expects", () => {
    withWorld("main", (store) => {
      const reader: ExpansionReleaseAuthorityReader = rootFactory(store);
      const answer = reader({
        goalRef: SELECTOR_GOAL_ID, parentNodeRef: SELECTOR_NODE_KEY,
        parentRunRef: SELECTOR_RUN_ID, projectId: PROJECT_ID,
      });
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.workerHandoff).toBe(answer.release.handoff);
    });
  });

  it("carries the selector's own code and layer through the bound port", () => {
    withWorld("noSeal", (store) => {
      const answer = rootFactory(store)({
        goalRef: SELECTOR_GOAL_ID, parentNodeRef: SELECTOR_NODE_KEY,
        parentRunRef: SELECTOR_RUN_ID, projectId: PROJECT_ID,
      });
      expect(answer.ok).toBe(false);
      if (answer.ok) return;
      expect(answer.code).toBe("EXPANSION_RELEASE_SELECTOR_ATTEMPT_ABSENT");
      expect(answer.layer).toBe(LAYER);
    });
  });

  it("exposes no locator seam at all", () => {
    // The index-surface catalogue pins the exact root namespace; this pins the SHAPE of what
    // may never join it, so a later export named after the internal scan fails here too.
    expect(Object.keys(daemonRoot).filter(
      (name) => /Locator|scanExpansion|canonicalItems|itemsAgree|namesThisParent/.test(name),
    )).toStrictEqual([]);
    expect(readExpansionReleaseSelection.length).toBe(2);
  });

  /** OUTSIDE the 33-case roster on purpose: the roster is a closed, counted set and this is an
   *  extra hardening arm for a code the roster already reaches eight ways. */
  it("refuses REQUEST_INVALID rather than THROWING on a hostile query object", () => {
    const revoked = Proxy.revocable({ ...selectorQuery() }, {});
    revoked.revoke();
    const trapping = new Proxy({}, {
      ownKeys: (): never => { throw new Error("hostile ownKeys trap"); },
    });
    for (const hostile of [revoked.proxy, trapping]) {
      const outcome = withWorld("main", (store) => readExpansionReleaseSelection(store, hostile));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("EXPANSION_RELEASE_SELECTOR_REQUEST_INVALID");
      expect(outcome.layer).toBe(LAYER);
      expect(outcome.sourceCode).toBeNull();
    }
    expect(reasonOf(cleanSelection())).toBe("BOUND");
  });
});
