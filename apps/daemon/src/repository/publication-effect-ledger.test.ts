import { afterEach, expect, it } from "vitest";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";
import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { publicationRepositoryId } from "./publication-approval-contracts.js";
import { PUBLICATION_TIP_UNREADABLE, readPublicationIntent, readPublicationObservation, readPublicationTransmission, recordPublicationIntent,
  recordPublicationObservation, recordPublicationTransmission } from "./publication-effect-ledger.js";
import type { PublicationObservation, PublicationTransmission } from "./publication-effect-ledger.js";
import type { PublicationEffectIntent } from "./publication-effect-contracts.js";
import { NODE_PUBLISHER_PRINCIPAL_ID } from "./publish-receipt-contracts.js";
afterEach(closeStores);
const identity = { root: "D:/publication", gitDirectory: "D:/publication/.git" };
const input: PublicationEffectIntent = { version: "moe-publication-intent/1", projectId: PROJECT_ID, goalId: "goal-1", decisionId: "decision-1",
  candidate: { identity, approval: { branch: "main", sha: "a".repeat(40), remoteUrl: "https://github.com/o/r.git", repositoryId: publicationRepositoryId(identity) } },
  ownerDigest: "b".repeat(64), controllerId: "controller-1", reservationRevision: 1, intendedAt: "2026-09-06T00:00:00.000Z" };
it("does not mint fresh effect authority when an absent pre-read races with an already committed intent", () => {
  const store = openStore(); expect(recordPublicationIntent(store, input).replayed).toBe(false);
  let firstRead = true;
  const racing = new Proxy(store, { get(target, key) {
    if (key === "getAggregateVersion") return () => 0;
    if (key === "getCommandDecision") return (...args: Parameters<typeof target.getCommandDecision>) => {
      if (firstRead) { firstRead = false; return null; } return target.getCommandDecision(...args);
    };
    const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  expect(recordPublicationIntent(racing, input)).toEqual({ intent: input, replayed: true });
});
it("refuses replay input that changes the approved tuple, owner, controller or revision", () => {
  const store = openStore(); recordPublicationIntent(store, input);
  for (const changed of [{ ...input, ownerDigest: "c".repeat(64) }, { ...input, controllerId: "other" },
    { ...input, reservationRevision: 2 }, { ...input, candidate: { ...input.candidate, approval: { ...input.candidate.approval, sha: "d".repeat(40) } } }]) {
    expect(() => recordPublicationIntent(store, changed)).toThrow("PUBLISH_INTENT_CONFLICT");
  }
});

const INTENT_KEYS = ["candidate", "controllerId", "decisionId", "goalId", "intendedAt", "ownerDigest", "projectId", "reservationRevision", "version"];
const encoder = new TextEncoder(); const decoder = new TextDecoder();
const sent = (decisionId: string, tipBefore: string | null, outcome: PublicationTransmission["outcome"]): PublicationTransmission =>
  ({ projectId: PROJECT_ID, goalId: "goal-1", decisionId, tipBefore, outcome, transmittedAt: "2026-09-06T00:00:01.000Z" });
const onGoal = (store: SqliteEventStore): readonly CommandDecisionRecord[] =>
  store.readCommandDecisionsAfter(0n, 200).items.filter((decision) => decision.targetAggregateId === "publish:goal-1");
const json = (decision: CommandDecisionRecord | undefined): Record<string, unknown> =>
  JSON.parse(decoder.decode(decision?.resultBytes)) as Record<string, unknown>;

it("records the one push's evidence and reads it back by value: every pre-push tip form with every push outcome", () => {
  const store = openStore(); let cases = 0;
  for (const tipBefore of ["c".repeat(40), "e".repeat(64), null, PUBLICATION_TIP_UNREADABLE]) {
    for (const outcome of ["ACCEPTED", "REJECTED", "INDETERMINATE"] as const) {
      const recorded = sent(`decision-${String(cases)}`, tipBefore, outcome);
      recordPublicationTransmission(store, recorded);
      expect(readPublicationTransmission(store, PROJECT_ID, "goal-1", recorded.decisionId)).toEqual(recorded);
      cases += 1;
    }
  }
  expect(cases).toBe(12);
  expect(readPublicationTransmission(store, PROJECT_ID, "goal-1", "decision-never-pushed")).toBeNull();
});

it("keeps the evidence as a SEPARATE event beside the intent and leaves the intent's bytes untouched", () => {
  const store = openStore(); recordPublicationIntent(store, input);
  const before = onGoal(store)[0]?.resultBytes;
  recordPublicationTransmission(store, sent("decision-1", "c".repeat(40), "REJECTED"));
  const decisions = onGoal(store);
  expect(decisions.map((decision) => decision.commandKind))
    .toEqual(["internal.repository.publication_intent", "internal.repository.publication_transmission"]);
  expect(decisions[0]?.resultBytes).toEqual(before);
  expect(store.readEvents("publish:goal-1").map((event) => event.eventType))
    .toEqual(["RepositoryPublicationIntended", "RepositoryPublicationTransmitted"]);
  expect(readPublicationIntent(store, PROJECT_ID, "goal-1", "decision-1")).toEqual(input);
});

it("HAZARD: an intent in today's exact moe-publication-intent/1 shape, with no evidence beside it, still decodes and has no evidence", () => {
  const store = openStore(); recordPublicationIntent(store, input);
  const stored = json(onGoal(store)[0]);
  expect(Object.keys(stored).sort()).toEqual(INTENT_KEYS);
  expect(stored["version"]).toBe("moe-publication-intent/1");
  expect(readPublicationIntent(store, PROJECT_ID, "goal-1", "decision-1")).toEqual(input);
  expect(readPublicationTransmission(store, PROJECT_ID, "goal-1", "decision-1")).toBeNull();
});

it("reads a malformed transmission record as ABSENT, so bad evidence can never resolve a publish", () => {
  const store = openStore(); const recorded = sent("decision-1", "c".repeat(40), "REJECTED");
  recordPublicationTransmission(store, recorded);
  const good = json(onGoal(store)[0]); const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));
  const { tipBefore: _dropped, ...withoutTip } = good;
  const tampered = (change: (record: CommandDecisionRecord) => unknown) => new Proxy(store, { get(target, key) {
    if (key === "getCommandDecision") return (...args: Parameters<typeof target.getCommandDecision>) => {
      const record = target.getCommandDecision(...args); return record === null ? null : change(record);
    };
    const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  expect(readPublicationTransmission(tampered((record) => record), PROJECT_ID, "goal-1", "decision-1")).toEqual(recorded);
  const changes: ((record: CommandDecisionRecord) => unknown)[] = [
    (record) => ({ ...record, resultBytes: bytes({ ...good, extra: true }) }),
    (record) => ({ ...record, resultBytes: bytes(withoutTip) }),
    (record) => ({ ...record, resultBytes: bytes({ ...good, tipBefore: "not-a-sha" }) }),
    (record) => ({ ...record, resultBytes: bytes({ ...good, tipBefore: "C".repeat(40) }) }),
    (record) => ({ ...record, resultBytes: bytes({ ...good, outcome: "MAYBE" }) }),
    (record) => ({ ...record, resultBytes: bytes({ ...good, decisionId: "decision-2" }) }),
    (record) => ({ ...record, resultBytes: bytes({ ...good, goalId: "goal-2" }) }),
    (record) => ({ ...record, resultBytes: bytes({ ...good, version: "moe-publication-transmission/2" }) }),
    (record) => ({ ...record, resultBytes: encoder.encode("not json") }),
    (record) => ({ ...record, commandKind: "internal.repository.publication_intent" }),
    (record) => ({ ...record, effectDisposition: "NO_BUSINESS_EFFECT" }),
    (record) => ({ ...record, targetAggregateId: "publish:goal-2" }),
    (record) => ({ ...record, decidedAt: "2026-09-06T00:00:02.000Z" }),
  ];
  for (const change of changes) expect(readPublicationTransmission(tampered(change), PROJECT_ID, "goal-1", "decision-1")).toBeNull();
  expect(changes).toHaveLength(13);
});

const seen = (decisionId: string, observedSha: string | null, observedAt: string): PublicationObservation =>
  ({ projectId: PROJECT_ID, goalId: "goal-1", decisionId, observedSha, expectedSha: "a".repeat(40), reason: "REJECTED", observedAt });
const observations = (store: SqliteEventStore): number =>
  store.readEvents("publish:goal-1").filter((event) => event.eventType === "RepositoryPublicationObserved").length;
const latest = (store: SqliteEventStore, decisionId = "decision-1") => readPublicationObservation(store, PROJECT_ID, "goal-1", decisionId);

it("records an observation only when it CHANGES and reads back the latest one by value", () => {
  const store = openStore(); const first = seen("decision-1", "c".repeat(40), "2026-09-06T00:00:02.000Z");
  expect(latest(store)).toBeNull();
  recordPublicationObservation(store, first);
  for (const observedAt of ["2026-09-06T00:00:03.000Z", "2026-09-06T00:00:04.000Z"]) recordPublicationObservation(store, { ...first, observedAt });
  expect(observations(store)).toBe(1);
  expect(latest(store)).toEqual(first);
  const absent = seen("decision-1", null, "2026-09-06T00:00:05.000Z");
  recordPublicationObservation(store, absent);
  expect(observations(store)).toBe(2);
  expect(latest(store)).toEqual(absent);
  // Back to the first observation, byte for byte: a change against the latest, so a new write, never a replay of the first.
  recordPublicationObservation(store, first);
  expect(observations(store)).toBe(3);
  expect(latest(store)).toEqual(first);
  recordPublicationObservation(store, { ...first, reason: "INDETERMINATE" });
  recordPublicationObservation(store, { ...first, reason: "INDETERMINATE", expectedSha: "d".repeat(40) });
  expect(observations(store)).toBe(5);
  expect(latest(store)).toEqual({ ...first, reason: "INDETERMINATE", expectedSha: "d".repeat(40) });
  expect(latest(store, "decision-2")).toBeNull();
  expect(readPublicationObservation(store, "project-other", "goal-1", "decision-1")).toBeNull();
});

it("keeps each decision's observations apart: the same tip under another decision is its own first observation", () => {
  const store = openStore(); const first = seen("decision-1", "c".repeat(40), "2026-09-06T00:00:02.000Z");
  recordPublicationObservation(store, first);
  recordPublicationObservation(store, { ...first, decisionId: "decision-2" });
  recordPublicationObservation(store, first);
  expect(observations(store)).toBe(2);
  expect(latest(store)).toEqual(first);
  expect(latest(store, "decision-2")).toEqual({ ...first, decisionId: "decision-2" });
});

it("HAZARD: the intent and the transmission decode unchanged with an observation beside them", () => {
  const store = openStore(); recordPublicationIntent(store, input);
  const recorded = sent("decision-1", "c".repeat(40), "REJECTED"); recordPublicationTransmission(store, recorded);
  const before = onGoal(store).map((decision) => decision.resultBytes);
  recordPublicationObservation(store, seen("decision-1", "c".repeat(40), "2026-09-06T00:00:02.000Z"));
  const decisions = onGoal(store);
  expect(decisions.map((decision) => decision.commandKind)).toEqual(["internal.repository.publication_intent",
    "internal.repository.publication_transmission", "internal.repository.publication_observation"]);
  expect(decisions.slice(0, 2).map((decision) => decision.resultBytes)).toEqual(before);
  expect(Object.keys(json(decisions[0])).sort()).toEqual(INTENT_KEYS);
  expect(readPublicationIntent(store, PROJECT_ID, "goal-1", "decision-1")).toEqual(input);
  expect(readPublicationTransmission(store, PROJECT_ID, "goal-1", "decision-1")).toEqual(recorded);
});

it("never writes an observation it could not read back, and writes nothing when the aggregate is unreadable", () => {
  const store = openStore(); const first = seen("decision-1", "c".repeat(40), "2026-09-06T00:00:02.000Z");
  for (const bad of [{ ...first, observedSha: "not-a-sha" }, { ...first, expectedSha: "C".repeat(40) },
    { ...first, reason: "MAYBE" as PublicationObservation["reason"] }, { ...first, observedAt: "" }]) recordPublicationObservation(store, bad);
  expect(observations(store)).toBe(0);
  const blind = new Proxy(store, { get(target, key) {
    if (key === "readEvents") return () => { throw new Error("STORE_READ_LIMIT_EXCEEDED"); };
    const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  expect(readPublicationObservation(blind, PROJECT_ID, "goal-1", "decision-1")).toBeNull();
  expect(() => recordPublicationObservation(blind, first)).toThrow("STORE_READ_LIMIT_EXCEEDED");
  expect(observations(store)).toBe(0);
});

/** The writer read publish:goal-1's version before a peer committed: one behind ONCE, honest after (task-978669b6). */
const racingOnce = (store: SqliteEventStore): SqliteEventStore => {
  let raced = false;
  return new Proxy(store, { get(target, key) {
    if (key === "getAggregateVersion") return (id: string) => {
      const version = target.getAggregateVersion(id); if (raced) return version; raced = true; return version - 1;
    };
    const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
};
const peerObserves = (store: SqliteEventStore): void => recordPublicationObservation(store, seen("decision-1", "c".repeat(40), "2026-09-06T00:00:02.000Z"));

it("E1 an intent write that loses ONE version race lands at the next slot and reads back by value", () => {
  const store = openStore(); peerObserves(store);
  expect(recordPublicationIntent(racingOnce(store), input)).toEqual({ intent: input, replayed: false });
  expect(readPublicationIntent(store, PROJECT_ID, "goal-1", "decision-1")).toEqual(input);
  expect(onGoal(store).map((decision) => [decision.commandKind, decision.effectDisposition])).toEqual([
    ["internal.repository.publication_observation", "EFFECTS_COMMITTED"], ["internal.repository.publication_intent", "NO_BUSINESS_EFFECT"],
    ["internal.repository.publication_intent", "EFFECTS_COMMITTED"]]);
});

it("E2 heals an intent key the OLD code already burned: it reads as absent, and the next write commits", () => {
  const scratch = openStore(); recordPublicationIntent(scratch, input);
  const canonical = onGoal(scratch)[0]?.key.commandId ?? ""; // where every intent written before the fix lives
  expect(canonical).toMatch(/^[0-9a-f]{64}$/u);
  const store = openStore(); peerObserves(store); const bytes = encoder.encode(JSON.stringify(input));
  // What the old recordPublicationIntent persisted when its version read lost the race.
  store.commitExpectedVersionDecision({ commandKind: "internal.repository.publication_intent", committedResultBytes: bytes,
    correlationId: "publication-intent", decidedAt: input.intendedAt,
    events: [{ eventId: `${canonical}-intended`, eventType: "RepositoryPublicationIntended", payload: encoder.encode("{}") }],
    expectedVersion: store.getAggregateVersion("publish:goal-1") - 1,
    key: { commandId: canonical, principalId: NODE_PUBLISHER_PRINCIPAL_ID, projectId: PROJECT_ID }, requestBytes: bytes, targetAggregateId: "publish:goal-1" });
  expect(onGoal(store).map((decision) => [decision.key.commandId, decision.effectDisposition]).at(-1)).toEqual([canonical, "NO_BUSINESS_EFFECT"]);
  expect(readPublicationIntent(store, PROJECT_ID, "goal-1", "decision-1")).toBeNull();
  expect(recordPublicationIntent(store, input)).toEqual({ intent: input, replayed: false });
  expect(readPublicationIntent(store, PROJECT_ID, "goal-1", "decision-1")).toEqual(input);
});

it("E3 a transmission write that loses ONE version race lands at the next slot and reads back by value", () => {
  const store = openStore(); recordPublicationIntent(store, input);
  const recorded = sent("decision-1", "c".repeat(40), "REJECTED");
  recordPublicationTransmission(racingOnce(store), recorded);
  expect(readPublicationTransmission(store, PROJECT_ID, "goal-1", "decision-1")).toEqual(recorded);
  expect(onGoal(store).map((decision) => [decision.commandKind, decision.effectDisposition]).slice(1)).toEqual([
    ["internal.repository.publication_transmission", "NO_BUSINESS_EFFECT"], ["internal.repository.publication_transmission", "EFFECTS_COMMITTED"]]);
});
