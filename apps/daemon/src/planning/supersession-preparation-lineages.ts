/**
 * THE ONE lineage-and-disposition derivation, shared by the preparation that CAPTURES it
 * (task-32c1ba45) and the supersession that REVALIDATES it (task-9e52f850).
 *
 * Extracted rather than copied, and the reason is the whole point of the revalidation: the
 * supersession compares a freshly derived lineage set and disposition digest against the ones the
 * preparation sealed, so a second implementation would let the two sides drift into agreeing about
 * a world neither of them measured. One function, two callers, no second opinion.
 *
 * COVERAGE IS MEASURED, NOT ASSUMED. `buildSupersessionDispositions` is the landed set authority
 * and is called on every path. Its FAMILY refusals (INPUT_INVALID, SUPERSESSION_CONSEQUENCE_CHANGED)
 * are fatal and travel with their own code and layer. Its kind-vocabulary refusal is different: the
 * set wants one lineage per member of `SUPERSESSION_DISPOSITION_KINDS`, and the only graph producer
 * in this tree (`journey-authority-bodies.ts:157-161`) throws on more than one node id, so no
 * production path can present six lineages. That case is recorded as `PARTIAL` coverage over a
 * framed lineage digest, so the day it becomes `COMPLETE` is visible rather than silent.
 */
import { buildSupersessionDispositions } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { graphRevisionAggregateId } from "./active-graph-projection.js";
import type { ActiveGraphAccepted } from "./active-graph-projection.js";
import { digestOf, lineageFactsFor } from "./supersession-preparation-history.js";
import type { DispositionCoverage } from "./supersession-preparation-history.js";

export interface LineageDisposition {
  readonly coverage: DispositionCoverage;
  readonly digest: string;
}

/** The upstream face of a FATAL set refusal, so each caller can wrap it in its own vocabulary. */
export interface LineageDispositionRefusal {
  readonly code: string;
  readonly layer: string;
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

/** The disposition set, or the FATAL refusal's own code and layer for the caller to wrap. */
export function disposeLineages(
  lineages: readonly string[],
): LineageDisposition | LineageDispositionRefusal {
  const built = buildSupersessionDispositions(lineageFactsFor(lineages));
  if (built.ok) return { coverage: "COMPLETE" as const, digest: built.digest };
  if (built.code !== "PLANNING_DISPOSITION_UNKNOWN"
    || built.layer !== "SCHEDULER_SUPERSESSION_SET") {
    return { code: built.code, layer: built.layer };
  }
  return { coverage: "PARTIAL" as const, digest: digestOf("lineages", lineages) };
}

/** The revalidation face: the same derivation, with a fatal refusal collapsed to `null`. */
export function recomputeDispositionFacts(
  lineages: readonly string[],
): LineageDisposition | null {
  const disposed = disposeLineages(lineages);
  return "digest" in disposed ? disposed : null;
}
