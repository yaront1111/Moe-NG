import { afterEach, expect, it } from "vitest";
import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { publicationRepositoryId } from "./publication-approval-contracts.js";
import { recordPublicationIntent } from "./publication-effect-ledger.js";
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
