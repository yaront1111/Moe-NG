import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type {
  CommandDecisionRecord, CommandReceipt, StoredEvent,
} from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_ID, PROJECT_ID, closeStores, openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { seedApprovedNodeScope } from "./admission-witness-fixtures.js";
import {
  readHumanApprovalAuthority,
} from "./human-approval-authority-reader.js";
import type {
  HumanApprovalAuthorityStore,
} from "./human-approval-authority-reader.js";

const NODE_KEY = "dev-solo";
const GRAPH_REVISION = "graph-revision-1";
const ENCODER = new TextEncoder();

interface Evidence {
  readonly decision: CommandDecisionRecord;
  readonly event: StoredEvent;
  readonly receipt: CommandReceipt;
}

function evidence(store: HumanApprovalAuthorityStore): Evidence {
  const event = store.readEvents(GOAL_ID).find((row) => row.eventType === "GoalExecutionEnabled");
  if (event?.decisionTrace === undefined) throw new Error("approval event has no decision trace");
  const decision = store.getCommandDecision({
    commandId: event.decisionTrace.commandId,
    principalId: event.decisionTrace.principalId,
    projectId: PROJECT_ID,
  });
  const receipt = store.getCommandReceipt(event.commandId);
  if (decision === null || receipt === null) throw new Error("approval provenance is incomplete");
  return { decision, event, receipt };
}

function payloadOf(event: StoredEvent): JsonObject {
  const decoded = decodeBoundedJsonBytes(event.payload);
  if (!decoded.ok || decoded.value === null || typeof decoded.value !== "object"
    || Array.isArray(decoded.value)) throw new Error("approval payload is unreadable");
  return decoded.value as JsonObject;
}

function withPayload(
  event: StoredEvent, mutate: (payload: JsonObject) => JsonObject,
): StoredEvent {
  return { ...event, payload: ENCODER.encode(JSON.stringify(mutate(payloadOf(event)))) };
}

function port(
  real: HumanApprovalAuthorityStore,
  overrides: Readonly<{
    decision?: (value: CommandDecisionRecord) => CommandDecisionRecord | null;
    event?: (value: StoredEvent) => StoredEvent;
    receipt?: (value: CommandReceipt) => CommandReceipt | null;
  }> = {},
): HumanApprovalAuthorityStore {
  const records = evidence(real);
  return {
    getCommandDecision: () => overrides.decision === undefined
      ? records.decision : overrides.decision(records.decision),
    getCommandReceipt: () => overrides.receipt === undefined
      ? records.receipt : overrides.receipt(records.receipt),
    readEvents: (aggregateId) => real.readEvents(aggregateId).map((event) =>
      event.eventId === records.event.eventId ? (overrides.event?.(event) ?? event) : event),
  };
}

function read(
  store: HumanApprovalAuthorityStore,
  overrides: Readonly<{ graphRevisionRef?: string; nodeKey?: string; projectId?: string }> = {},
) {
  return readHumanApprovalAuthority({
    graphRevisionRef: overrides.graphRevisionRef ?? GRAPH_REVISION,
    goalRef: GOAL_ID,
    nodeKey: overrides.nodeKey ?? NODE_KEY,
    projectId: overrides.projectId ?? PROJECT_ID,
    store,
  });
}

function seeded() {
  const store = openStore();
  seedApprovedNodeScope(store, [NODE_KEY]);
  return store;
}

afterEach(closeStores);

describe("human approval durable authority", () => {
  it("re-proves the production event through its decision and primary receipt", () => {
    const result = read(seeded());
    expect(result).toStrictEqual({
      approval: { approvalRef: "approval-1", decision: "APPROVE", validity: "CURRENT" },
      ok: true,
    });
  });

  it("binds the approval to the exact active graph revision", () => {
    expect(read(seeded(), { graphRevisionRef: "graph-revision-other" })).toStrictEqual({
      code: "ADMISSION_GATE_SUBJECT_MISMATCH", ok: false,
    });
  });

  it.each([
    ["trace project", (event: StoredEvent): StoredEvent => ({
      ...event, decisionTrace: { ...event.decisionTrace!, projectId: "project-other" },
    })],
    ["trace command kind", (event: StoredEvent): StoredEvent => ({
      ...event, decisionTrace: { ...event.decisionTrace!, commandKind: "goal.create" },
    })],
    ["approval actor", (event: StoredEvent): StoredEvent => withPayload(event, (payload) => ({
      ...payload,
      approval: { ...(payload["approval"] as JsonObject), actor: "principal-other" },
    }))],
    ["approval cross-link", (event: StoredEvent): StoredEvent => withPayload(event, (payload) => ({
      ...payload,
      activation: { ...(payload["activation"] as JsonObject), graphApprovalRef: "approval-other" },
    }))],
  ] as const)("refuses a valid-looking event with foreign %s", (_label, mutate) => {
    const store = seeded();
    expect(read(port(store, { event: mutate }))).toStrictEqual({
      code: "ADMISSION_GATE_SUBJECT_MISMATCH", ok: false,
    });
  });

  it.each([
    ["decision target", (value: CommandDecisionRecord) => ({
      ...value, targetAggregateId: "goal-other",
    })],
    ["decision request", (value: CommandDecisionRecord) => ({
      ...value, requestSha256: "0".repeat(64),
    })],
    ["decision event", (value: CommandDecisionRecord) => ({
      ...value, businessEventIds: ["event-other"],
    })],
    ["decision version", (value: CommandDecisionRecord) => ({
      ...value, currentVersion: 3,
    })],
  ] as const)("refuses foreign %s provenance", (_label, mutate) => {
    const store = seeded();
    expect(read(port(store, {
      decision: (value) => mutate(value) as CommandDecisionRecord,
    }))).toStrictEqual({ code: "ADMISSION_GATE_SUBJECT_MISMATCH", ok: false });
  });

  it.each([
    ["receipt aggregate", (value: CommandReceipt): CommandReceipt => ({
      ...value, aggregateId: "goal-other",
    })],
    ["receipt request", (value: CommandReceipt): CommandReceipt => ({
      ...value, requestSha256: "0".repeat(64),
    })],
    ["receipt event", (value: CommandReceipt): CommandReceipt => ({
      ...value, eventIds: ["event-other"],
    })],
    ["receipt effect", (value: CommandReceipt): CommandReceipt => ({
      ...value, effectSha256: "0".repeat(64),
    })],
  ] as const)("refuses foreign %s provenance", (_label, mutate) => {
    const store = seeded();
    expect(read(port(store, { receipt: mutate }))).toStrictEqual({
      code: "ADMISSION_GATE_SUBJECT_MISMATCH", ok: false,
    });
  });

  it("treats missing trace, activation, decision, or receipt as absent authority", () => {
    const cases: readonly HumanApprovalAuthorityStore[] = [
      port(seeded(), { event: (event) => {
        const { decisionTrace: _missing, ...without } = event;
        return without;
      } }),
      port(seeded(), { event: (event) => withPayload(event, (payload) => {
        const { activation: _missing, ...without } = payload;
        return without;
      }) }),
      port(seeded(), { decision: () => null }),
      port(seeded(), { receipt: () => null }),
    ];
    for (const candidate of cases) {
      expect(read(candidate)).toStrictEqual({
        code: "ADMISSION_GATE_WITNESS_ABSENT", ok: false,
      });
    }
  });

  it("keeps a valid approval for another node distinct from missing authority", () => {
    expect(read(seeded(), { nodeKey: "node-other" })).toStrictEqual({
      code: "ADMISSION_GATE_SCOPE_MISMATCH", ok: false,
    });
  });
});
