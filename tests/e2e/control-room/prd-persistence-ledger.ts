/**
 * The DURABLE-LEDGER COUNTER the PRD-boundary arms are graded against.
 *
 * EXTRACTED FROM `prd-persistence-boundary.spec.ts` VERBATIM, at the architect's
 * instruction, when the atomic-bind arms pushed that file past 400 lines. Not a
 * rewrite: every function below is byte-for-byte what the QA-verified spec
 * carried at commit 791960ec, moved so the spec holds arms and this holds the
 * counter they read. No bridge is needed - nothing under `tests/` is imported by
 * a runtime module.
 *
 * WHY THE COUNTS COME FROM THE STORE. A zero-write assertion read off a UI
 * status string proves the UI is quiet, not that the ledger is; and a snapshot
 * that silently capped its page would make every arm vacuous, so a truncated
 * read throws rather than under-reports.
 */
import { SqliteEventStore } from "@moe/store";
import { expect } from "@playwright/test";

import type { LaneScratch } from "./daemon-ports.js";

/** The page bound every snapshot reads under; a truncated page is a hard error. */
export const SNAPSHOT_LIMIT = 1_000;

export interface LedgerSnapshot {
  readonly aggregateIds: readonly string[];
  readonly briefRows: number;
  readonly decisionRows: number;
  readonly documentSourceRows: number;
  readonly eventRows: number;
  readonly goalRows: number;
  readonly horizon: string;
  readonly proposalRows: number;
}

/** True when a GoalCreated payload carries a `brief` member. */
export function carriesBrief(payload: Uint8Array): boolean {
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(payload));
    return Array.isArray(decoded)
      && decoded.some((fact) => fact !== null && typeof fact === "object"
        && !Array.isArray(fact) && Object.hasOwn(fact, "brief"));
  } catch {
    return false;
  }
}

/** The `instructions` prose of the newest GoalCreated fact, or null if none. */
export function newestGoalInstructions(scratch: LaneScratch): string | null {
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  try {
    const events = store.readEventsAfter(0n, SNAPSHOT_LIMIT);
    const goals = events.items.filter((event) => event.eventType === "GoalCreated");
    const newest = goals.at(-1);
    if (newest === undefined) return null;
    const decoded: unknown = JSON.parse(new TextDecoder().decode(newest.payload));
    if (!Array.isArray(decoded)) return null;
    for (const fact of decoded) {
      if (fact === null || typeof fact !== "object" || Array.isArray(fact)) continue;
      const brief: unknown = (fact as Record<string, unknown>)["brief"];
      if (brief === null || typeof brief !== "object" || Array.isArray(brief)) continue;
      const instructions: unknown = (brief as Record<string, unknown>)["instructions"];
      if (typeof instructions === "string") return instructions;
    }
    return null;
  } finally {
    store.close();
  }
}

/**
 * Reads the lane's REAL store. Counts come from the ledger itself, never from a
 * UI status string, and a truncated page throws rather than under-reporting a
 * write - a snapshot that silently caps would make every arm vacuous.
 */
export function ledgerSnapshot(scratch: LaneScratch): LedgerSnapshot {
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  try {
    const events = store.readEventsAfter(0n, SNAPSHOT_LIMIT);
    const decisions = store.readCommandDecisionsAfter(0n, SNAPSHOT_LIMIT);
    if (events.hasMore || decisions.hasMore) {
      throw new Error(`E2E_LEDGER_SNAPSHOT_TRUNCATED: limit=${String(SNAPSHOT_LIMIT)}`);
    }
    const goals = events.items.filter((event) => event.eventType === "GoalCreated");
    return Object.freeze({
      aggregateIds: Object.freeze(
        [...new Set(events.items.map((event) => event.aggregateId))].sort(),
      ),
      briefRows: goals.filter((event) => carriesBrief(event.payload)).length,
      decisionRows: decisions.items.length,
      documentSourceRows: events.items.filter(
        (event) => event.eventType === "DocumentSourceTextRecorded",
      ).length,
      eventRows: events.items.length,
      goalRows: goals.length,
      horizon: String(store.readEventHorizon()),
      proposalRows: events.items.filter(
        (event) => event.eventType === "DocumentWorkProposalRecorded",
      ).length,
    });
  } finally {
    store.close();
  }
}

/** Every counted dimension must be byte-identical, with the denominator named. */
export function expectNoDurableWrite(
  before: LedgerSnapshot,
  after: LedgerSnapshot,
  arm: string,
): void {
  expect(
    after,
    `${arm}: expected 0 NEW rows on top of ${String(before.eventRows)} events / `
      + `${String(before.decisionRows)} decisions / ${String(before.goalRows)} goals`,
  ).toEqual(before);
}
