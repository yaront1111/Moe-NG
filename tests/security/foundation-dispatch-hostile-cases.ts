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
  readFoundationActivationByAttempt,
} from "../../apps/daemon/src/activation/activation-attempt-reader.js";
import {
  PRINCIPAL_ID as FINALIZATION_PRINCIPAL_ID,
  PROJECT_ID as FINALIZATION_PROJECT_ID,
  cleanupRestoreHarnesses,
} from "../../apps/daemon/src/recovery/restore-test-harness.js";
import {
  FOUNDATION_DISPATCH_DERIVATION_LAYER, deriveFoundationDispatchFacts,
} from "../../apps/daemon/src/work/foundation-dispatch-derivation.js";
import type {
  FoundationDispatchDerivationDeps,
} from "../../apps/daemon/src/work/foundation-dispatch-derivation.js";
import {
  ATTEMPT_FINALIZATION_LAYER,
} from "../../apps/daemon/src/work/attempt-finalization-contracts.js";
import { finalizeVerifiedAttempt } from "../../apps/daemon/src/work/attempt-finalization-service.js";
import {
  FINAL_ACTIVATION_AGGREGATE,
  FINAL_ATTEMPT_REF,
  FINAL_NODE_KEY,
  FINAL_SESSION_ID,
  finalizationWorld,
} from "../../apps/daemon/src/work/attempt-finalization-test-harness.js";
import {
  HANDOFF_CROSS_CHECK_LAYER,
} from "../../apps/daemon/src/work/release-handoff-classify.js";
import { DAEMON_RELEASE_HANDOFF } from "../../apps/daemon/src/work/release-handoff-contracts.js";
import { readReleaseHandoffFacts } from "../../apps/daemon/src/work/release-handoff-sources.js";
import {
  corruptJournalTail,
  corruptStepTail,
} from "../../apps/daemon/src/work/release-handoff-test-harness.js";
import type { HandoffSeedIdentity } from "../../apps/daemon/src/work/release-handoff-test-harness.js";
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
function openSecondConnection(
  path: string, projectId: string = PLANNING_GRAPH_PROJECT_ID,
): SqliteEventStore {
  const store = SqliteEventStore.openForProject(path, projectId);
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
  cleanupRestoreHarnesses();
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
let finalizationRaceHorizonDelta = -1;
let handoffRaceHorizonDelta = -1;

const FINALIZATION_VERIFICATION_ID = "verification-hostile-finalization";

const finalizationWho = Object.freeze({
  commandId: "cmd-hostile-finalization",
  correlationId: "corr-hostile-finalization",
  principalId: FINALIZATION_PRINCIPAL_ID,
  projectId: FINALIZATION_PROJECT_ID,
});

function finalizationRequest(): Record<string, unknown> {
  return {
    attemptAggregateId: FINAL_ACTIVATION_AGGREGATE,
    verificationId: FINALIZATION_VERIFICATION_ID,
  };
}

function trackedFinalizationWorld(label: string) {
  const world = finalizationWorld(label);
  openStores.push(world.store);
  return world;
}

function handoffCrossCheckWorld(label: string) {
  const world = trackedFinalizationWorld(`handoff-${label}`);
  const binding = readFoundationActivationByAttempt(
    world.store, FINALIZATION_PROJECT_ID, FINAL_ATTEMPT_REF,
  );
  if (binding.status !== "BOUND") {
    throw new Error(`handoff binding refused: ${binding.status}`);
  }
  const seed: HandoffSeedIdentity = {
    activationDigest: binding.activationDigest,
    attemptAggregateId: binding.activationAggregateId,
    attemptRef: binding.attemptId,
    effectId: binding.effectIntentId,
    leaseRef: world.record.lease.leaseId,
    nodeKey: FINAL_NODE_KEY,
    projectId: FINALIZATION_PROJECT_ID,
    sessionId: FINAL_SESSION_ID,
  };
  const identity = Object.freeze({
    attemptRef: FINAL_ATTEMPT_REF,
    nodeKey: FINAL_NODE_KEY,
    projectId: FINALIZATION_PROJECT_ID,
    sessionId: FINAL_SESSION_ID,
  });
  return { binding, identity, seed, store: world.store, storePath: world.storePath };
}

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
  {
    constant: "ATTEMPT_FINALIZATION_LAYER",
    arm: "BEFORE",
    // The request has the exact two selectors plus one caller-authored release claim. The
    // combined exact-key guard (cardinality plus forbidden-member check) is the only production
    // path that can answer before any store read; its cardinality clause alone is redundant for
    // this fixture, as the step-8 mutation drill records.
    name: "a caller-authored release claim is refused before finalization reads the store",
    arranged: ATTEMPT_FINALIZATION_LAYER,
    expected: {
      code: "ATTEMPT_FINALIZATION_REQUEST_MALFORMED",
      layer: ATTEMPT_FINALIZATION_LAYER,
    },
    run: async () => {
      const { store } = openDispatchStore("finalization-before");
      return finalizeVerifiedAttempt(store, finalizationWho, {
        ...finalizationRequest(), release: { truthClass: "DAEMON_VERIFIED" },
      });
    },
  },
  {
    constant: "ATTEMPT_FINALIZATION_LAYER",
    arm: "AFTER",
    // A complete production-seeded attempt exists, but no verification receipt does. Only the
    // receipt reader can refuse; finalization wraps its code without writing a release or binding.
    name: "an attempt with no verification receipt refuses after its durable world was seeded",
    arranged: ATTEMPT_FINALIZATION_LAYER,
    expected: {
      code: "ATTEMPT_FINALIZATION_RECEIPT_UNVERIFIED",
      layer: ATTEMPT_FINALIZATION_LAYER,
    },
    run: async () => {
      const { store } = trackedFinalizationWorld("hostile-after");
      const before = store.readEventHorizon();
      const refusal = finalizeVerifiedAttempt(store, finalizationWho, finalizationRequest());
      if (refusal.ok || refusal.source?.layer !== "DAEMON_VERIFICATION_RECEIPT") {
        throw new Error("finalization did not preserve the receipt reader's refusal layer");
      }
      if (store.readEventHorizon() !== before) {
        throw new Error("an unverified finalization wrote durable state");
      }
      return refusal;
    },
  },
  {
    constant: "HANDOFF_CROSS_CHECK_LAYER",
    arm: "BEFORE",
    // The production-seeded step stream is followed by one hostile tail naming another attempt.
    // The step reader admits the row; only the sources module's cross-check can classify it.
    name: "a step record naming another attempt is cross-checked before handoff facts are exposed",
    arranged: DAEMON_RELEASE_HANDOFF,
    expected: { code: "RELEASE_HANDOFF_SOURCE_FOREIGN", layer: DAEMON_RELEASE_HANDOFF },
    run: async () => {
      const world = handoffCrossCheckWorld("before");
      corruptStepTail(world.store, world.seed, { attemptRef: "attempt-somebody-else" });
      const refusal = readReleaseHandoffFacts(world.store, world.binding, world.identity);
      if (!("ok" in refusal) || refusal.ok !== false
        || refusal.upstream?.layer !== HANDOFF_CROSS_CHECK_LAYER
        || refusal.upstream.code !== "STEP_RECORD_NAMES_ANOTHER_ATTEMPT") {
        throw new Error("foreign step record did not carry the cross-check refusal face");
      }
      return refusal;
    },
  },
  {
    constant: "HANDOFF_CROSS_CHECK_LAYER",
    arm: "AFTER",
    // Both streams first land lawfully. A later journal tail changes only effectId, so each reader
    // succeeds alone and the journal-versus-step comparison is the sole refusing mechanism.
    name: "a journal disagreeing with the standing step record is cross-checked after both landed",
    arranged: DAEMON_RELEASE_HANDOFF,
    expected: { code: "RELEASE_HANDOFF_SOURCE_CONFLICTING", layer: DAEMON_RELEASE_HANDOFF },
    run: async () => {
      const world = handoffCrossCheckWorld("after");
      corruptJournalTail(world.store, world.seed, { effectId: "intent-somebody-else" });
      const refusal = readReleaseHandoffFacts(world.store, world.binding, world.identity);
      if (!("ok" in refusal) || refusal.ok !== false
        || refusal.upstream?.layer !== HANDOFF_CROSS_CHECK_LAYER
        || refusal.upstream.code !== "JOURNAL_AND_STEP_RECORD_DISAGREE") {
        throw new Error("journal conflict did not carry the cross-check refusal face");
      }
      return refusal;
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
  {
    constant: "ATTEMPT_FINALIZATION_LAYER",
    // Two project-scoped connections read the same production-seeded attempt without a receipt.
    // Both must preserve the receipt reader's provenance, and the horizon delta proves the
    // refusals did not hide a release or handoff write.
    name: "two finalizers over one unverified attempt both refuse and neither writes",
    arranged: ATTEMPT_FINALIZATION_LAYER,
    expected: {
      code: "ATTEMPT_FINALIZATION_RECEIPT_UNVERIFIED",
      layer: ATTEMPT_FINALIZATION_LAYER,
    },
    maxAdmitted: 0,
    durableAdmissions: () => finalizationRaceHorizonDelta,
    run: async () => {
      const world = trackedFinalizationWorld("hostile-race");
      const rival = openSecondConnection(world.storePath, FINALIZATION_PROJECT_ID);
      const before = world.store.readEventHorizon();
      const sides = [
        finalizeVerifiedAttempt(world.store, finalizationWho, finalizationRequest()),
        finalizeVerifiedAttempt(rival, finalizationWho, finalizationRequest()),
      ] as const;
      for (const side of sides) {
        if (side.ok || side.source?.layer !== "DAEMON_VERIFICATION_RECEIPT") {
          throw new Error("finalization race lost its receipt-reader refusal source");
        }
      }
      finalizationRaceHorizonDelta = Number(world.store.readEventHorizon() - before);
      return sides;
    },
  },
  {
    constant: "HANDOFF_CROSS_CHECK_LAYER",
    // The conflicting pair is durable before either read. Two independent readers must return
    // the same top-level class and the same cross-check face; neither may repair or append.
    name: "two readers over one conflicting journal and step pair both cross-check and refuse",
    arranged: DAEMON_RELEASE_HANDOFF,
    expected: { code: "RELEASE_HANDOFF_SOURCE_CONFLICTING", layer: DAEMON_RELEASE_HANDOFF },
    maxAdmitted: 0,
    durableAdmissions: () => handoffRaceHorizonDelta,
    run: async () => {
      const world = handoffCrossCheckWorld("race");
      corruptJournalTail(world.store, world.seed, { effectId: "intent-somebody-else" });
      const rival = openSecondConnection(world.storePath, FINALIZATION_PROJECT_ID);
      const before = world.store.readEventHorizon();
      const sides = [
        readReleaseHandoffFacts(world.store, world.binding, world.identity),
        readReleaseHandoffFacts(rival, world.binding, world.identity),
      ] as const;
      for (const side of sides) {
        if (!("ok" in side) || side.ok !== false
          || side.upstream?.layer !== HANDOFF_CROSS_CHECK_LAYER
          || side.upstream.code !== "JOURNAL_AND_STEP_RECORD_DISAGREE") {
          throw new Error("handoff race lost its cross-check refusal face");
        }
      }
      handoffRaceHorizonDelta = Number(world.store.readEventHorizon() - before);
      return sides;
    },
  },
]);
