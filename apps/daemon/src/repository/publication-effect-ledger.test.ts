import { afterEach, expect, it } from "vitest";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";
import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { publicationRepositoryId } from "./publication-approval-contracts.js";
import { PUBLICATION_TIP_UNREADABLE, readPublicationIntent, readPublicationTransmission, recordPublicationIntent,
  recordPublicationTransmission } from "./publication-effect-ledger.js";
import type { PublicationTransmission } from "./publication-effect-ledger.js";
import type { PublicationEffectIntent } from "./publication-effect-contracts.js";
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
