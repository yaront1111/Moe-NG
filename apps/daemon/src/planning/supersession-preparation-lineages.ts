/**
 * THE ONE lineage enumeration, shared by the preparation that CAPTURES it (task-32c1ba45) and the
 * supersession that REVALIDATES it (task-9e52f850).
 *
 * Extracted rather than copied, and the reason is the whole point of the revalidation: the
 * supersession compares a freshly enumerated lineage set and digest against the ones the preparation
 * sealed, so a second implementation would let the two sides drift into agreeing about a world
 * neither of them measured. One function, two callers, no second opinion.
 *
 * PREPARATION HAS NO SUCCESSOR CONTENT and therefore cannot derive a relation between before and
 * after authority. It records honest PARTIAL coverage over the framed durable-lineage digest.
 * Literal-kind completeness is measured later, at supersede time, from both authenticated contents.
 */
import type { SqliteEventStore } from "@moe/store";

import { graphRevisionAggregateId } from "./active-graph-projection.js";
import type { ActiveGraphAccepted } from "./active-graph-projection.js";
import { digestOf } from "./supersession-preparation-history.js";
import type { DispositionCoverage } from "./supersession-preparation-history.js";

export interface LineageDisposition {
  readonly coverage: DispositionCoverage;
  readonly digest: string;
}

/**
 * Every lineage of the current graph plus every graph-revision aggregate that is NOT the activating
 * one, taken at ONE store horizon. The activating revision is excluded by identity, so a project
 * whose only revision is the active one still yields its node lineages.
 */
export function enumerateGraphLineages(
  store: SqliteEventStore, projectId: string, activeAggregateId: string,
  nodeKeys: readonly string[],
): readonly string[] {
  const foreign = store.enumerateAggregateIdsByPrefix(graphRevisionAggregateId(projectId, ""))
    .filter((aggregateId) => aggregateId !== activeAggregateId);
  return [...new Set([...nodeKeys, ...foreign])].sort();
}

/** The same enumeration, addressed from a durable active-graph read rather than its parts. */
export function lineagesOfActiveGraph(
  store: SqliteEventStore, projectId: string, active: ActiveGraphAccepted,
): readonly string[] {
  return enumerateGraphLineages(store, projectId, active.provenance.aggregateId,
    active.content.snapshot.nodes.map((node) => node.nodeKey));
}

/** Preparation-time coverage is necessarily PARTIAL because no successor content exists yet. */
export function disposeLineages(
  lineages: readonly string[],
): LineageDisposition {
  return { coverage: "PARTIAL" as const, digest: digestOf("lineages", lineages) };
}

/** The revalidation face: the same framed digest and honest preparation-time coverage. */
export function recomputeDispositionFacts(
  lineages: readonly string[],
): LineageDisposition {
  return disposeLineages(lineages);
}
