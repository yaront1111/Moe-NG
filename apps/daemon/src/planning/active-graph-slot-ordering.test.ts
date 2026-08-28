import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  activeGraphSlotAggregateId,
  buildActiveGraphSlotLeg,
} from "./active-graph-slot.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import {
  PROJECT_ID,
  SECOND_GRAPH_REVISION_REF,
  approvableStoreWithTwoGoals,
  closeStores,
  contextFor,
  inputFor,
  inputForSecondGoal,
  requestFor,
  twoHandles,
} from "./graph-activation-test-fixtures.js";
import { activateApprovedGraph } from "./graph-activation-service.js";
import { supersedeActiveGraph } from "./graph-supersede-service.js";
import {
  prepareSupersession,
  supersedeContext,
  supersedeInput,
} from "./graph-supersede-test-fixtures.js";

const decoder = new TextDecoder();

function slotReadFacade(handle: SqliteEventStore, before: () => void): SqliteEventStore {
  let pending = true;
  const slotId = activeGraphSlotAggregateId(PROJECT_ID);
  return new Proxy(handle, { get(target, property) {
    if (property === "getAggregateVersion") return (aggregateId: string) => {
      if (pending && aggregateId === slotId) { pending = false; before(); }
      return target.getAggregateVersion(aggregateId);
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

afterEach(closeStores);

describe("task-37c56d29 slot observation precedes the world it fences", () => {
  it("observes the slot before scanning the project's active revisions", () => {
    const { a, b } = twoHandles(approvableStoreWithTwoGoals());
    let peerAccepted = false;
    const facade = slotReadFacade(a, () => {
      peerAccepted = activateApprovedGraph(
        contextFor(b, requestFor("cmd-slot-read-peer")), inputForSecondGoal(b),
      ).ok;
    });
    const outcome = activateApprovedGraph(
      contextFor(facade, requestFor("cmd-slot-read-primary")), inputFor(a),
    );
    expect(peerAccepted).toBe(true);
    expect(outcome).toMatchObject({
      code: "GRAPH_REVISION_PROJECT_HAS_ACTIVE",
      ok: false, refusedBy: "GRAPH_REVISION_ACTIVATION",
    });
    expect(readCurrentActiveGraph(a, PROJECT_ID)).toMatchObject({
      ok: true, revisionId: SECOND_GRAPH_REVISION_REF,
    });
  });

  it("observes the slot before reading the supersession facts", () => {
    const seeded = approvableStoreWithTwoGoals();
    const activated = activateApprovedGraph(
      contextFor(seeded, requestFor("cmd-slot-order-active")), inputFor(seeded),
    );
    if (!activated.ok) throw new Error(`fixture activation refused: ${activated.code}`);
    prepareSupersession(seeded);
    const { a, b } = twoHandles(seeded);
    let peerAccepted = false;
    const facade = slotReadFacade(a, () => {
      peerAccepted = supersedeActiveGraph(
        supersedeContext(b, "cmd-slot-order-peer"), supersedeInput(),
      ).ok;
    });
    const outcome = supersedeActiveGraph(
      supersedeContext(facade, "cmd-slot-order-primary"), supersedeInput(),
    );
    expect(peerAccepted).toBe(true);
    expect(outcome).toMatchObject({
      code: "GRAPH_SUPERSEDE_PREDECESSOR_MISMATCH",
      ok: false, refusedBy: "GRAPH_SUPERSEDE_SERVICE",
    });
  });

  it("builds one append event with the frozen slot vocabulary", () => {
    const aggregateId = activeGraphSlotAggregateId(PROJECT_ID);
    const leg = buildActiveGraphSlotLeg({
      commandId: "cmd-slot-contract", graphEpoch: 3,
      observed: { aggregateId, version: 4 }, projectId: PROJECT_ID,
      reason: "SUPERSEDE", revisionId: "graph-revision-contract",
    });
    expect(leg).toMatchObject({ aggregateId, expectedVersion: 4 });
    expect(leg.events).toHaveLength(1);
    const [event] = leg.events;
    if (event === undefined) throw new Error("slot builder emitted no event");
    expect({ eventId: event.eventId, eventType: event.eventType }).toStrictEqual({
      eventId: "cmd-slot-contract-slot", eventType: "ActiveGraphSlotAdvanced",
    });
    expect(JSON.parse(decoder.decode(event.payload))).toStrictEqual({
      graphEpoch: 3, reason: "SUPERSEDE",
      revisionAggregateId: `graph-revision:${PROJECT_ID}:graph-revision-contract`,
      revisionId: "graph-revision-contract",
    });
  });
});
