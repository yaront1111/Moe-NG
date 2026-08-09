import type { CommandDecisionRecord } from "@moe/store";
import { SqliteEventStore } from "@moe/store";

import { CONTINUATION_SCHEMA_VERSION } from "./continuation-contracts.js";
import { evaluateContinuationCommandBytes } from "./continuation-service.js";
import { reconcileOnRestart } from "./restart-reconciliation.js";
import { SETTLED, observation, records, situation } from "./recovery-test-fixtures.js";

/**
 * Shared driver for the continuation suites.
 *
 * This module DRIVES the production surface and never restates it: `seed` calls
 * the real restart reconciliation, `run` calls the real command entry point, and
 * nothing here re-derives a classification, an admission or a refusal code. The
 * only local logic is the durable-row snapshot, which reads what the store
 * actually holds so a refusal that wrote first cannot hide behind its own
 * return value.
 */
export const PROJECT_ID = "project-continuation";

const encoder = new TextEncoder();
const open: SqliteEventStore[] = [];

export function store(): SqliteEventStore {
  const opened = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  open.push(opened);
  return opened;
}

export function closeOpenStores(): void {
  while (open.length > 0) open.pop()?.close();
}

export function decisions(opened: SqliteEventStore): readonly CommandDecisionRecord[] {
  const all: CommandDecisionRecord[] = [];
  let cursor = 0n;
  for (;;) {
    const page = opened.readCommandDecisionsAfter(cursor, 200);
    all.push(...page.items.filter((entry) => entry.key.projectId === PROJECT_ID));
    if (!page.hasMore || page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
}

/**
 * Every durable row reduced to comparable bytes. A refusal that wrote first and
 * refused afterwards passes any assertion made on the returned value alone; it
 * cannot pass a comparison of this snapshot across the call.
 */
export function snapshot(opened: SqliteEventStore): string {
  return JSON.stringify(
    decisions(opened).map((entry) => [
      entry.key.commandId,
      entry.commandKind,
      entry.targetAggregateId,
      entry.currentVersion,
      entry.effectDisposition,
      [...entry.resultBytes],
    ]),
  );
}

/** A crash the runner classifies ABSENT: proven gone, settled, resources released. */
export const ABSENT = situation({
  observation: observation({ effectStatus: "PROVEN_ABSENT", processExit: { kind: "EXITED", code: 0 } }),
  records: records(SETTLED),
});

/** A crash the runner REFUSES to classify — a record, but not a classification. */
export const UNCLASSIFIABLE = situation();

export function seed(opened: SqliteEventStore, attemptRef: string, crash: unknown): boolean {
  return reconcileOnRestart(opened, {
    attempts: [{ attemptRef, situation: crash }],
    correlationId: "corr-restart",
    decidedAt: "2026-08-09T00:00:00.000Z",
    principalId: "daemon-1",
    projectId: PROJECT_ID,
  }).ok;
}

export function request(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    attemptRef: "attempt-absent",
    correlationId: "corr-continuation",
    decidedAt: "2026-08-09T00:00:00.000Z",
    kind: "work.resume",
    predecessorRelease: "PROVEN_RELEASED",
    principalId: "daemon-1",
    projectId: PROJECT_ID,
    safeHandoff: "handoff-1",
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    successorRef: "successor-1",
    ...overrides,
  };
}

export function run(
  opened: SqliteEventStore,
  overrides: Readonly<Record<string, unknown>> = {},
): ReturnType<typeof evaluateContinuationCommandBytes> {
  return evaluateContinuationCommandBytes(opened, encoder.encode(JSON.stringify(request(overrides))));
}
