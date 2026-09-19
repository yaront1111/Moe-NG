import { afterEach, expect, it } from "vitest";
import { IdempotencyConflictError, SqliteEventStore } from "@moe/store";
import type { CommandDecisionKey } from "@moe/store";
import { FACT_SLOT_LIMIT, FACT_WRITE_ATTEMPTS, commitFactDecision, factSlotCommandId, findFactDecision } from "./decision-fact-slots.js";

const stores: SqliteEventStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const open = (): SqliteEventStore => { const store = SqliteEventStore.openEphemeralForProjectTest("p1"); stores.push(store); return store; };

const KIND = "internal.test.fact";
const KEY = { principalId: "daemon:fact-writer", projectId: "p1" } as const;
const AGG = "fact:goal-1";
const CANONICAL = "fact-canonical-1";
const encoder = new TextEncoder(); const decoder = new TextDecoder();
const slot = (n: number): string => factSlotCommandId(CANONICAL, n);
const draft = (body: string) => (commandId: string) => ({ commandKind: KIND, committedResultBytes: encoder.encode(body),
  correlationId: "fact-test", decidedAt: "2026-09-19T00:00:00.000Z",
  events: [{ eventId: `${commandId}-fact`, eventType: "FactRecorded", payload: encoder.encode(body) }],
  requestBytes: encoder.encode(body), targetAggregateId: AGG });
const eventTypes = (store: SqliteEventStore): string[] => store.readEvents(AGG).map((event) => event.eventType);
const lookup = (store: SqliteEventStore, commandId: string) => store.getCommandDecision({ ...KEY, commandId });

/** A decision another writer really committed on the shared aggregate, or one that lost a race when `behind`. */
function write(store: SqliteEventStore, key: CommandDecisionKey, commandKind: string, behind = false): void {
  store.commitExpectedVersionDecision({ commandKind, committedResultBytes: encoder.encode("{}"), correlationId: "peer",
    decidedAt: "2026-09-19T00:00:00.000Z", events: [{ eventId: `${key.commandId}-peer`, eventType: "Peer", payload: encoder.encode("{}") }],
    expectedVersion: store.getAggregateVersion(AGG) - (behind ? 1 : 0), key, requestBytes: encoder.encode("{}"), targetAggregateId: AGG });
}

/** The writer read the version before a peer committed: one behind for the first `times` reads, honest after. */
function racing(store: SqliteEventStore, times: number): SqliteEventStore {
  let left = times;
  return new Proxy(store, { get(target, key) {
    if (key === "getAggregateVersion") return (id: string) => {
      const version = target.getAggregateVersion(id); if (left <= 0) return version; left -= 1; return version - 1;
    };
    const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}

it("F1 keeps slot 0 on the canonical id and derives a distinct 64-hex id for every later slot", () => {
  expect(slot(0)).toBe(CANONICAL);
  // Durable keys: a changed derivation would orphan every fact already written at slot n > 0.
  expect([slot(1), slot(2)]).toEqual(["35ab660fba57021b53a924752d9e5051ae3a23469e0a8b101bd6bdd0289f2330",
    "476e25e6498aea9e37a803b30688cba3e8bffd403c35bb852ab33df0a0d0bae0"]);
  const other = [1, 2].map((n) => factSlotCommandId("fact-canonical-2", n));
  for (const id of other) expect(id).toMatch(/^[0-9a-f]{64}$/u);
  expect(new Set([CANONICAL, slot(1), slot(2), ...other]).size).toBe(5);
});

it("F2 moves a write that lost ONE race to the next slot, and reads the fact back there", () => {
  const store = open(); write(store, { ...KEY, commandId: "peer-1" }, "internal.test.peer");
  const response = commitFactDecision(racing(store, 1), KEY, CANONICAL, KIND, draft("fact-1"));
  expect([response.disposition, response.decision.effectDisposition, response.decision.key.commandId])
    .toEqual(["DECIDED", "EFFECTS_COMMITTED", slot(1)]);
  expect([lookup(store, CANONICAL)?.commandKind, lookup(store, CANONICAL)?.effectDisposition]).toEqual([KIND, "NO_BUSINESS_EFFECT"]);
  const found = findFactDecision(store, KEY, CANONICAL, KIND);
  expect(found).toEqual({ commandId: slot(1), record: lookup(store, slot(1)) });
  expect([found.record?.decisionId, decoder.decode(found.record?.resultBytes)]).toEqual([response.decision.decisionId, "fact-1"]);
  expect(eventTypes(store)).toEqual(["Peer", "FactRecorded"]);
});

it("F3 stops after FACT_WRITE_ATTEMPTS lost races, and an honest store then commits at the next free slot", () => {
  expect(FACT_WRITE_ATTEMPTS).toBe(3);
  const store = open(); write(store, { ...KEY, commandId: "peer-1" }, "internal.test.peer");
  const lost = commitFactDecision(racing(store, Number.POSITIVE_INFINITY), KEY, CANONICAL, KIND, draft("fact-1"));
  expect([lost.decision.effectDisposition, lost.decision.resultCode, lost.decision.key.commandId])
    .toEqual(["NO_BUSINESS_EFFECT", "EXPECTED_VERSION_CONFLICT", slot(2)]);
  expect([0, 1, 2, 3].map((n) => lookup(store, slot(n))?.effectDisposition ?? null))
    .toEqual(["NO_BUSINESS_EFFECT", "NO_BUSINESS_EFFECT", "NO_BUSINESS_EFFECT", null]);
  const healed = commitFactDecision(store, KEY, CANONICAL, KIND, draft("fact-1"));
  expect([healed.disposition, healed.decision.effectDisposition, healed.decision.key.commandId])
    .toEqual(["DECIDED", "EFFECTS_COMMITTED", slot(3)]);
  expect(eventTypes(store)).toEqual(["Peer", "FactRecorded"]);
});

it("F4 never skips a NO_BUSINESS_EFFECT record of ANOTHER kind: it answers that slot, which the caller then refuses", () => {
  const store = open(); write(store, { ...KEY, commandId: "peer-1" }, "internal.test.peer");
  write(store, { ...KEY, commandId: CANONICAL }, "internal.test.other", true);
  const found = findFactDecision(store, KEY, CANONICAL, KIND);
  expect([found.commandId, found.record?.commandKind, found.record?.effectDisposition])
    .toEqual([CANONICAL, "internal.test.other", "NO_BUSINESS_EFFECT"]);
});

it("F5 bounds the walk at FACT_SLOT_LIMIT lookups when every slot answers burned", () => {
  expect(FACT_SLOT_LIMIT).toBe(32);
  const store = open(); write(store, { ...KEY, commandId: "peer-1" }, "internal.test.peer");
  write(store, { ...KEY, commandId: CANONICAL }, KIND, true);
  const burned = lookup(store, CANONICAL); const asked: string[] = [];
  expect([burned?.commandKind, burned?.effectDisposition]).toEqual([KIND, "NO_BUSINESS_EFFECT"]);
  const allBurned = new Proxy(store, { get(target, key) {
    if (key === "getCommandDecision") return (decisionKey: CommandDecisionKey) => { asked.push(decisionKey.commandId); return burned; };
    const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const found = findFactDecision(allBurned, KEY, CANONICAL, KIND);
  expect(asked).toEqual(Array.from({ length: 32 }, (_, n) => slot(n)));
  expect(found).toEqual({ commandId: slot(31), record: burned });
});

it("F6 replays a true retry of the same fact bytes and appends nothing; different bytes still conflict", () => {
  const store = open();
  const first = commitFactDecision(store, KEY, CANONICAL, KIND, draft("fact-1"));
  const version = store.getAggregateVersion(AGG);
  const again = commitFactDecision(store, KEY, CANONICAL, KIND, draft("fact-1"));
  expect([again.disposition, again.decision.effectDisposition, again.decision.decisionId, again.decision.key.commandId])
    .toEqual(["REPLAYED", "EFFECTS_COMMITTED", first.decision.decisionId, CANONICAL]);
  expect([store.getAggregateVersion(AGG), eventTypes(store)]).toEqual([version, ["FactRecorded"]]);
  let thrown: unknown = null;
  try { commitFactDecision(store, KEY, CANONICAL, KIND, draft("fact-2")); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(IdempotencyConflictError);
  expect(thrown).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", key: { ...KEY, commandId: CANONICAL } });
});
