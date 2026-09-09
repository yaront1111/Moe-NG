import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { DESIGN_CODE_LAYERS, isDesignSkip } from "../design/design-contracts.js";
import type { DesignCode, DesignEntity, DesignJourney } from "../design/design-contracts.js";
import { readDesignRevision } from "../design/design-store.js";
import type { DesignReadResult } from "../design/design-store.js";
import { refsOfGoal } from "../goals/goal-identity.js";
import { createCompilerLanePort } from "../http/affordance-compiler-lane.js";
import { decodeGoalCatalogEntry } from "../http/goal-catalog-entry.js";
import { composeCompilerInstructions, latestRejectionReason }
  from "../planning/rejection-instructions.js";
import type { DesignBrief } from "./agent-mission-design.js";
import { COMPILER_STEPS } from "./agent-spawn-contract.js";
import { activeCompiledGraphs } from "./compiled-node-source.js";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";
import { compiledExecutionRef } from "./compiled-execution-ref.js";

/**
 * THE MISSION INPUTS THE WRAPPER BINARY SUPPLIES — the durable reads a brief needs, factored out
 * of `agent-wrapper-main.ts` because that file had grown to exactly the 400-line split threshold
 * and could not take one more wiring line. Same category of thing on purpose: each factory here
 * closes over the verifier store and answers ONE optional `AgentWrapperConfig` callback.
 *
 * NONE OF THIS IS AUTHORITY. Every value returned is convenience embedded in advisory mission
 * text; the daemon's decoders re-prove each of them on the seat's actual submit. A wrong answer
 * here buys a refusal, never an effect.
 */

/** Read active graphs the way `createCompiledNodeSource` does — injectable, production default. */
export type ActiveGraphReader = (
  store: SqliteEventStore, projectId: string,
) => readonly ActiveCompiledGraph[];

export interface DesignBriefResolverOptions {
  readonly projectId: string;
  /** Injectable exactly as `CompiledNodeSourceOptions.readActive` is; production walks durably. */
  readonly readActive?: ActiveGraphReader;
  /** `undefined` before the wrapper opens its handle: the resolver then answers null, not ABSENT. */
  readonly store: SqliteEventStore | undefined;
}

/** The refusal codes carry their own layer; taking it from the closed map cannot invent one. */
function unreadable(code: DesignCode): DesignBrief {
  return Object.freeze({ code, layer: DESIGN_CODE_LAYERS[code], outcome: "UNREADABLE" as const });
}

/** Flattened journey screens, deduped with order preserved: a journey map may reuse a screen. */
function screenNames(journeys: readonly DesignJourney[]): readonly string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const journey of journeys) {
    for (const screen of journey.screens) {
      if (seen.has(screen.screen)) continue;
      seen.add(screen.screen);
      names.push(screen.screen);
    }
  }
  return Object.freeze(names);
}

function entityNames(entities: readonly DesignEntity[]): readonly string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entity of entities) {
    if (seen.has(entity.entity)) continue;
    seen.add(entity.entity);
    names.push(entity.entity);
  }
  return Object.freeze(names);
}

/**
 * ONE READ, MAPPED BY CODE — never by `!ok`.
 *
 * `!result.ok -> ABSENT` is the collapse this whole module exists to prevent: it would tell a
 * planning seat, in words, that its goal has no design whenever the ledger merely could not be
 * decoded. `DESIGN_REVISION_ABSENT` is the ONLY code that means absence; every other one is a
 * failed read and travels out as UNREADABLE carrying the code AND the layer that answered.
 *
 * `readDesignRevision` already funnels store throws into `DESIGN_STORE_UNAVAILABLE`; the catch
 * here covers a throw from anywhere else on the path and maps it to the same honest code rather
 * than to silence.
 */
function briefOf(
  store: SqliteEventStore, projectId: string, goalRef: string,
  planningRunRef: string | undefined,
): DesignBrief {
  let read: DesignReadResult;
  try {
    read = readDesignRevision(store, {
      goalRef, projectId,
      ...(planningRunRef === undefined ? {} : { planningRunRef }),
    });
  } catch { return unreadable("DESIGN_STORE_UNAVAILABLE"); }
  if (!read.ok) {
    return read.code === "DESIGN_REVISION_ABSENT"
      ? Object.freeze({ outcome: "ABSENT" as const })
      : unreadable(read.code);
  }
  const revision = read.record.revision;
  if (isDesignSkip(revision)) {
    return Object.freeze({ outcome: "SKIPPED" as const, reason: revision.reason });
  }
  // The ref carries the PROVENANCE, which is the point of naming it in the bytes: a bare goal ref
  // stops meaning a specific thing the moment a resubmit appends version 2.
  return Object.freeze({
    entities: entityNames(revision.dataModel),
    outcome: "PRESENT" as const,
    ref: `${goalRef}@v${String(read.record.version)}`,
    screens: screenNames(revision.screens),
  });
}

/**
 * A compiled node's goal, rebuilt from the two functions `sealedNodesOf` already uses rather than
 * by re-deriving the ref by hand — two spellings of one identity is how a nodeRef comes to bind a
 * node no other reader can find. `CompiledNodeSource` is not widened for this: its interface is
 * shared with the http surface, and both ingredients are already exported.
 *
 * The run ref is the graph's OWN `planningRunRef` (the CURRENT run, successor included), falling
 * back to the initial run only for a fixture graph that carries none. `refsOfGoal(goal)` alone
 * would name the INITIAL run, which after a rejection is not the run that compiled this node.
 */
function goalOfNodeRef(
  store: SqliteEventStore, projectId: string, nodeRef: string, readActive: ActiveGraphReader,
): { readonly goalRef: string; readonly planningRunRef: string } | null {
  let graphs: readonly ActiveCompiledGraph[];
  try { graphs = readActive(store, projectId); } catch { return null; }
  for (const graph of graphs) {
    let match = false;
    try {
      match = graph.content.nodeAuthority.definitions.some(
        (definition) => compiledExecutionRef(projectId, graph, definition.nodeKey) === nodeRef,
      );
    } catch { continue; }
    if (match) {
      return Object.freeze({
        goalRef: graph.goalRef,
        planningRunRef: graph.planningRunRef ?? refsOfGoal(graph.goalRef).planningRunRef,
      });
    }
  }
  return null;
}

/**
 * THE EDGE THIS ROW EXISTS TO LAND: `AgentWrapperConfig.designBrief`, supplied for real.
 *
 * THE TWO LANES READ DIFFERENT VERSIONS, and that is not an inconsistency. A COMPILER seat is
 * staffed BEFORE any plan exists, so no compiled binding can be read and the planned-version fold
 * could only ever refuse for it — it plans FROM the current design, so it reads LATEST. A NODE
 * seat is staffed AFTER, from a sealed plan, so it must read the version that plan was compiled
 * against; `readDesignRevision` resolves that itself from `planningRunRef`, so no second fold is
 * written here.
 *
 * THE ONE LEGITIMATE NULL is an unresolvable nodeRef — an operator spec-dir node, or a node whose
 * graph no longer reads. `nodeDesignLines` documents null as "the caller knows nothing" and emits
 * NOTHING for it, which is honest; it is not the ABSENT collapse, because ABSENT is a claim.
 */
export function createDesignBriefResolver(
  options: DesignBriefResolverOptions,
): (kind: string, target: string | null) => DesignBrief | null {
  const readActive = options.readActive ?? activeCompiledGraphs;
  return (kind, target) => {
    const store = options.store;
    if (store === undefined || target === null) return null;
    if (COMPILER_STEPS.has(kind)) return briefOf(store, options.projectId, target, undefined);
    const bound = goalOfNodeRef(store, options.projectId, target, readActive);
    return bound === null
      ? null
      : briefOf(store, options.projectId, bound.goalRef, bound.planningRunRef);
  };
}

export interface CompilerMissionInputs {
  readonly compilerGateRef: (goalId: string | null) => JsonObject | null;
  readonly compilerInstructions: (goalId: string | null) => string | null;
}

/**
 * THE COMPILER LANE'S TWO DURABLE READS, moved here BYTE-IDENTICALLY from `agent-wrapper-main.ts`
 * (its lines 194-226 before this row) because that file stood at exactly 400 lines and the design
 * edge could not be wired without first making room. The bodies below are the originals, comments
 * and indentation included, so the move can be proved per line rather than trusted — these answer
 * what a RE-STAFFED planning seat reads, and a paraphrase would be invisible in review.
 *
 * The two locals are named for the binary's own so the moved bodies did not have to be rewritten:
 * `verifierStore` is its store handle, `config` its store-dependency record.
 */
export function createCompilerMissionInputs(
  scope: Readonly<{ projectId: string; store: SqliteEventStore | undefined }>,
): CompilerMissionInputs {
  const verifierStore = scope.store;
  const config = { projectId: scope.projectId };
  return {
      // The dispatcher mission's Gate 1 triple, resolved fresh per staffing from
      // the same durable state the offer ladder read. Convenience, not
      // authority: the compile dispatcher re-verifies every submit.
      compilerGateRef: (goalId) => {
        const laneStore = verifierStore;
        if (goalId === null || laneStore === undefined) return null;
        const facts = createCompilerLanePort({
          ledger: readDurableLedger(laneStore, config.projectId),
          projectId: config.projectId,
          store: laneStore,
        }).factsFor(goalId);
        return facts.lane === "COMPILER" && facts.approvedGateRef !== null
          ? { ...facts.approvedGateRef }
          : null;
      },
      // The goal's operator instructions: its durable catalog brief, plus - for a RE-STAFFED seat
      // - why the operator rejected the last plan. That composition is pure and lives in
      // ../planning/rejection-instructions.ts, which is what keeps this file to one call.
      compilerInstructions: (goalId) => {
        const laneStore = verifierStore;
        if (goalId === null || laneStore === undefined) return null;
        const event: unknown = laneStore.readAggregateEvents(goalId, 0, 1).items[0];
        if (event === undefined) return null;
        const decoded = decodeGoalCatalogEntry(
          event as Parameters<typeof decodeGoalCatalogEntry>[0], config.projectId,
        );
        const brief = decoded.ok && decoded.entry.goalId === goalId
          ? decoded.entry.brief?.instructions ?? null : null;
        return composeCompilerInstructions(brief, latestRejectionReason(
          laneStore, config.projectId, refsOfGoal(goalId).planningRunRef,
        ));
      },
  };
}
