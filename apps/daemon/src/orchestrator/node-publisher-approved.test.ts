import { afterEach, describe, expect, it } from "vitest";
import type { PublicationGitPort } from "../repository/publication-effect-contracts.js";
import { readPublicationIntent } from "../repository/publication-effect-ledger.js";
import { publicationRepositoryId } from "../repository/publication-approval-contracts.js";
import type { PublicationRefusal } from "../repository/publication-approval-contracts.js";
import { readPublishLedger } from "../repository/publish-ledger.js";
import { REPOSITORY_PUBLISH_COMMAND_KIND, publishAggregateId } from "../repository/publish-receipt-contracts.js";
import type { RepositoryExecutionHandle, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { PROJECT_ID, closeStores, openStore, openRestartableStore, reopen } from "../review/review-test-fixtures.js";
import { createNodePublisher, pendingPublication } from "./node-publisher.js";
import { readRunGoalPublication } from "../http/run-goal-publication.js";

afterEach(closeStores);
const GOAL = "goal-publisher-1";
const identity = { root: "D:/ws", gitDirectory: "D:/ws/.git" };
const approval = { branch: "approved-branch", sha: "a".repeat(40), remoteUrl: "https://github.com/o/r.git", repositoryId: publicationRepositoryId(identity) };
const candidate = { approval, identity };
const encoder = new TextEncoder();
function requestPublish(store: ReturnType<typeof openStore>, commandId: string, bound = true): string {
  const aggregateId = publishAggregateId(GOAL);
  return store.commitExpectedVersionDecision({ commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: encoder.encode(JSON.stringify({ ...(bound ? { candidate } : {}), goalId: GOAL, remoteUrl: approval.remoteUrl })),
    correlationId: "test-publish", decidedAt: "2026-09-06T00:00:00.000Z",
    events: [{ eventId: `${commandId}-requested`, eventType: "RepositoryPublishRequested", payload: encoder.encode("{}") }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId, principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: encoder.encode("{}"), targetAggregateId: aggregateId,
  }).decision.decisionId;
}
function reservation() {
  let held: RepositoryExecutionHandle | null = null;
  const releases: string[] = [];
  // The identity the port observes when it reserves; `drift()` moves it, as a re-cloned or
  // re-pointed checkout would after the candidate was approved.
  let observedIdentity = identity;
  const port: RepositoryExecutionPort = {
    acquire: (_ws, owner, controller) => {
      if (held !== null) return { ok: false, code: "REPOSITORY_EXECUTION_BUSY", detail: "busy" };
      held = { owner, reservation: { ...owner, ...controller, identity: observedIdentity, phase: "RESERVED", baselineId: null, sessionId: null, pid: null, revision: 1 } };
      return { ok: true, handle: held };
    },
    inspect: () => ({ ok: true, reservation: held?.reservation ?? null }),
    readOwned: () => ({ ok: true, handle: held }),
    claimController: (_ws, _owner, revision, controller) => {
      if (held === null || held.reservation.revision !== revision) throw new Error("bad claim");
      held = { ...held, reservation: { ...held.reservation, ...controller, revision: revision + 1 } };
      return { ok: true, handle: held };
    },
    transition: (_ws, owner, revision, state) => {
      if (held === null || held.owner !== owner || held.reservation.revision !== revision) throw new Error("bad transition");
      held = { ...held, reservation: { ...held.reservation, ...state, revision: revision + 1 } };
      return { ok: true, handle: held };
    },
    release: (_ws, owner, revision, reason) => {
      expect(held?.owner).toBe(owner); expect(held?.reservation.revision).toBe(revision);
      // The real port's rule (repository-execution-port.ts): PUBLISHED leaves PUBLISHING only,
      // ABORTED_BEFORE_EXECUTION leaves a RESERVED reservation that never executed.
      const allowed = reason === "PUBLISHED" ? held?.reservation.phase === "PUBLISHING"
        : reason === "ABORTED_BEFORE_EXECUTION" && held?.reservation.phase === "RESERVED";
      if (!allowed) return { ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID", detail: `${reason} from ${held?.reservation.phase ?? "nothing"}` };
      releases.push(reason); held = null; return { ok: true, released: true };
    },
  };
  // A coding seat's hold, as the delivery coordinator leaves it: another owner, EXECUTING.
  const hold = (nodeRef: string): void => {
    const owner = { nodeRef, projectId: PROJECT_ID, storeId: "D:/store.db", ownershipToken: "seat-token" };
    held = { owner, reservation: { ...owner, controllerId: "controller-1", controllerPid: 1234, identity, phase: "EXECUTING",
      baselineId: "baseline-1", sessionId: "sess-1", pid: 4242, revision: 7 } };
  };
  return { port, held: () => held, hold, free: () => { held = null; }, releases: () => [...releases],
    drift: () => { observedIdentity = { root: "D:/elsewhere", gitDirectory: "D:/elsewhere/.git" }; } };
}
function world(bound = true, store = openStore()) {
  const decisionId = requestPublish(store, "publish-1", bound); const fence = reservation();
  let pushes = 0; let remote: string | null = null; let failPush = false; let throwPush = false; let unreadable = false;
  let containsRefusal: PublicationRefusal | null = null;
  // What the candidate's repository holds: every known object, and those the approved sha contains.
  const known = new Set([approval.sha]); const contained = new Set([approval.sha]);
  const git: PublicationGitPort = {
    async contains(given, remoteSha) {
      expect(given).toEqual(candidate);
      expect(readPublicationIntent(store, PROJECT_ID, GOAL, decisionId)).toBeNull();
      if (containsRefusal !== null) return containsRefusal;
      return remoteSha === null ? { ok: true, contains: true, known: true } : { ok: true, contains: contained.has(remoteSha), known: known.has(remoteSha) };
    },
    async push(given) {
      pushes += 1; expect(given).toEqual(candidate);
      expect(fence.held()?.reservation.phase).toBe("PUBLISHING");
      expect(readPublicationIntent(store, PROJECT_ID, GOAL, decisionId)).toMatchObject({ candidate, decisionId });
      if (throwPush) throw new Error("lost effect response");
      if (failPush) return { ok: false, code: "PUBLISH_PUSH_UNKNOWN", detail: "git exited 128: Permission denied (publickey)." };
      remote = approval.sha; return { ok: true };
    },
    async observe(given) {
      expect(given).toEqual(candidate);
      return unreadable ? { ok: false, code: "PUBLISH_REMOTE_UNREADABLE", detail: "git exited 128: Could not resolve host" } : { ok: true, sha: remote };
    },
  };
  const config = { git, projectId: PROJECT_ID, store, workspace: identity.root, repository: fence.port,
    storeId: "D:/store.db", controller: { controllerId: "controller-1", controllerPid: 1234 }, processAlive: () => false };
  return { config, store, decisionId, fence, pushes: () => pushes,
    remote: (sha: string | null) => { remote = sha; }, fail: () => { failPush = true; }, throw: () => { throwPush = true; },
    unreadable: (value: boolean) => { unreadable = value; }, refuseContains: (refusal: PublicationRefusal | null) => { containsRefusal = refusal; },
    ancestor: (sha: string) => { known.add(sha); contained.add(sha); }, foreign: (sha: string) => { known.add(sha); } };
}
const receiptOf = (w: ReturnType<typeof world>) => readPublishLedger(w.store, PROJECT_ID).get(GOAL)?.receipts.get(w.decisionId);
const runsRead = (w: ReturnType<typeof world>) => readRunGoalPublication(w.store, PROJECT_ID, readPublishLedger(w.store, PROJECT_ID).get(GOAL));

describe("approved node publication", () => {
  it("journals before pushing the immutable candidate while holding the repository, then records exact remote equality", async () => {
    const w = world(); const publisher = createNodePublisher(w.config);
    expect(await publisher.publishOnce()).toMatchObject([{ outcome: "PUSHED" }]);
    expect(w.pushes()).toBe(1); expect(w.fence.held()).toBeNull();
    expect(readPublishLedger(w.store, PROJECT_ID).get(GOAL)?.receipts.get(w.decisionId)).toMatchObject({ outcome: "PUSHED", sha: approval.sha, branch: approval.branch });
    expect(await publisher.publishOnce()).toEqual([]); expect(w.pushes()).toBe(1);
  });
  it("retains ambiguous effects without another push, then reconciles exact equality after restart", async () => {
    const w = world(); w.fail();
    expect(await createNodePublisher(w.config).publishOnce()).toMatchObject([{ outcome: "UNKNOWN" }]);
    expect(w.fence.held()?.reservation.phase).toBe("PUBLISHING");
    const restarted = createNodePublisher({ ...w.config, controller: { controllerId: "controller-2", controllerPid: 5678 } });
    expect(await restarted.publishOnce()).toMatchObject([{ outcome: "UNKNOWN" }]); expect(w.pushes()).toBe(1);
    w.remote(approval.sha);
    expect(await restarted.publishOnce()).toMatchObject([{ outcome: "PUSHED" }]); expect(w.pushes()).toBe(1);
    expect(w.fence.held()).toBeNull();
  });
  it("does not let a later approval bypass an unknown effect", async () => {
    const w = world(); w.throw(); const publisher = createNodePublisher(w.config);
    expect(await publisher.publishOnce()).toMatchObject([{ outcome: "UNKNOWN" }]);
    requestPublish(w.store, "publish-2"); await publisher.publishOnce();
    expect(w.pushes()).toBe(1); expect(w.fence.held()).not.toBeNull();
    expect(readRunGoalPublication(w.store, PROJECT_ID, readPublishLedger(w.store, PROJECT_ID).get(GOAL)))
      .toMatchObject({ outcome: "UNKNOWN", decisionId: w.decisionId, sha: approval.sha, branch: approval.branch });
  });
  it("never adopts a live controller's effect", async () => {
    const w = world(); w.fail(); await createNodePublisher(w.config).publishOnce(); w.remote(approval.sha);
    const other = createNodePublisher({ ...w.config, controller: { controllerId: "other", controllerPid: 99 }, processAlive: () => true });
    expect(await other.publishOnce()).toMatchObject([{ outcome: "UNKNOWN",
      detail: "PUBLISH_EFFECT_RECONCILIATION_REQUIRED: another live controller (pid 1234) owns this publication" }]);
    expect(w.fence.held()).not.toBeNull();
  });
  it("waits, journaling and pushing nothing, while a coding seat holds the repository, then publishes once it is free", async () => {
    // UnAI 2026-09-18: nine passes of "UNKNOWN (PUBLISH_EFFECT_RECONCILIATION_REQUIRED)" while
    // node 3's seat held the repository. Nothing was unknown: the publisher had never held it.
    const w = world(); w.fence.hold("node:v1:seat-3");
    const publisher = createNodePublisher(w.config);
    expect(await publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "WAITING", detail: "repository held by node:v1:seat-3 (EXECUTING)" }]);
    expect(w.pushes()).toBe(0);
    expect(readPublicationIntent(w.store, PROJECT_ID, GOAL, w.decisionId)).toBeNull();
    // The runs read stays PENDING (an UNKNOWN there needs a journaled intent), so the operator
    // may still decide; and the delivery coordinator is told a publish is waiting.
    expect(readRunGoalPublication(w.store, PROJECT_ID, readPublishLedger(w.store, PROJECT_ID).get(GOAL))).toMatchObject({ outcome: "PENDING" });
    expect(pendingPublication(w.store, PROJECT_ID)).toBe(GOAL);
    w.fence.free();
    expect(await publisher.publishOnce()).toMatchObject([{ outcome: "PUSHED" }]);
    expect(w.pushes()).toBe(1); expect(w.fence.held()).toBeNull();
    expect(pendingPublication(w.store, PROJECT_ID)).toBeNull();
  });
  it("names the check behind every UNKNOWN, and stops naming a waiting publish once its intent is journaled", async () => {
    const w = world(); w.fail(); const publisher = createNodePublisher(w.config);
    expect(await publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "UNKNOWN", detail: "PUBLISH_EFFECT_RECONCILIATION_REQUIRED: "
      + "remote approved-branch is at absent, expected aaaaaaaaaa; push refused PUBLISH_PUSH_UNKNOWN: git exited 128: Permission denied (publickey)." }]);
    // An intent exists now: a wedged effect must not turn every delivery away from the repository.
    expect(pendingPublication(w.store, PROJECT_ID)).toBeNull();
    expect(await publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "UNKNOWN", detail: "PUBLISH_EFFECT_RECONCILIATION_REQUIRED: "
      + "remote approved-branch is at absent, expected aaaaaaaaaa; no push this pass (an intent was already journaled)" }]);
    w.unreadable(true);
    expect(await publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "UNKNOWN", detail: "PUBLISH_EFFECT_RECONCILIATION_REQUIRED: "
      + "remote unreadable PUBLISH_REMOTE_UNREADABLE: git exited 128: Could not resolve host; no push this pass (an intent was already journaled)" }]);
    expect(w.pushes()).toBe(1);
  });
  it("refuses by name, releases the reservation and receipts a repository whose identity drifted since the approval", async () => {
    // Review of 0f1f2ba9: the reservation helper answered this with a bare UNKNOWN and left the
    // reservation it had just acquired held, every pass, until a new decision: the same wedge
    // class as a diverged remote, on a rarer trigger. It now takes the pre-flight exit.
    const w = world(); w.fence.drift(); const publisher = createNodePublisher(w.config);
    expect(await publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "REFUSED",
      detail: "PUBLISH_REPOSITORY_CHANGED: the repository identity changed since the candidate was approved; decide again to retry" }]);
    expect(w.pushes()).toBe(0); expect(w.fence.held()).toBeNull(); expect(w.fence.releases()).toEqual(["ABORTED_BEFORE_EXECUTION"]);
    expect(readPublicationIntent(w.store, PROJECT_ID, GOAL, w.decisionId)).toBeNull();
    expect(readPublishLedger(w.store, PROJECT_ID).get(GOAL)?.receipts.get(w.decisionId)).toMatchObject({ outcome: "REFUSED", refusal: { code: "PUBLISH_REPOSITORY_CHANGED" } });
    expect(pendingPublication(w.store, PROJECT_ID)).toBeNull();
    expect(await publisher.publishOnce()).toEqual([]);
  });
  it("names a thrown push in the pass that threw it", async () => {
    const w = world(); w.throw();
    expect(await createNodePublisher(w.config).publishOnce()).toEqual([{ goalId: GOAL, outcome: "UNKNOWN", detail: "PUBLISH_EFFECT_RECONCILIATION_REQUIRED: "
      + "remote approved-branch is at absent, expected aaaaaaaaaa; push threw: lost effect response" }]);
  });
  it("reopens a file-backed store and reconciles a durable unknown effect without another push", async () => {
    const durable = openRestartableStore(); const w = world(true, durable.store); w.fail();
    await createNodePublisher(w.config).publishOnce();
    const reopened = reopen(durable); w.remote(approval.sha);
    const recovered = createNodePublisher({ ...w.config, store: reopened,
      controller: { controllerId: "reopened-controller", controllerPid: 9876 } });
    expect(await recovered.publishOnce()).toMatchObject([{ outcome: "PUSHED" }]);
    expect(w.pushes()).toBe(1); expect(w.fence.held()).toBeNull();
    expect(readPublishLedger(reopened, PROJECT_ID).get(GOAL)?.receipts.get(w.decisionId))
      .toMatchObject({ outcome: "PUSHED", sha: approval.sha, branch: approval.branch });
  });
  it("retains a successful remote effect when receipt persistence fails and repairs only its receipt", async () => {
    const w = world();
    const broken = new Proxy(w.store, { get(target, key) {
      if (key === "commitExpectedVersionDecision") return (input: Parameters<typeof target.commitExpectedVersionDecision>[0]) => {
        if (input.commandKind === "internal.repository.publish_receipt") throw new Error("receipt disk failure");
        return target.commitExpectedVersionDecision(input);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(await createNodePublisher({ ...w.config, store: broken }).publishOnce()).toMatchObject([{ outcome: "UNKNOWN" }]);
    expect(w.fence.held()?.reservation.phase).toBe("PUBLISHING"); expect(w.pushes()).toBe(1);
    expect(await createNodePublisher(w.config).publishOnce()).toMatchObject([{ outcome: "PUSHED" }]);
    expect(w.pushes()).toBe(1); expect(w.fence.held()).toBeNull();
  });
  describe("pre-flight before any intent (UnAI 2026-09-18: an operator merged on GitHub behind Moe's back)", () => {
    const FOREIGN = "b".repeat(40);
    it("refuses a diverged remote by name, journals nothing, pushes nothing and gives the repository back", async () => {
      const w = world(); w.remote(FOREIGN); w.foreign(FOREIGN);
      const publisher = createNodePublisher(w.config);
      expect(await publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "REFUSED", detail: "PUBLISH_REMOTE_DIVERGED: remote approved-branch is at bbbbbbbbbb, "
        + "which the approved aaaaaaaaaa does not contain: fetch and merge (or rebase) it into the workspace branch, then decide again" }]);
      expect(w.pushes()).toBe(0);
      expect(readPublicationIntent(w.store, PROJECT_ID, GOAL, w.decisionId)).toBeNull();
      expect(w.fence.held()).toBeNull(); expect(w.fence.releases()).toEqual(["ABORTED_BEFORE_EXECUTION"]);
      expect(receiptOf(w)).toMatchObject({ outcome: "REFUSED", refusal: { code: "PUBLISH_REMOTE_DIVERGED", detail: expect.stringContaining("fetch and merge") },
        sha: approval.sha, branch: approval.branch, url: null });
      // The request has its receipt: deliveries are no longer turned away, the card names the code.
      expect(pendingPublication(w.store, PROJECT_ID)).toBeNull();
      expect(runsRead(w)).toMatchObject({ outcome: "REFUSED", code: "PUBLISH_REMOTE_DIVERGED", decisionId: w.decisionId, branch: approval.branch });
      expect(await publisher.publishOnce()).toEqual([]); expect(w.pushes()).toBe(0);
    });
    it("treats a remote tip this repository has never seen as diverged", async () => {
      const w = world(); w.remote("c".repeat(40));
      expect(await createNodePublisher(w.config).publishOnce()).toMatchObject([{ outcome: "REFUSED", detail: expect.stringContaining("PUBLISH_REMOTE_DIVERGED: remote approved-branch is at cccccccccc") }]);
      expect(w.pushes()).toBe(0); expect(w.fence.held()).toBeNull();
      expect(readPublicationIntent(w.store, PROJECT_ID, GOAL, w.decisionId)).toBeNull();
    });
    it("pushes exactly once over a remote tip the approved sha contains, and over an absent branch", async () => {
      const ancestor = "d".repeat(40);
      const w = world(); w.remote(ancestor); w.ancestor(ancestor);
      expect(await createNodePublisher(w.config).publishOnce()).toMatchObject([{ outcome: "PUSHED" }]);
      expect(w.pushes()).toBe(1); expect(w.fence.held()).toBeNull(); expect(w.fence.releases()).toEqual(["PUBLISHED"]);
      const absent = world();
      expect(await createNodePublisher(absent.config).publishOnce()).toMatchObject([{ outcome: "PUSHED" }]);
      expect(absent.pushes()).toBe(1); expect(absent.fence.releases()).toEqual(["PUBLISHED"]);
    });
    // NEVER WAITING before an intent: pendingPublication() names the goal while no intent exists, so a
    // WAITING pre-flight would turn every delivery away from a free repository until the remote read
    // again — a dead token would starve the whole product. One more decision is the price of a blip.
    it("refuses by the git port's own code and words when the remote cannot be read before any intent, journaling nothing and giving the repository back", async () => {
      const w = world(); w.unreadable(true); const publisher = createNodePublisher(w.config);
      expect(await publisher.publishOnce()).toEqual([{ goalId: GOAL, outcome: "REFUSED",
        detail: "PUBLISH_REMOTE_UNREADABLE: git exited 128: Could not resolve host; decide again to retry" }]);
      expect(w.pushes()).toBe(0); expect(w.fence.held()).toBeNull(); expect(w.fence.releases()).toEqual(["ABORTED_BEFORE_EXECUTION"]);
      expect(readPublicationIntent(w.store, PROJECT_ID, GOAL, w.decisionId)).toBeNull();
      expect(receiptOf(w)).toMatchObject({ outcome: "REFUSED", refusal: { code: "PUBLISH_REMOTE_UNREADABLE", detail: "git exited 128: Could not resolve host; decide again to retry" },
        sha: approval.sha, branch: approval.branch, url: null });
      expect(pendingPublication(w.store, PROJECT_ID)).toBeNull();
      expect(runsRead(w)).toMatchObject({ outcome: "REFUSED", code: "PUBLISH_REMOTE_UNREADABLE", decisionId: w.decisionId });
      // The receipt closes the request: a readable remote later does not revive it without a new decision.
      w.unreadable(false);
      expect(await publisher.publishOnce()).toEqual([]); expect(w.pushes()).toBe(0);
    });
    it("refuses by the port's own permanent code when the candidate's repository cannot answer contains() before any intent", async () => {
      const w = world(); w.remote("d".repeat(40)); w.refuseContains({ ok: false, code: "PUBLISH_REPOSITORY_CHANGED", detail: "PUBLISH_REPOSITORY_CHANGED" });
      expect(await createNodePublisher(w.config).publishOnce()).toEqual([{ goalId: GOAL, outcome: "REFUSED", detail: "PUBLISH_REPOSITORY_CHANGED: PUBLISH_REPOSITORY_CHANGED; decide again to retry" }]);
      expect(w.pushes()).toBe(0); expect(w.fence.held()).toBeNull(); expect(w.fence.releases()).toEqual(["ABORTED_BEFORE_EXECUTION"]);
      expect(readPublicationIntent(w.store, PROJECT_ID, GOAL, w.decisionId)).toBeNull();
      expect(receiptOf(w)).toMatchObject({ outcome: "REFUSED", refusal: { code: "PUBLISH_REPOSITORY_CHANGED" }, sha: approval.sha, url: null });
      expect(pendingPublication(w.store, PROJECT_ID)).toBeNull();
      expect(runsRead(w)).toMatchObject({ outcome: "REFUSED", code: "PUBLISH_REPOSITORY_CHANGED" });
    });
  });
  it("refuses legacy unbound decisions without starting Git", async () => {
    const w = world(false); expect(await createNodePublisher(w.config).publishOnce()).toMatchObject([{ outcome: "REFUSED" }]);
    expect(w.pushes()).toBe(0); expect(w.fence.held()).toBeNull();
  });
  it("reports absent workspace without recording or performing an effect", async () => {
    const w = world(); expect(await createNodePublisher({ ...w.config, workspace: null }).publishOnce()).toMatchObject([{ outcome: "WORKSPACE_UNSET" }]);
    expect(w.pushes()).toBe(0); expect(readPublishLedger(w.store, PROJECT_ID).get(GOAL)?.receipts.size).toBe(0);
  });
});
