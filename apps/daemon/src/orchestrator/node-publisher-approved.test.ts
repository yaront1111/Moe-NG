import { afterEach, describe, expect, it } from "vitest";
import type { PublicationGitPort } from "../repository/publication-effect-contracts.js";
import { readPublicationIntent } from "../repository/publication-effect-ledger.js";
import { publicationRepositoryId } from "../repository/publication-approval-contracts.js";
import { readPublishLedger } from "../repository/publish-ledger.js";
import { REPOSITORY_PUBLISH_COMMAND_KIND, publishAggregateId } from "../repository/publish-receipt-contracts.js";
import type { RepositoryExecutionHandle, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { PROJECT_ID, closeStores, openStore, openRestartableStore, reopen } from "../review/review-test-fixtures.js";
import { createNodePublisher } from "./node-publisher.js";
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
  const port: RepositoryExecutionPort = {
    acquire: (_ws, owner, controller) => {
      if (held !== null) return { ok: false, code: "REPOSITORY_EXECUTION_BUSY", detail: "busy" };
      held = { owner, reservation: { ...owner, ...controller, identity, phase: "RESERVED", baselineId: null, sessionId: null, pid: null, revision: 1 } };
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
      expect(reason).toBe("PUBLISHED"); held = null; return { ok: true, released: true };
    },
  };
  return { port, held: () => held };
}
function world(bound = true, store = openStore()) {
  const decisionId = requestPublish(store, "publish-1", bound); const fence = reservation();
  let pushes = 0; let remote: string | null = null; let failPush = false; let throwPush = false;
  const git: PublicationGitPort = {
    async push(given) {
      pushes += 1; expect(given).toEqual(candidate);
      expect(fence.held()?.reservation.phase).toBe("PUBLISHING");
      expect(readPublicationIntent(store, PROJECT_ID, GOAL, decisionId)).toMatchObject({ candidate, decisionId });
      if (throwPush) throw new Error("lost effect response");
      if (failPush) return { ok: false, code: "PUBLISH_PUSH_UNKNOWN", detail: "unknown" };
      remote = approval.sha; return { ok: true };
    },
    async observe(given) { expect(given).toEqual(candidate); return { ok: true, sha: remote }; },
  };
  const config = { git, projectId: PROJECT_ID, store, workspace: identity.root, repository: fence.port,
    storeId: "D:/store.db", controller: { controllerId: "controller-1", controllerPid: 1234 }, processAlive: () => false };
  return { config, store, decisionId, fence, pushes: () => pushes,
    remote: (sha: string | null) => { remote = sha; }, fail: () => { failPush = true; }, throw: () => { throwPush = true; } };
}

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
    expect(await other.publishOnce()).toMatchObject([{ outcome: "UNKNOWN" }]); expect(w.fence.held()).not.toBeNull();
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
  it("refuses legacy unbound decisions without starting Git", async () => {
    const w = world(false); expect(await createNodePublisher(w.config).publishOnce()).toMatchObject([{ outcome: "REFUSED" }]);
    expect(w.pushes()).toBe(0); expect(w.fence.held()).toBeNull();
  });
  it("reports absent workspace without recording or performing an effect", async () => {
    const w = world(); expect(await createNodePublisher({ ...w.config, workspace: null }).publishOnce()).toMatchObject([{ outcome: "WORKSPACE_UNSET" }]);
    expect(w.pushes()).toBe(0); expect(readPublishLedger(w.store, PROJECT_ID).get(GOAL)?.receipts.size).toBe(0);
  });
});
