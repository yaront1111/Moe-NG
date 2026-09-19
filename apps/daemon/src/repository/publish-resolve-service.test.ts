import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStoreError, type SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readRunGoalPublication } from "../http/run-goal-publication.js";
import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { publicationRepositoryId } from "./publication-approval-contracts.js";
import type { PublicationCandidate } from "./publication-approval-contracts.js";
import { publicationOwnerDigest, recordPublicationIntent, recordPublicationObservation } from "./publication-effect-ledger.js";
import { readPublishLedger, recordPublishReceipt } from "./publish-ledger.js";
import { REPOSITORY_PUBLISH_COMMAND_KIND, publishAggregateId } from "./publish-receipt-contracts.js";
import { PUBLISH_RESOLVED_CODES, isPublishResolvedCode, resolvePublish } from "./publish-resolve-service.js";
import type { PublishResolution } from "./publish-resolve-service.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import { createRepositoryExecutionPort } from "./repository-execution-port.js";

const GOAL = "goal-resolve-1";
const NOW = "2026-09-19T08:00:00.000Z";
const LATER = "2026-09-19T08:05:00.000Z";
const FOREIGN = "c".repeat(40);
const identity = { root: "D:/ws", gitDirectory: "D:/ws/.git" };
const approval = { branch: "approved-branch", sha: "a".repeat(40), remoteUrl: "https://github.com/o/r.git",
  repositoryId: publicationRepositoryId(identity) };
const candidate: PublicationCandidate = { approval, identity };
const encoder = new TextEncoder();
const LAYER = "DAEMON_PREREQUISITE";

// THE OWNING CONTROLLER'S HOLD, on a REAL repository so every arm can prove the persisted
// reservation is untouched: the command never reaches the port, however it might try.
const port = createRepositoryExecutionPort();
let root = "";
let hold: RepositoryExecutionHandle;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "moe-publish-resolve-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root, shell: false, windowsHide: true });
  const owner = { projectId: PROJECT_ID, nodeRef: "publish:held", ownershipToken: "d".repeat(64), storeId: "D:/store.db" };
  const acquired = port.acquire(root, owner, { controllerId: "wrapper-controller", controllerPid: 4242 });
  if (!acquired.ok) throw new Error(acquired.code);
  const moved = port.transition(root, owner, acquired.handle.reservation.revision,
    { controllerId: "wrapper-controller", controllerPid: 4242, phase: "PUBLISHING", baselineId: null, sessionId: null, pid: null });
  if (!moved.ok) throw new Error(moved.code);
  hold = moved.handle;
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
afterEach(closeStores);

function decide(store: SqliteEventStore, commandId: string): string {
  const aggregateId = publishAggregateId(GOAL);
  return store.commitExpectedVersionDecision({ commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: encoder.encode(JSON.stringify({ candidate, goalId: GOAL, remoteUrl: approval.remoteUrl })),
    correlationId: "test-publish", decidedAt: NOW,
    events: [{ eventId: `${commandId}-requested`, eventType: "RepositoryPublishRequested", payload: encoder.encode("{}") }],
    expectedVersion: store.getAggregateVersion(aggregateId), key: { commandId, principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: encoder.encode("{}"), targetAggregateId: aggregateId }).decision.decisionId;
}
/** A decision whose push is UNKNOWN: approved, and its intent journaled under the wrapper's hold. */
function unknownPublish(store: SqliteEventStore): string {
  const decisionId = decide(store, "publish-1");
  recordPublicationIntent(store, { version: "moe-publication-intent/1", candidate, decisionId, goalId: GOAL, projectId: PROJECT_ID,
    ownerDigest: publicationOwnerDigest(hold.owner), reservationRevision: hold.reservation.revision,
    controllerId: "wrapper-controller", intendedAt: NOW });
  return decisionId;
}
const observe = (store: SqliteEventStore, decisionId: string, observedSha: string | null, observedAt = NOW) =>
  recordPublicationObservation(store, { projectId: PROJECT_ID, goalId: GOAL, decisionId, observedSha, expectedSha: approval.sha,
    reason: "REJECTED", observedAt });
const resolve = (store: SqliteEventStore, decisionId: string, resolution: PublishResolution) =>
  resolvePublish(store, { projectId: PROJECT_ID, decisionId, resolution, decidedAt: LATER });
const receipts = (store: SqliteEventStore) => readPublishLedger(store, PROJECT_ID).get(GOAL)?.receipts ?? new Map();
const refusedEvents = (store: SqliteEventStore) =>
  store.readEvents(publishAggregateId(GOAL)).filter((event) => event.eventType === "RepositoryPublishRefused").length;
const card = (store: SqliteEventStore) => readRunGoalPublication(store, PROJECT_ID, readPublishLedger(store, PROJECT_ID).get(GOAL));
/** The owning controller's hold exactly as the fixture left it: still PUBLISHING, same revision, same controller. */
const expectHoldUntouched = () => expect(port.inspect(root)).toEqual({ ok: true, reservation: hold.reservation });

describe("repository.publish_resolve refuses what it cannot truthfully resolve, writing nothing", () => {
  it("refuses a decision id that names no publish request", () => {
    const store = openStore(); unknownPublish(store);
    expect(resolve(store, "decision-nobody-made", "ABANDON")).toStrictEqual({ ok: false, layer: LAYER,
      code: "PUBLISH_RESOLVE_DECISION_NOT_FOUND", detail: "no publish request has this decision id" });
    expect(receipts(store).size).toBe(0); expect(refusedEvents(store)).toBe(0); expectHoldUntouched();
  });
  it("refuses a decision that already has a receipt, PUSHED or REFUSED, and leaves that receipt as it was", () => {
    // The last case never journaled an intent (a legacy PUBLISH_APPROVAL_REQUIRED): the receipt answers first, as on the card.
    const settled = [{ refusal: null, outcome: "PUSHED", intent: true },
      { refusal: { code: "PUBLISH_NOT_LANDED", detail: "git refused" }, outcome: "REFUSED", intent: true },
      { refusal: { code: "PUBLISH_APPROVAL_REQUIRED", detail: "PUBLISH_APPROVAL_REQUIRED" }, outcome: "REFUSED", intent: false }] as const;
    for (const { refusal, outcome, intent } of settled) {
      const store = openStore(); const decisionId = intent ? unknownPublish(store) : decide(store, "publish-1");
      recordPublishReceipt(store, { branch: approval.branch, decidedAt: NOW, decisionId, goalId: GOAL, projectId: PROJECT_ID, refusal,
        remoteUrl: approval.remoteUrl, sha: approval.sha, url: null });
      const before = receipts(store).get(decisionId);
      expect(before).toMatchObject({ outcome });
      expect(resolve(store, decisionId, "NOT_TRANSMITTED")).toStrictEqual({ ok: false, layer: LAYER,
        code: "PUBLISH_RESOLVE_NOT_UNKNOWN", detail: `the publish already has a ${outcome} receipt` });
      expect(receipts(store).get(decisionId)).toEqual(before); expect(receipts(store).size).toBe(1); expectHoldUntouched();
    }
    expect(settled).toHaveLength(3);
  });
  it("refuses a decision that never journaled an intent: nothing was attempted, so nothing is unknown", () => {
    const store = openStore(); const decisionId = decide(store, "publish-1");
    expect(resolve(store, decisionId, "ABANDON")).toStrictEqual({ ok: false, layer: LAYER,
      code: "PUBLISH_RESOLVE_NOT_UNKNOWN", detail: "the publish never journaled an intent: nothing was attempted" });
    expect(receipts(store).size).toBe(0); expect(refusedEvents(store)).toBe(0); expectHoldUntouched();
  });
  it("refuses NOT_TRANSMITTED when the latest observation shows the remote at the approved sha: the double-transmission guard", () => {
    const store = openStore(); const decisionId = unknownPublish(store);
    observe(store, decisionId, FOREIGN); observe(store, decisionId, approval.sha, LATER);
    expect(resolve(store, decisionId, "NOT_TRANSMITTED")).toStrictEqual({ ok: false, layer: LAYER, code: "PUBLISH_RESOLVE_REMOTE_HOLDS_SHA",
      detail: `the latest observation (${LATER}) shows the remote at the approved ${approval.sha}: the push landed` });
    expect(receipts(store).size).toBe(0); expect(refusedEvents(store)).toBe(0); expectHoldUntouched();
    expect(card(store)).toMatchObject({ outcome: "UNKNOWN", decisionId });
  });
});

describe("repository.publish_resolve records the operator's resolution as ONE REFUSED receipt, and nothing else", () => {
  const detailOf = (resolution: PublishResolution, seen: string) => `the operator resolved this publish as ${resolution}; ${seen}`;
  it("NOT_TRANSMITTED carries the LATEST observation, flips the card to REFUSED, and never touches the owner's hold", () => {
    const store = openStore(); const decisionId = unknownPublish(store);
    observe(store, decisionId, FOREIGN); observe(store, decisionId, null, LATER);
    expect(card(store)).toMatchObject({ outcome: "UNKNOWN", decisionId, observation: { observedSha: null } });
    const resolved = resolve(store, decisionId, "NOT_TRANSMITTED");
    const detail = detailOf("NOT_TRANSMITTED", `last observation ${LATER}: remote tip absent, expected ${approval.sha}, push REJECTED`);
    expect(resolved).toMatchObject({ ok: true, replayed: false, receipt: { outcome: "REFUSED", decisionId, goalId: GOAL,
      branch: approval.branch, sha: approval.sha, remoteUrl: approval.remoteUrl, url: null, decidedAt: LATER,
      refusal: { code: "PUBLISH_RESOLVED_NOT_TRANSMITTED", detail } } });
    expect(receipts(store).get(decisionId)).toEqual(resolved.ok ? resolved.receipt : null);
    expect(receipts(store).size).toBe(1); expect(refusedEvents(store)).toBe(1);
    // The receipt settles the card at once; a resolved publish shows no observation any more.
    expect(card(store)).toMatchObject({ outcome: "REFUSED", code: "PUBLISH_RESOLVED_NOT_TRANSMITTED", decisionId, observation: null });
    expectHoldUntouched();
  });
  it("ABANDON is allowed even against an observation at the approved sha, and says when nothing was observed", () => {
    const cases: [boolean, string][] = [[true, `last observation ${NOW}: remote tip ${approval.sha}, expected ${approval.sha}, push REJECTED`],
      [false, "no observation of the remote was recorded"]];
    for (const [observed, seen] of cases) {
      const store = openStore(); const decisionId = unknownPublish(store);
      if (observed) observe(store, decisionId, approval.sha);
      expect(resolve(store, decisionId, "ABANDON")).toMatchObject({ ok: true,
        receipt: { outcome: "REFUSED", decisionId, refusal: { code: "PUBLISH_RESOLVED_ABANDON", detail: detailOf("ABANDON", seen) } } });
      expect(refusedEvents(store)).toBe(1); expect(card(store)).toMatchObject({ outcome: "REFUSED", code: "PUBLISH_RESOLVED_ABANDON" });
      expectHoldUntouched();
    }
    expect(cases).toHaveLength(2);
  });
  it("names exactly its two receipt codes, which no other writer uses", () => {
    expect(PUBLISH_RESOLVED_CODES).toStrictEqual({ ABANDON: "PUBLISH_RESOLVED_ABANDON", NOT_TRANSMITTED: "PUBLISH_RESOLVED_NOT_TRANSMITTED" });
    expect(["PUBLISH_RESOLVED_ABANDON", "PUBLISH_RESOLVED_NOT_TRANSMITTED"].map(isPublishResolvedCode)).toEqual([true, true]);
    expect(["PUBLISH_NOT_LANDED", "PUBLISH_REMOTE_DIVERGED", "PUBLISH_APPROVAL_REQUIRED", "PUBLISH_RESOLVE_NOT_UNKNOWN", ""]
      .map(isPublishResolvedCode)).toEqual([false, false, false, false, false]);
  });
  it("answers NOT_UNKNOWN when the publisher's receipt lands between its read and its write, leaving that receipt as it was", () => {
    const real = openStore(); const decisionId = unknownPublish(real);
    const pushed = recordPublishReceipt(real, { branch: approval.branch, decidedAt: NOW, decisionId, goalId: GOAL, projectId: PROJECT_ID,
      refusal: null, remoteUrl: approval.remoteUrl, sha: approval.sha, url: null });
    // The ledger walk runs BEFORE the publisher's receipt commits: it cannot see it, the receipt write then can.
    const store = new Proxy(real, { get(target, key) {
      if (key === "readCommandDecisionsAfter") return (...args: Parameters<SqliteEventStore["readCommandDecisionsAfter"]>) => {
        const page = target.readCommandDecisionsAfter(...args);
        return { ...page, items: page.items.filter((item) => item.commandKind !== "internal.repository.publish_receipt") };
      };
      const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(resolve(store, decisionId, "NOT_TRANSMITTED")).toStrictEqual({ ok: false, layer: LAYER,
      code: "PUBLISH_RESOLVE_NOT_UNKNOWN", detail: "the publish already has a PUSHED receipt" });
    expect(receipts(real).get(decisionId)).toEqual(pushed.ok ? pushed.receipt : null); expect(refusedEvents(real)).toBe(0); expectHoldUntouched();
  });
  it("fails closed on the store's own code when the receipt cannot be committed, recording nothing", () => {
    const real = openStore(); const decisionId = unknownPublish(real);
    const store = new Proxy(real, { get(target, key) {
      if (key === "commitExpectedVersionDecision") return () => ({ decision: { effectDisposition: "REJECTED_EXPECTED_VERSION" } });
      const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    let thrown: unknown = null;
    try { resolve(store, decisionId, "ABANDON"); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DurableStoreError);
    expect(thrown).toMatchObject({ code: "EXPECTED_VERSION_CONFLICT", message: "EXPECTED_VERSION_CONFLICT: the resolve receipt was not recorded: EXPECTED_VERSION_CONFLICT" });
    expect(receipts(real).size).toBe(0); expect(card(real)).toMatchObject({ outcome: "UNKNOWN" }); expectHoldUntouched();
  });
});
