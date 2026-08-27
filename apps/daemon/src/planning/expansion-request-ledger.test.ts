/**
 * The strict durable relation reader (task-738a12a816e8421a96edd84648565a38), over a REAL
 * file-backed SqliteEventStore.
 *
 * THE HOSTILE WORLDS ARE COMMITTED THROUGH THE RAW STORE ON PURPOSE. A one-sided SPLIT, a
 * corrupt record and two holds for one tuple are precisely the worlds the production writer
 * cannot produce — that is its whole point — so they are built with the raw
 * `commitExpectedVersionDecision` seam directly. The HEALTHY world is built through the
 * production writer, so the reader is proved against bytes production emits and bytes it cannot.
 *
 * Every refusal names its exact code AND layer, and each is separately asserted to carry no
 * hold, run or state member: an "unverifiable" answer that leaks the record is authority.
 *
 * WINDOWS HANDLE DISCIPLINE: every store is closed by `closeStores()` in `afterAll`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { reduceExpansionPlanningHold } from "@moe/core";
import type { ExpansionPlanningHoldState } from "@moe/core";
import { SqliteEventStore } from "@moe/store";

import { closeStores, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  EXPANSION_HOLD_EVENT_TYPE,
  EXPANSION_RUN_EVENT_TYPE,
  encodeExpansionHoldRecord,
  encodeExpansionRunRecord,
  expansionHoldAggregateId,
} from "./expansion-request-records.js";
import { commitExpansionRequest } from "./expansion-request-commit.js";
import { readCurrentExpansionRequest } from "./expansion-request-ledger.js";
import type { ExpansionRequestSelector } from "./expansion-request-ledger.js";
import {
  FIXTURE_GOAL_REF,
  FIXTURE_PROJECT_ID,
  hex64,
  holdCommandOf,
  holdStateOf,
  runRecordOf,
} from "./expansion-request-test-fixtures.js";

const encoder = new TextEncoder();
let counter = 0;

function envelopeOf(commandId: string) {
  return {
    commandId,
    correlationId: `corr-${commandId}`,
    decidedAt: "2026-08-26T00:00:00.000Z",
    payload: {},
    principalId: "principal-1",
    projectId: FIXTURE_PROJECT_ID,
  };
}

function selectorOf(
  hold: ExpansionPlanningHoldState,
  overrides: Partial<ExpansionRequestSelector> = {},
): ExpansionRequestSelector {
  return {
    generation: hold.generation,
    goalRef: FIXTURE_GOAL_REF,
    graphEpoch: hold.graphEpoch,
    holdVersion: hold.version,
    parentNodeRef: hold.parentNodeRef,
    parentRunRef: hold.parentRunRef,
    planningRunRef: hold.planningRunRef,
    projectId: FIXTURE_PROJECT_ID,
    ...overrides,
  };
}

/** One aggregate, one event — the raw seam a crash between two commits would leave behind. */
function commitLeg(
  store: SqliteEventStore, aggregateId: string, eventType: string, payload: Uint8Array,
  projectId = FIXTURE_PROJECT_ID,
): Readonly<{ commandId: string; eventId: string }> {
  counter += 1;
  const commandId = `raw-${String(counter)}`;
  const eventId = `${commandId}:${eventType}`;
  store.commitExpectedVersionDecision({
    commandKind: "test.raw_leg",
    committedResultBytes: payload,
    correlationId: commandId,
    decidedAt: "2026-08-26T00:00:00.000Z",
    events: [{ eventId, eventType, payload }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId, principalId: "principal-1", projectId },
    requestBytes: encoder.encode(commandId),
    targetAggregateId: aggregateId,
  });
  return { commandId, eventId };
}

/** Legacy commits carry no decision trace; this is the exact historical fail-open input. */
function commitTraceLessLeg(
  store: SqliteEventStore, aggregateId: string, eventType: string, payload: Uint8Array,
): string {
  counter += 1;
  const commandId = `legacy-${String(counter)}`;
  const eventId = `${commandId}:${eventType}`;
  store.commit({
    aggregateId,
    commandBytes: encoder.encode(commandId),
    commandId,
    committedAt: "2026-08-26T00:00:00.000Z",
    events: [{ eventId, eventType, payload }],
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
  return eventId;
}

function refusalOf(value: unknown): Record<string, unknown> {
  const refusal = value as Record<string, unknown>;
  expect(refusal["ok"]).toBe(false);
  // No refusal may carry a fact: the reader answers with a reason, never with the record.
  for (const leaked of ["hold", "run", "pair", "state"]) {
    expect(Object.hasOwn(refusal, leaked)).toBe(false);
  }
  return { code: refusal["code"], layer: refusal["layer"] };
}

/** A fresh store carrying one healthy pair, written by the PRODUCTION writer. */
function healthyStore(holdId = "hold-1", planningRunRef = "run-expansion-1") {
  const store = openStore();
  const command = holdCommandOf({
    commandId: `cmd-${holdId}`, holdId, planningRunRef,
  });
  const hold = holdStateOf(command);
  const run = runRecordOf(hold);
  const result = commitExpansionRequest(store, {
    envelope: envelopeOf(command.commandId),
    goalRef: FIXTURE_GOAL_REF,
    goalVersion: 0,
    hold,
    holdAggregateId: expansionHoldAggregateId(FIXTURE_PROJECT_ID, hold.holdId),
    requestBytes: encoder.encode(command.commandId),
    run,
  });
  if (!result.ok) throw new Error(`healthy commit refused: ${result.code}`);
  return { hold, run, store };
}

afterAll(() => {
  closeStores();
});

describe("readCurrentExpansionRequest healthy pair (task-738a12a816e8421a96edd84648565a38)", () => {
  it("selects exactly one ACTIVE hold and the EXPANSION run bound to it", () => {
    const { hold, store } = healthyStore();
    const result = readCurrentExpansionRequest(store, selectorOf(hold));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pair.hold.holdId).toBe(hold.holdId);
    expect(result.pair.hold.lifecycle).toBe("ACTIVE");
    expect(result.pair.hold.version).toBe(1);
    expect(result.pair.run.runKind).toBe("EXPANSION");
    expect(result.pair.run.runId).toBe(hold.planningRunRef);
    expect(result.pair.run.lifecycle).toBe("DRAFT");
    expect(result.pair.holdAggregateId)
      .toBe(expansionHoldAggregateId(FIXTURE_PROJECT_ID, hold.holdId));
    expect(Object.isFrozen(result.pair)).toBe(true);
  });

  it("refuses ABSENT for every tuple member moved one at a time", () => {
    const { hold, store } = healthyStore();
    const moves: readonly Partial<ExpansionRequestSelector>[] = [
      { parentNodeRef: "other-node" },
      { parentRunRef: "other-parent-run" },
      { planningRunRef: "other-planning-run" },
      { generation: hold.generation + 1 },
      { graphEpoch: hold.graphEpoch + 1 },
      { projectId: "project-other" },
    ];
    let cases = 0;
    for (const move of moves) {
      expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(hold, move)))).toStrictEqual({
        code: "EXPANSION_REQUEST_LEDGER_ABSENT", layer: "LEDGER",
      });
      cases += 1;
    }
    expect(cases).toBe(6);
  });

  it("refuses STALE when the hold version has moved, not ABSENT", () => {
    const { hold, store } = healthyStore();
    expect(refusalOf(readCurrentExpansionRequest(
      store, selectorOf(hold, { holdVersion: hold.version + 1 }),
    ))).toStrictEqual({ code: "EXPANSION_REQUEST_LEDGER_STALE", layer: "LEDGER" });
  });

  it("refuses FOREIGN when the run leg belongs to another goal", () => {
    const { hold, store } = healthyStore();
    expect(refusalOf(readCurrentExpansionRequest(
      store, selectorOf(hold, { goalRef: "goal-other" }),
    ))).toStrictEqual({ code: "EXPANSION_REQUEST_LEDGER_FOREIGN", layer: "LEDGER" });
  });
});

describe("one-sided and hostile worlds (task-738a12a816e8421a96edd84648565a38)", () => {
  it("refuses SPLIT when the run leg has no project decision trace", () => {
    const store = openStore();
    const hold = holdStateOf();
    commitLeg(
      store, expansionHoldAggregateId(FIXTURE_PROJECT_ID, hold.holdId),
      EXPANSION_HOLD_EVENT_TYPE, encodeExpansionHoldRecord(hold),
    );
    const eventId = commitTraceLessLeg(
      store, hold.planningRunRef, EXPANSION_RUN_EVENT_TYPE,
      encodeExpansionRunRecord(runRecordOf(hold)),
    );
    const stored = store.readEvents(hold.planningRunRef).at(-1);
    expect(stored?.eventId).toBe(eventId);
    expect(stored?.decisionTrace).toBeUndefined();
    expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(hold)))).toStrictEqual({
      code: "EXPANSION_REQUEST_LEDGER_SPLIT", layer: "LEDGER",
    });
  });

  it("refuses SPLIT when the run leg decision trace names a foreign project", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-expansion-foreign-trace-"));
    const databasePath = join(directory, "store.sqlite");
    const store = SqliteEventStore.openForProject(databasePath, FIXTURE_PROJECT_ID);
    try {
      const hold = holdStateOf();
      commitLeg(
        store, expansionHoldAggregateId(FIXTURE_PROJECT_ID, hold.holdId),
        EXPANSION_HOLD_EVENT_TYPE, encodeExpansionHoldRecord(hold),
      );
      const identity = commitLeg(
        store, hold.planningRunRef, EXPANSION_RUN_EVENT_TYPE,
        encodeExpansionRunRecord(runRecordOf(hold)),
      );
      const database = new DatabaseSync(databasePath);
      try {
        database.prepare(
          "UPDATE command_decisions SET project_id = ? WHERE command_id = ?",
        ).run("project-other", identity.commandId);
      } finally {
        database.close();
      }
      const stored = store.readEvents(hold.planningRunRef).at(-1);
      expect(stored?.eventId).toBe(identity.eventId);
      expect(stored?.decisionTrace?.projectId).toBe("project-other");
      expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(hold)))).toStrictEqual({
        code: "EXPANSION_REQUEST_LEDGER_SPLIT", layer: "LEDGER",
      });
    } finally {
      store.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses ABSENT when neither leg exists", () => {
    const store = openStore();
    const hold = holdStateOf();
    expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(hold)))).toStrictEqual({
      code: "EXPANSION_REQUEST_LEDGER_ABSENT", layer: "LEDGER",
    });
  });

  it("refuses SPLIT for a hold with no run leg", () => {
    const store = openStore();
    const hold = holdStateOf();
    commitLeg(
      store, expansionHoldAggregateId(FIXTURE_PROJECT_ID, hold.holdId),
      EXPANSION_HOLD_EVENT_TYPE, encodeExpansionHoldRecord(hold),
    );
    expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(hold)))).toStrictEqual({
      code: "EXPANSION_REQUEST_LEDGER_SPLIT", layer: "LEDGER",
    });
  });

  it("refuses SPLIT for a run leg with no hold — the other direction", () => {
    const store = openStore();
    const hold = holdStateOf();
    commitLeg(
      store, hold.planningRunRef, EXPANSION_RUN_EVENT_TYPE,
      encodeExpansionRunRecord(runRecordOf(hold)),
    );
    expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(hold)))).toStrictEqual({
      code: "EXPANSION_REQUEST_LEDGER_SPLIT", layer: "LEDGER",
    });
  });

  it("refuses TERMINAL for a hold that has been resolved", () => {
    const store = openStore();
    const active = holdStateOf();
    const terminal = reduceExpansionPlanningHold(active, {
      cause: "EXPANSION_REFUSED",
      commandId: "cmd-terminate-1",
      expectedVersion: 1,
      generation: active.generation,
      graphEpoch: active.graphEpoch,
      holdId: active.holdId,
      kind: "expansion.transition_hold",
      parentNodeRef: active.parentNodeRef,
      parentRevisionRef: active.parentRevisionRef,
      parentRunRef: active.parentRunRef,
      planningRunRef: active.planningRunRef,
      proposalBaseHash: active.proposalBaseHash,
      sourceFingerprint: active.sourceFingerprint,
      targetLifecycle: "RESOLVED",
      terminalProof: {
        authorityState: "TERMINAL", decisionRef: "decision-1",
        successorHoldRef: null, truthClass: "DAEMON_VERIFIED",
      },
    });
    expect(terminal.ok).toBe(true);
    if (!terminal.ok) return;
    commitLeg(
      store, expansionHoldAggregateId(FIXTURE_PROJECT_ID, active.holdId),
      EXPANSION_HOLD_EVENT_TYPE, encodeExpansionHoldRecord(terminal.state),
    );
    commitLeg(
      store, active.planningRunRef, EXPANSION_RUN_EVENT_TYPE,
      encodeExpansionRunRecord(runRecordOf(active)),
    );
    expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(active)))).toStrictEqual({
      code: "EXPANSION_REQUEST_LEDGER_TERMINAL", layer: "LEDGER",
    });
  });

  it("refuses MALFORMED for a corrupt hold record rather than reporting absence", () => {
    const store = openStore();
    const hold = holdStateOf();
    commitLeg(
      store, expansionHoldAggregateId(FIXTURE_PROJECT_ID, hold.holdId),
      EXPANSION_HOLD_EVENT_TYPE, encoder.encode('{"state":{"holdId":"hold-1"}}'),
    );
    expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(hold)))).toStrictEqual({
      code: "EXPANSION_REQUEST_LEDGER_MALFORMED", layer: "LEDGER",
    });
  });

  it("refuses MALFORMED for a run record whose state no longer matches its own command", () => {
    const store = openStore();
    const hold = holdStateOf();
    const run = runRecordOf(hold);
    const tampered = {
      command: run.command,
      state: { ...run.state, lifecycle: "APPROVED" },
    };
    commitLeg(
      store, expansionHoldAggregateId(FIXTURE_PROJECT_ID, hold.holdId),
      EXPANSION_HOLD_EVENT_TYPE, encodeExpansionHoldRecord(hold),
    );
    commitLeg(
      store, hold.planningRunRef, EXPANSION_RUN_EVENT_TYPE,
      encoder.encode(JSON.stringify(tampered)),
    );
    expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(hold)))).toStrictEqual({
      code: "EXPANSION_REQUEST_LEDGER_MALFORMED", layer: "LEDGER",
    });
  });

  it("refuses AMBIGUOUS when two holds answer the same tuple", () => {
    const store = openStore();
    const first = holdStateOf();
    const second = holdStateOf(holdCommandOf({ commandId: "cmd-two", holdId: "hold-2" }));
    for (const hold of [first, second]) {
      commitLeg(
        store, expansionHoldAggregateId(FIXTURE_PROJECT_ID, hold.holdId),
        EXPANSION_HOLD_EVENT_TYPE, encodeExpansionHoldRecord(hold),
      );
    }
    commitLeg(
      store, first.planningRunRef, EXPANSION_RUN_EVENT_TYPE,
      encodeExpansionRunRecord(runRecordOf(first)),
    );
    expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(first)))).toStrictEqual({
      code: "EXPANSION_REQUEST_LEDGER_AMBIGUOUS", layer: "LEDGER",
    });
  });

  it("refuses CONFLICTING when the run leg is bound to a different hold", () => {
    const store = openStore();
    const hold = holdStateOf();
    const other = holdStateOf(holdCommandOf({
      commandId: "cmd-other", holdId: "hold-other", proposalBaseHash: hex64("ef"),
    }));
    commitLeg(
      store, expansionHoldAggregateId(FIXTURE_PROJECT_ID, hold.holdId),
      EXPANSION_HOLD_EVENT_TYPE, encodeExpansionHoldRecord(hold),
    );
    // The run leg lives at the hold's OWN planningRunRef but carries the other hold's binding.
    const foreign = runRecordOf(other);
    commitLeg(
      store, hold.planningRunRef, EXPANSION_RUN_EVENT_TYPE,
      encoder.encode(JSON.stringify({
        command: { ...foreign.command, runId: hold.planningRunRef },
        state: { ...foreign.state, runId: hold.planningRunRef },
      })),
    );
    expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(hold)))).toStrictEqual({
      code: "EXPANSION_REQUEST_LEDGER_CONFLICTING", layer: "LEDGER",
    });
  });

  it("cannot see another project's hold at all", () => {
    const store = openStore();
    const hold = holdStateOf();
    commitLeg(
      store, expansionHoldAggregateId("project-other", hold.holdId),
      EXPANSION_HOLD_EVENT_TYPE, encodeExpansionHoldRecord(hold),
    );
    commitLeg(
      store, hold.planningRunRef, EXPANSION_RUN_EVENT_TYPE,
      encodeExpansionRunRecord(runRecordOf(hold)),
    );
    expect(refusalOf(readCurrentExpansionRequest(store, selectorOf(hold)))).toStrictEqual({
      code: "EXPANSION_REQUEST_LEDGER_SPLIT", layer: "LEDGER",
    });
  });
});
