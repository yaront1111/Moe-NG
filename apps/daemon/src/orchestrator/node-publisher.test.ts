import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SqliteEventStore } from "@moe/store";
import { readRunGoalPublication } from "../http/run-goal-publication.js";
import { landingEnvironment, nodeGitRunner } from "../repository/git-landing-port.js";
import { createGitPublicationPort, publicationGitRunner } from "../repository/git-publication-port.js";
import { publicationRepositoryId } from "../repository/publication-approval-contracts.js";
import type { PublicationCandidate, PublicationRefusal } from "../repository/publication-approval-contracts.js";
import { createPublicationCandidateReader } from "../repository/publication-candidate.js";
import type { PublicationGitPort } from "../repository/publication-effect-contracts.js";
import { publicationOwnerDigest, readPublicationObservation, readPublicationTransmission, recordPublicationIntent } from "../repository/publication-effect-ledger.js";
import type { PublicationTransmission } from "../repository/publication-effect-ledger.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import type { RepositoryExecutionHandle, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { readPublishLedger, recordPublishReceipt } from "../repository/publish-ledger.js";
import { REPOSITORY_PUBLISH_COMMAND_KIND, publishAggregateId, remoteAggregateId } from "../repository/publish-receipt-contracts.js";
import { PUBLISH_RESOLVED_CODES, resolvePublish, type PublishResolution } from "../repository/publish-resolve-service.js";
import { readRemoteDefaultBranch } from "../repository/remote-default-branch.js";
import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { createNodePublisher } from "./node-publisher.js";
afterEach(closeStores);
const GOAL = "goal-publisher-1";
const encoder = new TextEncoder();
function world() {
  const store = openStore(); const remoteUrl = "https://github.com/o/r.git";
  const aggregateId = publishAggregateId(GOAL);
  const result = { goalId: GOAL, remoteUrl, requestedAt: "2026-09-03T12:00:00.000Z" };
  const response = store.commitExpectedVersionDecision({ commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: encoder.encode(JSON.stringify(result)), correlationId: "test-publish",
    decidedAt: "2026-09-03T12:00:00.000Z", events: [{ eventId: "old-requested", eventType: "RepositoryPublishRequested", payload: encoder.encode("{}") }],
    expectedVersion: store.getAggregateVersion(aggregateId), key: { commandId: "old-publish", principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: encoder.encode("{}"), targetAggregateId: aggregateId });
  let pushes = 0;
  const git: PublicationGitPort = { async push() { pushes += 1; throw new Error("unbound request must not push"); },
    async observe() { throw new Error("unbound request must not query remote"); },
    async contains() { throw new Error("unbound request must not query remote"); } };
  return { store, decisionId: response.decision.decisionId, pushes: () => pushes,
    config: { git, projectId: PROJECT_ID, store, workspace: "D:/ws", repository: createRepositoryExecutionPort(),
      storeId: "D:/store", controller: { controllerId: "legacy-test", controllerPid: process.pid } } };
}

describe("legacy publication migration", () => {
  it("records an unbound old decision as refused without choosing today's HEAD or querying a remote", async () => {
    const w = world(); const publisher = createNodePublisher(w.config);
    expect(await publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "REFUSED", detail: "PUBLISH_APPROVAL_REQUIRED" }]);
    expect(w.pushes()).toBe(0);
    expect(readPublishLedger(w.store, PROJECT_ID).get(GOAL)?.receipts.get(w.decisionId))
      .toMatchObject({ outcome: "REFUSED", sha: null, branch: null, refusal: { code: "PUBLISH_APPROVAL_REQUIRED" } });
    expect(await publisher.publishOnce()).toEqual([]); expect(w.pushes()).toBe(0);
  });
  it("reports an unconfigured workspace without recording or performing an effect", async () => {
    const w = world();
    expect(await createNodePublisher({ ...w.config, workspace: null }).publishOnce())
      .toEqual([{ detail: "MOE_NODE_WORKSPACE is not set", goalId: GOAL, outcome: "WORKSPACE_UNSET" }]);
    expect(w.pushes()).toBe(0); expect(readPublishLedger(w.store, PROJECT_ID).get(GOAL)?.receipts.size).toBe(0);
  });
});

const identity = { root: "D:/ws", gitDirectory: "D:/ws/.git" };
const approval = { branch: "approved-branch", sha: "a".repeat(40), remoteUrl: "https://github.com/o/r.git", repositoryId: publicationRepositoryId(identity) };
const candidate: PublicationCandidate = { approval, identity };
const BEFORE = "b".repeat(40); const FOREIGN = "c".repeat(40); const NOW = "2026-09-18T12:00:00.000Z";
const CONTROLLER = { controllerId: "controller-1", controllerPid: 1234 };
const REJECTED = { ok: false, code: "PUBLISH_PUSH_REJECTED", detail: "PUBLISH_PUSH_REJECTED" } as const;
const REPLAY = "no push this pass (an intent was already journaled)";
/** The UNKNOWN of a pass whose remote is not at the approved sha: it names the tip it read and what the pass sent. */
const STUCK = (tip: string | null, pass: string) => [{ goalId: GOAL, outcome: "UNKNOWN", detail: "PUBLISH_EFFECT_RECONCILIATION_REQUIRED: "
  + `remote ${approval.branch} is at ${tip === null ? "absent" : tip.slice(0, 10)}, expected ${approval.sha.slice(0, 10)}; ${pass}` }];
const PUSH_REJECTED = "push refused PUBLISH_PUSH_REJECTED: PUBLISH_PUSH_REJECTED";
const NOT_LANDED = (sha: string, branch: string, before: string, after: string) =>
  `git refused the push of ${sha} to ${branch}; the remote tip was ${before} before the push and is ${after} after it`;
const sent = (decisionId: string, tipBefore: string | null, outcome: PublicationTransmission["outcome"]): PublicationTransmission =>
  ({ projectId: PROJECT_ID, goalId: GOAL, decisionId, tipBefore, outcome, transmittedAt: NOW });

function decide(store: SqliteEventStore, commandId: string, bound: PublicationCandidate = candidate, goalId = GOAL): string {
  const aggregateId = publishAggregateId(goalId);
  return store.commitExpectedVersionDecision({ commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: encoder.encode(JSON.stringify({ candidate: bound, goalId, remoteUrl: bound.approval.remoteUrl })),
    correlationId: "test-publish", decidedAt: NOW,
    events: [{ eventId: `${commandId}-requested`, eventType: "RepositoryPublishRequested", payload: encoder.encode("{}") }],
    expectedVersion: store.getAggregateVersion(aggregateId), key: { commandId, principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: encoder.encode("{}"), targetAggregateId: aggregateId }).decision.decisionId;
}
/** An in-memory repository hold that records every release reason and can refuse the next release once. */
function fence() {
  let held: RepositoryExecutionHandle | null = null; const releases: string[] = []; let refuse = false;
  const port: RepositoryExecutionPort = {
    acquire: (_ws, owner, controller) => {
      if (held !== null) return { ok: false, code: "REPOSITORY_EXECUTION_BUSY", detail: "REPOSITORY_EXECUTION_BUSY" };
      held = { owner, reservation: { ...owner, ...controller, identity, phase: "RESERVED", baselineId: null, sessionId: null, pid: null, revision: 1 } };
      return { ok: true, handle: held };
    },
    inspect: () => ({ ok: true, reservation: held?.reservation ?? null }),
    readOwned: () => ({ ok: true, handle: held }),
    claimController: () => { throw new Error("no controller takeover in these arms"); },
    transition: (_ws, owner, revision, state) => {
      if (held === null || held.owner !== owner || held.reservation.revision !== revision) throw new Error("stale transition");
      held = { ...held, reservation: { ...held.reservation, ...state, revision: revision + 1 } }; return { ok: true, handle: held };
    },
    release: (_ws, owner, revision, reason) => {
      if (held === null || held.owner !== owner || held.reservation.revision !== revision) throw new Error("stale release");
      if (refuse) { refuse = false; return { ok: false, code: "REPOSITORY_EXECUTION_REVISION_CONFLICT", detail: "REPOSITORY_EXECUTION_REVISION_CONFLICT" }; }
      releases.push(reason); held = null; return { ok: true, released: true };
    },
  };
  return { port, releases, phase: () => held?.reservation.phase ?? null, refuseNextRelease: () => { refuse = true; } };
}
type Measurement = Readonly<{ ok: true; defaultBranch: string | null }> | PublicationRefusal;
type Remote = { tip: string | null; pushes: number; observes: number; measures: number; unreadableFirst: boolean; blind: boolean;
  onPush: (remote: Remote) => Readonly<{ ok: true }> | PublicationRefusal; onMeasure: ((remote: Remote) => Measurement) | null };
/** One approved decision against a scripted remote whose branch starts at BEFORE. A null `onMeasure` is a port that cannot measure at all;
 *  `faulted` wraps the store the publisher writes through (every read helper below reads the real one); `earlier` writes first. */
function evidenceWorld(onPush: Remote["onPush"], onMeasure: Remote["onMeasure"] = null,
  faulted: (store: SqliteEventStore) => SqliteEventStore = (store) => store, earlier: (store: SqliteEventStore) => void = () => undefined) {
  const store = openStore(); earlier(store); const decisionId = decide(store, "publish-1"); const repository = fence();
  const remote: Remote = { tip: BEFORE, pushes: 0, observes: 0, measures: 0, unreadableFirst: false, blind: false, onPush, onMeasure };
  const git: PublicationGitPort = {
    ...(onMeasure === null ? {} : { async measureDefaultBranch(given: PublicationCandidate): Promise<Measurement> {
      expect(given).toEqual(candidate); remote.measures += 1;
      const answer = remote.onMeasure; if (answer === null) throw new Error("no measurement scripted");
      return answer(remote);
    } }),
    async push(given) { expect(given).toEqual(candidate); remote.pushes += 1; return remote.onPush(remote); },
    async contains(given) { expect(given).toEqual(candidate); return { ok: true, contains: true, known: true }; },
    async observe(given) {
      expect(given).toEqual(candidate); remote.observes += 1;
      // Read #1 is the pre-flight before any intent; #2 is the pre-push tip the transmission journals. A blind remote fails every read.
      return (remote.observes === 2 && remote.unreadableFirst) || remote.blind ? { ok: false, code: "PUBLISH_REMOTE_UNREADABLE", detail: "PUBLISH_REMOTE_UNREADABLE" }
        : { ok: true, sha: remote.tip };
    },
  };
  const publisher = createNodePublisher({ git, projectId: PROJECT_ID, store: faulted(store), workspace: identity.root, repository: repository.port,
    storeId: "D:/store.db", controller: CONTROLLER, processAlive: () => false, clock: () => NOW });
  return { store, decisionId, repository, remote, publisher,
    card: () => readRunGoalPublication(store, PROJECT_ID, readPublishLedger(store, PROJECT_ID).get(GOAL)),
    receipt: () => readPublishLedger(store, PROJECT_ID).get(GOAL)?.receipts.get(decisionId),
    evidence: () => readPublicationTransmission(store, PROJECT_ID, GOAL, decisionId),
    observed: () => readPublicationObservation(store, PROJECT_ID, GOAL, decisionId),
    observations: () => store.readEvents(publishAggregateId(GOAL)).filter((event) => event.eventType === "RepositoryPublicationObserved").length };
}
/** Stays UNKNOWN on the push pass AND on a replay, each naming its check, with the hold still PUBLISHING, no receipt, no release and no second push. */
async function expectStuck(w: ReturnType<typeof evidenceWorld>, evidence: PublicationTransmission | null, pushes: number, firstPass: string) {
  for (const pass of [firstPass, REPLAY]) {
    expect(await w.publisher.publishOnce()).toEqual(STUCK(w.remote.tip, pass));
    expect(w.receipt()).toBeUndefined(); expect(w.repository.phase()).toBe("PUBLISHING"); expect(w.repository.releases).toEqual([]);
    expect(w.card()).toMatchObject({ outcome: "UNKNOWN", code: "PUBLISH_EFFECT_RECONCILIATION_REQUIRED", decisionId: w.decisionId });
    expect(w.evidence()).toEqual(evidence); expect(w.remote.pushes).toBe(pushes);
    // Recorded once, on the first pass; the replay sees the same tip and writes nothing.
    expect(w.observations()).toBe(1);
    expect(w.observed()).toEqual({ projectId: PROJECT_ID, goalId: GOAL, decisionId: w.decisionId, observedSha: w.remote.tip,
      expectedSha: approval.sha, reason: evidence?.outcome ?? "UNRECORDED", observedAt: NOW });
    // And the runs read carries it to the card, exactly these four facts.
    expect(w.card()?.observation).toEqual({ observedSha: w.remote.tip, expectedSha: approval.sha, reason: evidence?.outcome ?? "UNRECORDED", observedAt: NOW });
  }
}

describe("a publish whose push provably did not land (both conditions, never one)", () => {
  it("resolves a push git refused while the remote tip stayed put: REFUSED PUBLISH_NOT_LANDED, hold released, card un-sticks, a fresh decision pushes", async () => {
    const w = evidenceWorld(() => REJECTED); const detail = NOT_LANDED(approval.sha, approval.branch, BEFORE, BEFORE);
    expect(await w.publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "REFUSED", detail: `PUBLISH_NOT_LANDED: ${detail}` }]);
    expect(w.evidence()).toEqual(sent(w.decisionId, BEFORE, "REJECTED"));
    expect(w.receipt()).toMatchObject({ outcome: "REFUSED", branch: approval.branch, sha: approval.sha, url: null,
      refusal: { code: "PUBLISH_NOT_LANDED", detail } });
    expect(w.repository.phase()).toBeNull(); expect(w.repository.releases).toEqual(["PUBLISH_NOT_TRANSMITTED"]);
    expect(w.card()).toMatchObject({ outcome: "REFUSED", code: "PUBLISH_NOT_LANDED", decisionId: w.decisionId });
    expect(await w.publisher.publishOnce()).toEqual([]); expect(w.remote.pushes).toBe(1);
    // Once the remote accepts, the operator's fresh decision pushes exactly once more, for itself only.
    w.remote.onPush = (remote) => { remote.tip = approval.sha; return { ok: true }; };
    const next = decide(w.store, "publish-2");
    expect(await w.publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "PUSHED", detail: `${approval.sha.slice(0, 10)} ${approval.branch} -> ${approval.remoteUrl}` }]);
    expect(w.remote.pushes).toBe(2); expect(w.repository.releases).toEqual(["PUBLISH_NOT_TRANSMITTED", "PUBLISHED"]);
    expect(w.card()).toMatchObject({ outcome: "PUSHED", decisionId: next });
  });
  it("keeps a refused push UNKNOWN when the remote tip MOVED while it ran", async () => {
    const w = evidenceWorld((remote) => { remote.tip = FOREIGN; return REJECTED; });
    await expectStuck(w, sent(w.decisionId, BEFORE, "REJECTED"), 1, PUSH_REJECTED);
  });
  it("keeps a SUCCESSFUL push UNKNOWN when the tip is back at its pre-push value (landed, then force-pushed back)", async () => {
    // The remote accepted the push and someone reset the branch to BEFORE before the post-push observe.
    const w = evidenceWorld(() => ({ ok: true }));
    await expectStuck(w, sent(w.decisionId, BEFORE, "ACCEPTED"), 1, "push exited 0");
  });
  it("keeps an INDETERMINATE push UNKNOWN: a throw, or a push that never answered", async () => {
    const answers: [Remote["onPush"], string][] = [[() => { throw new Error("lost effect response"); }, "push threw: lost effect response"],
      [() => ({ ok: false, code: "PUBLISH_PUSH_UNKNOWN", detail: "PUBLISH_PUSH_UNKNOWN" }), "push refused PUBLISH_PUSH_UNKNOWN: PUBLISH_PUSH_UNKNOWN"]];
    for (const [onPush, words] of answers) { const w = evidenceWorld(onPush); await expectStuck(w, sent(w.decisionId, BEFORE, "INDETERMINATE"), 1, words); }
    expect(answers).toHaveLength(2);
  });
  it("keeps an intent from before this rule UNKNOWN: it has no transmission record, is never pushed again and never measures the remote", async () => {
    const w = evidenceWorld(() => { throw new Error("a journaled intent must never push again"); }, () => ({ ok: true, defaultBranch: "master" }));
    const owner = { nodeRef: `publish:${w.decisionId}`, projectId: PROJECT_ID, storeId: "D:/store.db", ownershipToken: "d".repeat(64) };
    expect(w.repository.port.acquire(identity.root, owner, CONTROLLER)).toMatchObject({ ok: true });
    expect(w.repository.port.transition(identity.root, owner, 1, { ...CONTROLLER, phase: "PUBLISHING", baselineId: null, sessionId: null, pid: null }))
      .toMatchObject({ ok: true });
    recordPublicationIntent(w.store, { version: "moe-publication-intent/1", candidate, decisionId: w.decisionId, goalId: GOAL, projectId: PROJECT_ID,
      ownerDigest: publicationOwnerDigest(owner), reservationRevision: 1, controllerId: CONTROLLER.controllerId, intendedAt: NOW });
    await expectStuck(w, null, 0, REPLAY);
    // Recovery only observes: a replayed intent makes no network call for the default on any pass.
    expect(w.remote.measures).toBe(0); expect(readRemoteDefaultBranch(w.store, PROJECT_ID, approval.remoteUrl)).toBeNull();
  });
  it("keeps a refused push UNKNOWN when the pre-push tip was UNREADABLE, even though the post-push tip reads unchanged", async () => {
    const w = evidenceWorld(() => REJECTED); w.remote.unreadableFirst = true;
    await expectStuck(w, sent(w.decisionId, "UNREADABLE", "REJECTED"), 1, PUSH_REJECTED);
  });
  it("finishes a release refused after the PUBLISH_NOT_LANDED receipt: the receipt is the decision, even once the tip moves", async () => {
    const w = evidenceWorld(() => REJECTED); w.repository.refuseNextRelease();
    // The UNKNOWN names the refused release, not the remote: the receipt already decided this publish.
    expect(await w.publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "UNKNOWN", detail: "PUBLISH_EFFECT_RECONCILIATION_REQUIRED: "
      + "PUBLISH_NOT_LANDED receipted, but the reservation release was refused: REPOSITORY_EXECUTION_REVISION_CONFLICT" }]);
    expect(w.receipt()).toMatchObject({ outcome: "REFUSED", refusal: { code: "PUBLISH_NOT_LANDED" } });
    expect(w.repository.phase()).toBe("PUBLISHING"); expect(w.repository.releases).toEqual([]);
    w.remote.tip = FOREIGN; const observes = w.remote.observes;
    expect(await w.publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "REFUSED",
      detail: `PUBLISH_NOT_LANDED: ${NOT_LANDED(approval.sha, approval.branch, BEFORE, BEFORE)}` }]);
    expect(w.repository.phase()).toBeNull(); expect(w.repository.releases).toEqual(["PUBLISH_NOT_TRANSMITTED"]);
    expect(w.remote.pushes).toBe(1); expect(w.remote.observes).toBe(observes);
    expect(await w.publisher.publishOnce()).toEqual([]);
  });
});

describe("an operator-resolved publish: the owning publisher gives its own hold back, and never pushes for it", () => {
  const STUCK_PUSH: Remote["onPush"] = (remote) => { remote.tip = FOREIGN; return REJECTED; };
  const LANDS: Remote["onPush"] = (remote) => { remote.tip = approval.sha; return { ok: true }; };
  const PUSHED_REPORT = (goalId: string) => ({ goalId, outcome: "PUSHED", detail: `${approval.sha.slice(0, 10)} ${approval.branch} -> ${approval.remoteUrl}` });
  const refusedEvents = (w: ReturnType<typeof evidenceWorld>) =>
    w.store.readEvents(publishAggregateId(GOAL)).filter((event) => event.eventType === "RepositoryPublishRefused").length;
  /** A publish stuck UNKNOWN (hold PUBLISHING, one push), then the operator's resolve: its receipt, the hold untouched by the command. */
  async function resolved(w: ReturnType<typeof evidenceWorld>, resolution: PublishResolution) {
    expect(await w.publisher.publishOnce()).toEqual(STUCK(FOREIGN, PUSH_REJECTED));
    const answer = resolvePublish(w.store, { projectId: PROJECT_ID, decisionId: w.decisionId, resolution, decidedAt: NOW });
    if (!answer.ok) throw new Error(answer.code);
    expect(w.repository.phase()).toBe("PUBLISHING"); expect(w.repository.releases).toEqual([]);
    return answer.receipt;
  }

  it.each(["NOT_TRANSMITTED", "ABANDON"] as const)(
    "after a %s resolve the next pass releases the owned hold as PUBLISH_RESOLVED: no push, no remote read, no second receipt", async (resolution) => {
    const w = evidenceWorld(STUCK_PUSH); const receipt = await resolved(w, resolution);
    const node = { nodeRef: "graph-1:node-1", projectId: PROJECT_ID, storeId: "D:/store.db", ownershipToken: "e".repeat(64) };
    const delivery = { controllerId: "delivery-controller", controllerPid: 99 };
    expect(w.repository.port.acquire(identity.root, node, delivery)).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
    const observes = w.remote.observes;
    expect(await w.publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "REFUSED",
      detail: `${PUBLISH_RESOLVED_CODES[resolution]}: ${receipt.refusal?.detail ?? ""}` }]);
    expect(w.repository.phase()).toBeNull(); expect(w.repository.releases).toEqual(["PUBLISH_RESOLVED"]);
    expect(w.remote.pushes).toBe(1); expect(w.remote.observes).toBe(observes);
    expect(w.receipt()).toEqual(receipt); expect(refusedEvents(w)).toBe(1);
    expect(w.card()).toMatchObject({ outcome: "REFUSED", code: PUBLISH_RESOLVED_CODES[resolution], observation: null });
    // The node delivery the hold turned away is admitted now, and the next pass has nothing left to do.
    expect(w.repository.port.acquire(identity.root, node, delivery)).toMatchObject({ ok: true });
    expect(await w.publisher.publishOnce()).toEqual([]); expect(w.remote.pushes).toBe(1);
  });
  it("never mistakes another REFUSED receipt for an operator resolve: the hold stays where its own evidence left it", async () => {
    const foreign = ["PUBLISH_REMOTE_DIVERGED", "PUBLISH_APPROVAL_REQUIRED", "PUBLISH_RESOLVE_NOT_UNKNOWN", "PUBLISH_RESOLVED"];
    for (const code of foreign) {
      const w = evidenceWorld(STUCK_PUSH);
      expect(await w.publisher.publishOnce()).toEqual(STUCK(FOREIGN, PUSH_REJECTED));
      recordPublishReceipt(w.store, { branch: approval.branch, decidedAt: NOW, decisionId: w.decisionId, goalId: GOAL, projectId: PROJECT_ID,
        refusal: { code, detail: code }, remoteUrl: approval.remoteUrl, sha: approval.sha, url: null });
      expect(await w.publisher.publishOnce()).toEqual([]);
      expect(w.repository.phase()).toBe("PUBLISHING"); expect(w.repository.releases).toEqual([]); expect(w.remote.pushes).toBe(1);
    }
    expect(foreign).toHaveLength(4);
  });
  it("a wrapper that was DOWN when the operator resolved: the restarted one claims the dead controller's hold and gives it back, remote untouched", async () => {
    const w = evidenceWorld(STUCK_PUSH); const receipt = await resolved(w, "ABANDON");
    let claims = 0;
    const port: RepositoryExecutionPort = { ...w.repository.port, claimController: (ws, owner, revision, controller) => {
      claims += 1; return w.repository.port.transition(ws, owner, revision, { ...controller, phase: "PUBLISHING", baselineId: null, sessionId: null, pid: null });
    } };
    const offline = async (): Promise<never> => { throw new Error("a resolved publish never reaches the remote"); };
    const restarted = createNodePublisher({ git: { push: offline, observe: offline, contains: offline }, projectId: PROJECT_ID, store: w.store,
      workspace: identity.root, repository: port, storeId: "D:/store.db", controller: { controllerId: "controller-2", controllerPid: 5678 },
      processAlive: () => false, clock: () => NOW });
    expect(await restarted.publishOnce()).toEqual([{ goalId: GOAL, outcome: "REFUSED", detail: `PUBLISH_RESOLVED_ABANDON: ${receipt.refusal?.detail ?? ""}` }]);
    expect(claims).toBe(1); expect(w.repository.releases).toEqual(["PUBLISH_RESOLVED"]); expect(w.repository.phase()).toBeNull();
    expect(w.remote.pushes).toBe(1); expect(await restarted.publishOnce()).toEqual([]);
  });
  it("THE WINDOW, same goal: a fresh publish approved before the release pass pushes exactly once, right after the hold is given back", async () => {
    const w = evidenceWorld(STUCK_PUSH); const receipt = await resolved(w, "ABANDON");
    w.remote.onPush = LANDS; const next = decide(w.store, "publish-2");
    expect(await w.publisher.publishOnce()).toEqual([
      { goalId: GOAL, outcome: "REFUSED", detail: `PUBLISH_RESOLVED_ABANDON: ${receipt.refusal?.detail ?? ""}` }, PUSHED_REPORT(GOAL)]);
    expect(w.remote.pushes).toBe(2); expect(w.repository.releases).toEqual(["PUBLISH_RESOLVED", "PUBLISHED"]);
    expect(w.card()).toMatchObject({ outcome: "PUSHED", decisionId: next });
    expect(await w.publisher.publishOnce()).toEqual([]); expect(w.remote.pushes).toBe(2);
  });
  it("THE WINDOW, another goal visited first: the fresh publish WAITS while the resolved hold stands, then pushes exactly once", async () => {
    const OTHER = "goal-publisher-0";
    // OTHER was published long ago, so the ledger walk visits it before the stuck goal.
    const w = evidenceWorld(STUCK_PUSH, null, undefined, (store) => {
      const old = decide(store, "publish-0", candidate, OTHER);
      recordPublishReceipt(store, { branch: approval.branch, decidedAt: NOW, decisionId: old, goalId: OTHER, projectId: PROJECT_ID,
        refusal: null, remoteUrl: approval.remoteUrl, sha: approval.sha, url: null });
    });
    const receipt = await resolved(w, "NOT_TRANSMITTED");
    w.remote.onPush = LANDS; decide(w.store, "publish-2", candidate, OTHER);
    expect(await w.publisher.publishOnce()).toEqual([
      { goalId: OTHER, outcome: "WAITING", detail: `repository held by publish:${w.decisionId} (PUBLISHING)` },
      { goalId: GOAL, outcome: "REFUSED", detail: `PUBLISH_RESOLVED_NOT_TRANSMITTED: ${receipt.refusal?.detail ?? ""}` }]);
    expect(w.remote.pushes).toBe(1); expect(w.repository.releases).toEqual(["PUBLISH_RESOLVED"]);
    expect(await w.publisher.publishOnce()).toEqual([PUSHED_REPORT(OTHER)]);
    expect(w.remote.pushes).toBe(2); expect(w.repository.releases).toEqual(["PUBLISH_RESOLVED", "PUBLISHED"]);
    expect(await w.publisher.publishOnce()).toEqual([]); expect(w.remote.pushes).toBe(2);
  });
});

describe("the last observation of an unresolved publish: written when it changes, never once per pass", () => {
  const BLIND = (pass: string) => [{ goalId: GOAL, outcome: "UNKNOWN",
    detail: `PUBLISH_EFFECT_RECONCILIATION_REQUIRED: remote unreadable PUBLISH_REMOTE_UNREADABLE: PUBLISH_REMOTE_UNREADABLE; ${pass}` }];
  it("writes none while the remote is unreadable, one for a new tip however many passes see it, and one more when it moves", async () => {
    const w = evidenceWorld((remote) => { remote.blind = true; return REJECTED; });
    expect(w.card()).toMatchObject({ outcome: "PENDING", observation: null });
    for (const pass of [PUSH_REJECTED, REPLAY, REPLAY]) expect(await w.publisher.publishOnce()).toEqual(BLIND(pass));
    expect(w.card()).toMatchObject({ outcome: "UNKNOWN", observation: null });
    expect(w.remote.observes).toBe(5); expect(w.observations()).toBe(0);
    w.remote.blind = false; w.remote.tip = FOREIGN;
    for (let pass = 0; pass < 3; pass += 1) expect(await w.publisher.publishOnce()).toEqual(STUCK(FOREIGN, REPLAY));
    expect(w.observations()).toBe(1); expect(w.observed()).toMatchObject({ observedSha: FOREIGN, reason: "REJECTED" });
    w.remote.tip = null;
    expect(await w.publisher.publishOnce()).toEqual(STUCK(null, REPLAY));
    expect(w.observations()).toBe(2); expect(w.observed()).toMatchObject({ observedSha: null, expectedSha: approval.sha, reason: "REJECTED" });
  });
  it("writes none for a publish that resolved: PUSHED, or refused with the remote tip never moved", async () => {
    const cases: [Remote["onPush"], string][] = [[(remote) => { remote.tip = approval.sha; return { ok: true }; }, "PUSHED"], [() => REJECTED, "REFUSED"]];
    for (const [onPush, outcome] of cases) {
      const w = evidenceWorld(onPush);
      expect(await w.publisher.publishOnce()).toMatchObject([{ outcome }]); expect(w.observations()).toBe(0);
      expect(w.card()).toMatchObject({ outcome, observation: null });
    }
    expect(cases).toHaveLength(2);
  });
  it("never lets a failed observation write change the publish: the same UNKNOWN each pass, one push, nothing written", async () => {
    let failed = 0;
    const w = evidenceWorld((remote) => { remote.tip = FOREIGN; return REJECTED; }, null, (store) => new Proxy(store, { get(target, key) {
      if (key === "commitExpectedVersionDecision") return (input: Parameters<SqliteEventStore["commitExpectedVersionDecision"]>[0]) => {
        if (input.commandKind !== "internal.repository.publication_observation") return target.commitExpectedVersionDecision(input);
        failed += 1; throw new Error("SQLITE_FULL: database or disk is full");
      };
      const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } }));
    for (const pass of [PUSH_REJECTED, REPLAY]) expect(await w.publisher.publishOnce()).toEqual(STUCK(FOREIGN, pass));
    expect(failed).toBe(2); expect(w.observations()).toBe(0); expect(w.remote.pushes).toBe(1);
    expect(w.card()).toMatchObject({ outcome: "UNKNOWN", decisionId: w.decisionId });
  });
});

describe("the remote's default branch: measured on a fresh publish, recorded only when the remote answered", () => {
  const measured = (defaultBranch: string | null) => (): Measurement => ({ ok: true, defaultBranch });
  const PUSHED = [{ goalId: GOAL, outcome: "PUSHED", detail: `${approval.sha.slice(0, 10)} ${approval.branch} -> ${approval.remoteUrl}` }];
  const NOT_LANDED_REPORT = [{ goalId: GOAL, outcome: "REFUSED", detail: `PUBLISH_NOT_LANDED: ${NOT_LANDED(approval.sha, approval.branch, BEFORE, BEFORE)}` }];
  const recorded = (w: ReturnType<typeof evidenceWorld>) => readRemoteDefaultBranch(w.store, PROJECT_ID, approval.remoteUrl);
  const remoteEvents = (w: ReturnType<typeof evidenceWorld>) => w.store.readEvents(remoteAggregateId(PROJECT_ID)).length;

  it("measures exactly once on a fresh publish and records the answer; a pass with nothing to publish measures nothing", async () => {
    const w = evidenceWorld((remote) => { remote.tip = approval.sha; return { ok: true }; }, measured("master"));
    expect(await w.publisher.publishOnce()).toEqual(PUSHED);
    expect(w.remote.measures).toBe(1); expect(recorded(w)).toBe("master");
    expect(await w.publisher.publishOnce()).toEqual([]); expect(w.remote.measures).toBe(1);
    // The next fresh decision measures again, but an unchanged answer adds no event to the remote aggregate.
    decide(w.store, "publish-2");
    expect(await w.publisher.publishOnce()).toEqual(PUSHED);
    expect(w.remote.measures).toBe(2); expect(remoteEvents(w)).toBe(1);
  });
  it("measures a push git REFUSED too, while the provably-not-landed resolution answers exactly as before", async () => {
    const w = evidenceWorld(() => REJECTED, measured("master"));
    expect(await w.publisher.publishOnce()).toEqual(NOT_LANDED_REPORT);
    expect(w.remote.measures).toBe(1); expect(recorded(w)).toBe("master");
    expect(w.evidence()).toEqual(sent(w.decisionId, BEFORE, "REJECTED")); expect(w.repository.releases).toEqual(["PUBLISH_NOT_TRANSMITTED"]);
  });
  it("records NOTHING for a refused or thrown measurement: the earlier default stands and the publish's outcome is untouched", async () => {
    const w = evidenceWorld(() => REJECTED, measured("master"));
    expect(await w.publisher.publishOnce()).toEqual(NOT_LANDED_REPORT); expect(recorded(w)).toBe("master");
    const failures: Remote["onMeasure"][] = [() => ({ ok: false, code: "PUBLISH_REMOTE_UNREADABLE", detail: "git exited 128: fatal: repository not found" }),
      () => { throw new Error("ls-remote lost"); }];
    for (const [index, failure] of failures.entries()) {
      w.remote.onMeasure = failure; decide(w.store, `publish-again-${String(index)}`);
      expect(await w.publisher.publishOnce()).toEqual(NOT_LANDED_REPORT);
      expect(w.remote.measures).toBe(index + 2); expect(recorded(w)).toBe("master");
    }
    expect(failures).toHaveLength(2); expect(remoteEvents(w)).toBe(1);
  });
  it("publishes exactly as before against a port that cannot measure, and records no default", async () => {
    const w = evidenceWorld(() => REJECTED);
    expect(await w.publisher.publishOnce()).toEqual(NOT_LANDED_REPORT);
    expect(w.remote.measures).toBe(0); expect(recorded(w)).toBeNull(); expect(remoteEvents(w)).toBe(0);
  });
});

it("LIVE: a real bare remote whose pre-receive hook refuses: refused, auto-resolved, then a fresh decision pushes once", async () => {
  const base = resolve(tmpdir()); const root = mkdtempSync(join(base, "moe-publisher-refused-"));
  const remote = join(root, "remote.git"); const remoteUrl = "https://github.com/fixture/refused.git";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: landingEnvironment(),
    windowsHide: true, shell: false, encoding: "utf8", timeout: 30_000 }).replace(/\r?\n$/u, "");
  try {
    git("init", "--quiet", "--initial-branch=approved");
    writeFileSync(join(root, "product.txt"), "approved\n"); git("add", "product.txt");
    git("-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "approved");
    const captured = createPublicationCandidateReader(root)(remoteUrl);
    if (!captured.ok) throw new Error(captured.code);
    const sha = captured.candidate.approval.sha;
    git("init", "--bare", "--quiet", remote);
    // The remote's own default names the approved branch, so the measurement is read from REAL `ls-remote --symref` output.
    git(`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/approved");
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho refused by the fixture >&2\nexit 1\n", { mode: 0o755 });
    let pushes = 0;
    // Only the push/ls-remote runner swaps the admitted https url for the local bare remote: nothing reaches a network.
    const port = createGitPublicationPort({ readConfig: nodeGitRunner, run: async (cwd, args) => {
      if (args.includes("push")) pushes += 1;
      return publicationGitRunner(cwd, args.map((arg) => arg === remoteUrl ? remote : arg));
    } });
    const real = createRepositoryExecutionPort(); const releases: string[] = [];
    const repository: RepositoryExecutionPort = { ...real, release: (...args) => { releases.push(args[3]); return real.release(...args); } };
    const store = openStore(); const first = decide(store, "live-1", captured.candidate);
    const publisher = createNodePublisher({ git: port, projectId: PROJECT_ID, store, workspace: root, repository, storeId: "D:/store.db",
      controller: { controllerId: "live-controller", controllerPid: process.pid }, processAlive: () => false });
    expect(await publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "REFUSED",
      detail: `PUBLISH_NOT_LANDED: ${NOT_LANDED(sha, "approved", "absent", "absent")}` }]);
    expect(pushes).toBe(1); expect(releases).toEqual(["PUBLISH_NOT_TRANSMITTED"]);
    expect(real.inspect(root)).toEqual({ ok: true, reservation: null });
    expect(readPublicationTransmission(store, PROJECT_ID, GOAL, first)).toMatchObject({ outcome: "REJECTED", tipBefore: null });
    expect(readPublishLedger(store, PROJECT_ID).get(GOAL)?.receipts.get(first)).toMatchObject({ outcome: "REFUSED", refusal: { code: "PUBLISH_NOT_LANDED" } });
    rmSync(hook);
    const second = decide(store, "live-2", captured.candidate);
    expect(await publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "PUSHED", detail: `${sha.slice(0, 10)} approved -> ${remoteUrl}` }]);
    expect(pushes).toBe(2); expect(releases).toEqual(["PUBLISH_NOT_TRANSMITTED", "PUBLISHED"]);
    expect(git(`--git-dir=${remote}`, "rev-parse", "refs/heads/approved")).toBe(sha);
    expect(readPublicationTransmission(store, PROJECT_ID, GOAL, second)).toMatchObject({ outcome: "ACCEPTED", tipBefore: null });
    expect(readRemoteDefaultBranch(store, PROJECT_ID, remoteUrl)).toBe("approved");
    expect(await publisher.publishOnce()).toEqual([]); expect(pushes).toBe(2);
  } finally { if (resolve(root).startsWith(`${base}${sep}`)) rmSync(root, { recursive: true, force: true }); }
  // About 40 real git processes: seconds on an idle host, minutes when process spawns crawl under a loaded one.
}, 600_000);
