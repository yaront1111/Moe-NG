/**
 * The preparation aggregate's durable VOCABULARY and its history fold (task-32c1ba45).
 *
 * Split out of `supersession-preparation-ledger.ts` because that module crossed the epic's
 * 400-line hard cap; the rail to split before 400 outranks the plan's five-path preference. This
 * half is pure reading and digesting — it appends nothing — so the writers can stay focused on
 * the multi-leg decisions.
 *
 * The fold REFUSES rather than guessing on an unreadable history: an unverifiable preparation
 * aggregate must never be answered as "nothing is current", because that reads as permission to
 * open a second generation over a live one.
 */
import { createHash } from "node:crypto";

import type { SupersessionNodeFacts } from "@moe/scheduler";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import type { SupersessionPreparationGeneration } from "./supersession-preparation-contracts.js";

const decoder = new TextDecoder();

export const PREPARATION_EVENT_TYPES = Object.freeze({
  FENCE_OPENED: "PreparedPlanningFenceOpened",
  FENCE_RELEASED: "PreparedPlanningFenceReleased",
  FUNDING_RELEASED: "SupersessionFundingReleased",
  FUNDING_RESERVED: "SupersessionFundingReserved",
  PREPARED: "SupersessionPreparationCommitted",
  RELEASED: "SupersessionPreparationReleased",
} as const);

const HISTORY_LAYER = "SUPERSESSION_PREPARATION_HISTORY" as const;

export type DispositionCoverage = "COMPLETE" | "PARTIAL";

export interface PreparationHorizon {
  readonly coverage: DispositionCoverage;
  readonly digest: string;
  readonly graphContentHash: string;
  readonly graphEpoch: number;
}

export interface PreparationHistory {
  /** The current, unreleased generation exactly as it was committed, or null when none is. */
  readonly current: SupersessionPreparationGeneration | null;
  /** The graph epoch the current generation captured, so release can detect an activation. */
  readonly currentGraphEpoch: number | null;
  readonly nextGeneration: number;
  readonly ok: true;
  readonly version: number;
}

export type PreparationHistoryResult =
  | PreparationHistory
  | { readonly code: string; readonly layer: string; readonly ok: false };

/** Domain-separated and length-framed, so a value containing a separator forges no neighbour. */
export function digestOf(domain: string, parts: readonly (string | number)[]): string {
  const digest = createHash("sha256").update(`moe.supersession.${domain}.v1`, "utf8");
  for (const part of parts) {
    const raw = String(part);
    digest.update(`${raw.length}:${raw}\n`, "utf8");
  }
  return digest.digest("hex");
}

export interface HorizonFacts {
  readonly budgetHeadVersion: number;
  readonly coverage: DispositionCoverage;
  readonly dispositionDigest: string;
  readonly finalized: boolean;
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly lineages: readonly string[];
  readonly planHash: string;
  readonly preparationVersion: number;
  readonly revisionId: string;
  readonly runId: string;
}

/**
 * The captured fact horizon. `graphContentHash` is the CODEC's hash as `readCurrentActiveGraph`
 * returns it; the structural `snapshotIdentity` is deliberately absent and may not substitute.
 */
export function horizonDigestOf(facts: HorizonFacts): PreparationHorizon {
  return Object.freeze({
    coverage: facts.coverage,
    digest: digestOf("horizon", [
      facts.budgetHeadVersion, facts.coverage, facts.dispositionDigest,
      facts.finalized ? "FINALIZED" : "FINALIZING", facts.graphContentHash, facts.graphEpoch,
      facts.lineages.length, ...facts.lineages, facts.planHash, facts.preparationVersion,
      facts.revisionId, facts.runId,
    ]),
    graphContentHash: facts.graphContentHash,
    graphEpoch: facts.graphEpoch,
  });
}

/**
 * The disposition facts of the enumerated lineages.
 *
 * A lineage with NO durable attempt, effect, resource lease or budget reservation is the
 * ADD-class fact shape exactly — `attemptDisposition` wants `CREATED`, `effectDisposition` wants
 * terminal, `budgetDisposition` wants `null`. Nothing is invented: each of those is the ABSENCE
 * of a durable record, stated as the absence it is. Two lineages that classify to the same kind
 * make the SET invalid at the scheduler, which is the correct fail-closed answer.
 */
export function lineageFactsFor(lineages: readonly string[]): readonly SupersessionNodeFacts[] {
  return lineages.map((nodeKey) => ({
    attemptLifecycle: "CREATED",
    budget: null,
    effectsTerminal: true,
    kind: "ADD",
    nodeKey,
    resource: {
      drainDisposition: null, release: null, slotState: null, successorCapacity: null,
    },
  } as unknown as SupersessionNodeFacts));
}

export function payloadOf(event: StoredEvent): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(event.payload));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

/** A stored record is trusted only while it still agrees with the event that carried it. */
export function isGenerationRecord(
  value: unknown, generation: number,
): value is SupersessionPreparationGeneration {
  if (typeof value !== "object" || value === null) return false;
  const record = value as SupersessionPreparationGeneration;
  return record.binding?.generation === generation && record.funding?.generation === generation
    && record.fence?.generation === generation && typeof record.supersessionPlanId === "string";
}

function malformed(detail: string): PreparationHistoryResult {
  return Object.freeze({ code: `PREPARATION_HISTORY_${detail}`, layer: HISTORY_LAYER, ok: false });
}

/**
 * Fold the preparation aggregate: which generation is current, what the next one is, and the
 * version any writer must fence against. Refuses rather than guessing on an unreadable history —
 * an unverifiable preparation aggregate must never be answered as "nothing is current".
 */
export function foldPreparationHistory(
  store: SqliteEventStore, aggregateId: string,
): PreparationHistoryResult {
  let current: SupersessionPreparationGeneration | null = null;
  let epoch: number | null = null;
  let highest = 0;
  for (const event of store.readEvents(aggregateId)) {
    const payload = payloadOf(event);
    const value = payload === null ? undefined : payload["generation"];
    if (!Number.isSafeInteger(value) || (value as number) <= 0) return malformed("MALFORMED");
    const generation = value as number;
    if (event.eventType === PREPARATION_EVENT_TYPES.PREPARED) {
      const record = payload?.["record"];
      const graphEpoch = payload?.["horizonGraphEpoch"];
      if (current !== null || generation !== highest + 1
        || !isGenerationRecord(record, generation) || !Number.isSafeInteger(graphEpoch)) {
        return malformed("OUT_OF_ORDER");
      }
      current = record;
      epoch = graphEpoch as number;
      highest = generation;
    } else if (event.eventType === PREPARATION_EVENT_TYPES.RELEASED) {
      if (current === null || current.binding.generation !== generation) {
        return malformed("OUT_OF_ORDER");
      }
      current = null;
      epoch = null;
    } else {
      return malformed("EVENT_TYPE_UNEXPECTED");
    }
  }
  return Object.freeze({
    current, currentGraphEpoch: epoch, nextGeneration: highest + 1, ok: true as const,
    version: store.getAggregateVersion(aggregateId),
  });
}

