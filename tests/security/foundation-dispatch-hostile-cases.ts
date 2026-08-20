/**
 * HOSTILE CASE TABLE for `FOUNDATION_DISPATCH_DERIVATION_LAYER`, on the
 * `scheduler-activation` axis (producer task-a9fd91c3, landed 69420cf; roster entry and arms
 * task-120403f7).
 *
 * WHY THIS AXIS. The roster's SUBJECT-WINS rule, and the subject here is ADMISSION: this
 * module decides, from the server's own durable world, whether a `foundation.dispatch` may
 * proceed and on whose authority — not what a codec means, and not what a provider process
 * did. Its directory neighbours in `apps/daemon/src/work/` agree: `SCHEDULER_GRAPH_LAYER` and
 * `WORK_LAYERS` are both tagged `scheduler-activation`.
 *
 * NOT a `*.security.ts` file and it holds NO assertions: the lane collects that suffix, and
 * the slice that imports this table is where every verdict is reached. This module only
 * ARRANGES durable state and calls production.
 *
 * THE PROPERTY ALL THREE ARMS ARE ABOUT. The command entry used to forward the CALLER'S
 * `graphSnapshot` and `inputManifest`, which made the caller the authority on which graph is
 * current. Both are now read server-side. So every arm below hands the derivation a hostile
 * caller's smuggled facts and asserts they buy NOTHING — and, because a refusal that travels
 * restamped would erase which authority refused, each arm pins the exact code AND the exact
 * layer, including the one arm where the answering layer is deliberately NOT this one.
 *
 * THE LAWFUL ACTIVE GRAPH IS SEEDED BY THE PLANNING-GRAPH SLICE'S OWN SEEDER. This boundary
 * reads `readCurrentActiveGraph` FIRST, so its own refusals are unreachable without a graph
 * that projection admits; re-deriving the revision history here would let the two drift and
 * would police a copy rather than the authority.
 */

import { join } from "node:path";

import { SqliteEventStore } from "../../packages/store/src/index.js";

import {
  FOUNDATION_DISPATCH_DERIVATION_LAYER, deriveFoundationDispatchFacts,
} from "../../apps/daemon/src/work/foundation-dispatch-derivation.js";
import type {
  FoundationDispatchDerivationDeps,
} from "../../apps/daemon/src/work/foundation-dispatch-derivation.js";
import { hostileRoot } from "./hostile-harness.js";
import {
  ACTIVE_GRAPH_PROJECTION_LAYER,
  PLANNING_GRAPH_PROJECT_ID,
  seedAcceptedActiveGraph,
} from "./planning-graph-hostile-cases.js";
import type { HostileCase, HostileRaceCase } from "./scheduler-activation-hostile-cases.js";

export { FOUNDATION_DISPATCH_DERIVATION_LAYER };

const openStores: SqliteEventStore[] = [];

function openDispatchStore(label: string): { path: string; store: SqliteEventStore } {
  const path = join(hostileRoot(`foundation-dispatch-${label}`), "store.sqlite");
  const store = SqliteEventStore.openForProject(path, PLANNING_GRAPH_PROJECT_ID);
  openStores.push(store);
  return { path, store };
}

/** A SECOND connection to the same durable file: one handle can serialise an interleaving
 *  away, and the race below is about two independent callers over one durable world. */
function openSecondConnection(path: string): SqliteEventStore {
  const store = SqliteEventStore.openForProject(path, PLANNING_GRAPH_PROJECT_ID);
  openStores.push(store);
  return store;
}

/** Handles first, roots after: a held SQLite handle kills the vitest worker, and in a
 *  `fileParallelism: false` lane that takes every file scheduled after it with no output. */
export function closeFoundationDispatchStores(): number {
  let closed = 0;
  for (const store of openStores.splice(0)) {
    try {
      store.close();
      closed += 1;
    } catch {
      // A double close is not a verdict; the root is removed by the harness either way.
    }
  }
  return closed;
}

/** Named so a reader can grep every place a case deliberately hands production a value its
 *  declared type forbids — here, the two facts the caller is no longer allowed to supply. */
const hostile = <T,>(value: unknown): T => value as T;

/**
 * A catalog source that must NEVER be consulted on these arms, and says so by throwing. It
 * is not a silent arrangement: production CATCHES a throwing source and answers
 * `FOUNDATION_DISPATCH_CATALOG_CONFIG_UNREADABLE`, so an arm that reached it reddens with a
 * different code instead of passing for the wrong reason.
 */
const unreachableCatalog = (): unknown => {
  throw new Error("the catalog was read before the durable authority answered");
};

/** The two facts a dispatch caller may no longer supply, shaped exactly as the entry once
 *  forwarded them. Handed in on every arm; asserted to buy nothing on all three. */
const SMUGGLED = Object.freeze({
  graphSnapshot: Object.freeze({
    completionNodeKey: "dev-c", edges: [], nodes: [{ executionBearing: true, nodeKey: "dev-a" }],
  }),
  inputManifest: Object.freeze({ baseIdentity: "f".repeat(64), entries: [] }),
});

function depsWithSmuggledFacts(
  store: SqliteEventStore,
  catalogSource: () => unknown,
): FoundationDispatchDerivationDeps {
  return hostile<FoundationDispatchDerivationDeps>({
    ...SMUGGLED, catalogSource, projectId: PLANNING_GRAPH_PROJECT_ID, store,
  });
}

/**
 * Durable events the race actually added, read back off the live store rather than inferred
 * from what either caller was told: a returned refusal is not evidence that nothing landed.
 *
 * INITIALISED TO -1, never to 0. The suite asserts this equals `maxAdmitted`, which IS 0 —
 * so an initial 0 would satisfy the durable proof even if `run` never executed or never
 * reached the readback, and the one assertion that exists to catch a silent write would be
 * unable to fail. Same sentinel, same reason, as the planning-graph slice's `forgedRowCount`.
 */
let raceHorizonDelta = -1;

export const FOUNDATION_DISPATCH_CASES: readonly HostileCase[] = Object.freeze([
  {
    constant: "FOUNDATION_DISPATCH_DERIVATION_LAYER",
    arm: "BEFORE",
    // BEFORE any authority is admitted: an empty durable world, and a caller supplying the
    // very snapshot and manifest the entry used to forward. The refusal must be the
    // PROJECTION'S — code and layer both — because a derivation that restamped it would
    // erase which authority actually refused, and the caller could not tell a missing graph
    // from a configuration fault. That the ARRANGED layer is not this constant's own layer
    // is the point of the arm, and the slice asserts arranged-equals-observed either way.
    name: "a smuggled snapshot cannot stand in for a graph the server never activated",
    arranged: ACTIVE_GRAPH_PROJECTION_LAYER,
    expected: { code: "ACTIVE_GRAPH_ABSENT", layer: ACTIVE_GRAPH_PROJECTION_LAYER },
    run: async () => {
      const { store } = openDispatchStore("before");
      return deriveFoundationDispatchFacts(depsWithSmuggledFacts(store, unreachableCatalog));
    },
  },
  {
    constant: "FOUNDATION_DISPATCH_DERIVATION_LAYER",
    arm: "AFTER",
    // AFTER a lawful activation committed: the ACTIVE graph is real and its body is recorded,
    // so the projection ADMITS and this layer's own durable read is the only thing that can
    // answer — `FOUNDATION_DISPATCH_PROJECT_STATE_ABSENT` is unreachable in production until
    // `graph.ok` holds, which is what makes this arm's code proof that the earlier authority
    // passed. An activated graph is not authority to dispatch: the project state that names
    // the repository is a separate durable fact, and a caller cannot supply it either.
    name: "an ACTIVE graph is not authority to dispatch when the project state was never bound",
    arranged: FOUNDATION_DISPATCH_DERIVATION_LAYER,
    expected: {
      code: "FOUNDATION_DISPATCH_PROJECT_STATE_ABSENT",
      layer: FOUNDATION_DISPATCH_DERIVATION_LAYER,
    },
    run: async () => {
      const { store } = openDispatchStore("after");
      seedAcceptedActiveGraph(store, "graph-revision-dispatch", "dispatch-after");
      return deriveFoundationDispatchFacts(depsWithSmuggledFacts(store, unreachableCatalog));
    },
  },
]);

export const FOUNDATION_DISPATCH_RACES: readonly HostileRaceCase[] = Object.freeze([
  {
    constant: "FOUNDATION_DISPATCH_DERIVATION_LAYER",
    // Two independent callers over ONE durable world, on two connections, and deliberately
    // NOT identical: the left one supplies a catalog that would let the derivation continue
    // if the durable state check were skipped, the right one supplies a catalog that throws
    // if it is ever read. Identical sides would test deduplication rather than isolation.
    // Both must refuse with the SAME code at the SAME layer — neither caller's configuration
    // can move the answer — and the durable readback proves neither derivation wrote.
    name: "two concurrent derivations over one unbound project both refuse and neither writes",
    arranged: FOUNDATION_DISPATCH_DERIVATION_LAYER,
    expected: {
      code: "FOUNDATION_DISPATCH_PROJECT_STATE_ABSENT",
      layer: FOUNDATION_DISPATCH_DERIVATION_LAYER,
    },
    maxAdmitted: 0,
    durableAdmissions: () => raceHorizonDelta,
    run: async () => {
      const { path, store } = openDispatchStore("race");
      seedAcceptedActiveGraph(store, "graph-revision-dispatch", "dispatch-race");
      const rival = openSecondConnection(path);
      const before = store.readEventHorizon();
      const sides = [
        deriveFoundationDispatchFacts(depsWithSmuggledFacts(store, () => ({}))),
        deriveFoundationDispatchFacts(depsWithSmuggledFacts(rival, unreachableCatalog)),
      ] as const;
      raceHorizonDelta = Number(store.readEventHorizon() - before);
      return sides;
    },
  },
]);
