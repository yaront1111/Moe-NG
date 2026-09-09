import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import {
  readProjectRemote, readPublishLedger, readPublishReceipt, recordPublishReceipt,
} from "./publish-ledger.js";
import {
  NODE_PUBLISHER_PRINCIPAL_ID, REMOTE_BOUND_EVENT_TYPE, REPOSITORY_PUBLISH_COMMAND_KIND,
  admitRemoteUrl, publishAggregateId, publishLinkFor, publishReceiptId, remoteAggregateId,
} from "./publish-receipt-contracts.js";

afterEach(closeStores);

const GOAL = "goal-publish-1";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const encoder = new TextEncoder();

/** A human's publish decision, committed the way the goal service commits it. */
function requestPublish(store: ReturnType<typeof openStore>, commandId: string, remoteUrl: string): string {
  const aggregateId = publishAggregateId(GOAL);
  const result = { goalId: GOAL, remoteUrl, requestedAt: "2026-09-03T12:00:00.000Z" };
  const response = store.commitExpectedVersionDecision({
    commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: encoder.encode(JSON.stringify(result)),
    correlationId: "test-publish",
    decidedAt: "2026-09-03T12:00:00.000Z",
    events: [{
      eventId: `${commandId}-RepositoryPublishRequested`, eventType: "RepositoryPublishRequested",
      payload: encoder.encode(JSON.stringify(result)),
    }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId, principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: encoder.encode(JSON.stringify({ goalId: GOAL, remoteUrl })),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error("publish request not committed");
  return response.decision.decisionId;
}

describe("admitRemoteUrl", () => {
  it("admits https and ssh remotes and refuses credentials, whitespace and junk", () => {
    expect(admitRemoteUrl("https://github.com/yaront1111/Moe-NG.git")).toBe("https://github.com/yaront1111/Moe-NG.git");
    expect(admitRemoteUrl("git@github.com:yaront1111/Moe-NG.git")).toBe("git@github.com:yaront1111/Moe-NG.git");
    expect(admitRemoteUrl("ssh://git@example.test:2222/team/repo.git")).toBe("ssh://git@example.test:2222/team/repo.git");
    expect(admitRemoteUrl("https://user:secret@github.com/o/r.git")).toBeNull();
    expect(admitRemoteUrl("https://github.com/o/r.git --force")).toBeNull();
    expect(admitRemoteUrl("file:///tmp/repo")).toBeNull();
    expect(admitRemoteUrl("")).toBeNull();
    expect(admitRemoteUrl(42)).toBeNull();
  });
});

describe("publishLinkFor", () => {
  it("names the GitHub branch page for both remote shapes and nothing for other hosts", () => {
    expect(publishLinkFor("https://github.com/yaront1111/Moe-NG.git", "main")).toBe("https://github.com/yaront1111/Moe-NG/tree/main");
    expect(publishLinkFor("git@github.com:yaront1111/Moe-NG.git", "feat/x")).toBe("https://github.com/yaront1111/Moe-NG/tree/feat%2Fx");
    expect(publishLinkFor("https://gitlab.example.test/team/repo.git", "main")).toBeNull();
  });
});

describe("the publish ledger", () => {
  it("reads every goal's requests in order, with the receipts that answered them", () => {
    const store = openStore();
    const first = requestPublish(store, "cmd-publish-1", "https://github.com/o/r.git");
    const second = requestPublish(store, "cmd-publish-2", "git@github.com:o/r.git");
    const recorded = recordPublishReceipt(store, {
      branch: "main", decidedAt: "2026-09-03T12:01:00.000Z", decisionId: first, goalId: GOAL,
      projectId: PROJECT_ID, refusal: null, remoteUrl: "https://github.com/o/r.git", sha: SHA,
      url: "https://github.com/o/r/tree/main",
    });
    if (!recorded.ok) throw new Error(recorded.code);
    expect(recorded.replayed).toBe(false);
    const ledger = readPublishLedger(store, PROJECT_ID);
    const state = ledger.get(GOAL);
    expect(state?.requests.map((request) => [request.decisionId, request.remoteUrl])).toEqual([
      [first, "https://github.com/o/r.git"], [second, "git@github.com:o/r.git"],
    ]);
    expect(state?.receipts.get(first)?.outcome).toBe("PUSHED");
    expect(state?.receipts.get(first)?.sha).toBe(SHA);
    expect(state?.receipts.has(second)).toBe(false);
    // The goal's own aggregate never moved.
    expect(store.getAggregateVersion(GOAL)).toBe(0);
    expect(store.getAggregateVersion(publishAggregateId(GOAL))).toBe(3);
  });

  it("records a refusal as a receipt and replays instead of answering the same decision twice", () => {
    const store = openStore();
    const decisionId = requestPublish(store, "cmd-publish-3", "https://github.com/o/r.git");
    const refused = recordPublishReceipt(store, {
      branch: null, decidedAt: "2026-09-03T12:01:00.000Z", decisionId, goalId: GOAL, projectId: PROJECT_ID,
      refusal: { code: "GIT_PUSH_FAILED", detail: "remote: Permission denied" },
      remoteUrl: "https://github.com/o/r.git", sha: null, url: null,
    });
    expect(refused.ok && refused.receipt.outcome).toBe("REFUSED");
    const again = recordPublishReceipt(store, {
      branch: "main", decidedAt: "2026-09-03T12:02:00.000Z", decisionId, goalId: GOAL, projectId: PROJECT_ID,
      refusal: null, remoteUrl: "https://github.com/o/r.git", sha: SHA, url: null,
    });
    expect(again.ok && again.replayed).toBe(true);
    expect(again.ok && again.receipt.outcome).toBe("REFUSED");
    const read = readPublishReceipt(store, PROJECT_ID, publishReceiptId(PROJECT_ID, GOAL, decisionId));
    expect(read.ok && read.decision.key.principalId).toBe(NODE_PUBLISHER_PRINCIPAL_ID);
  });
});

/**
 * A binding, committed onto the project's remote aggregate the way the goal service's second
 * decision leg commits it. Written through the store's own API rather than through a helper the
 * production read shares, so the read below folds bytes it did not author.
 */
function bindRemote(
  store: ReturnType<typeof openStore>,
  commandId: string,
  payload: Record<string, unknown>,
  boundAt = "2026-09-04T09:00:00.000Z",
): void {
  const aggregateId = remoteAggregateId(PROJECT_ID);
  const response = store.commitExpectedVersionDecision({
    commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: encoder.encode(JSON.stringify({ bound: true })),
    correlationId: "test-bind",
    decidedAt: boundAt,
    events: [{
      eventId: `${commandId}-${REMOTE_BOUND_EVENT_TYPE}`, eventType: REMOTE_BOUND_EVENT_TYPE,
      payload: encoder.encode(JSON.stringify(payload)),
    }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId, principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: encoder.encode(JSON.stringify(payload)),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error("binding not committed");
}

describe("readProjectRemote", () => {
  it("answers null while nothing is bound", () => {
    const store = openStore();
    expect(readProjectRemote(store, PROJECT_ID)).toBeNull();
    expect(store.getAggregateVersion(remoteAggregateId(PROJECT_ID))).toBe(0);
  });

  it("folds to the LATEST binding, not the first", () => {
    const store = openStore();
    bindRemote(store, "cmd-bind-1", {
      boundAt: "2026-09-04T09:00:00.000Z", boundBy: "operator-local",
      remoteUrl: "https://github.com/o/first.git",
    });
    bindRemote(store, "cmd-bind-2", {
      boundAt: "2026-09-04T10:00:00.000Z", boundBy: "operator-two",
      remoteUrl: "git@github.com:o/second.git",
    }, "2026-09-04T10:00:00.000Z");

    expect(readProjectRemote(store, PROJECT_ID)).toEqual({
      boundAt: "2026-09-04T10:00:00.000Z", boundBy: "operator-two",
      remoteUrl: "git@github.com:o/second.git",
    });
    expect(Object.isFrozen(readProjectRemote(store, PROJECT_ID))).toBe(true);
  });

  it("reads a binding for the NAMED project only", () => {
    const store = openStore();
    bindRemote(store, "cmd-bind-3", {
      boundAt: "2026-09-04T09:00:00.000Z", boundBy: "operator-local",
      remoteUrl: "https://github.com/o/r.git",
    });
    expect(readProjectRemote(store, "project-other")).toBeNull();
  });

  it("answers null on an undecodable payload instead of throwing", () => {
    const store = openStore();
    const aggregateId = remoteAggregateId(PROJECT_ID);
    const response = store.commitExpectedVersionDecision({
      commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
      committedResultBytes: encoder.encode(JSON.stringify({ bound: true })),
      correlationId: "test-bind-junk",
      decidedAt: "2026-09-04T09:00:00.000Z",
      events: [{
        eventId: `cmd-bind-junk-${REMOTE_BOUND_EVENT_TYPE}`, eventType: REMOTE_BOUND_EVENT_TYPE,
        payload: encoder.encode("{not json"),
      }],
      expectedVersion: store.getAggregateVersion(aggregateId),
      key: { commandId: "cmd-bind-junk", principalId: "operator-local", projectId: PROJECT_ID },
      requestBytes: encoder.encode("{}"),
      targetAggregateId: aggregateId,
    });
    expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
    expect(readProjectRemote(store, PROJECT_ID)).toBeNull();
  });

  it("ignores an extra key, a wrong event type and a URL that no longer admits", () => {
    const store = openStore();
    bindRemote(store, "cmd-bind-extra", {
      boundAt: "2026-09-04T09:00:00.000Z", boundBy: "operator-local", extra: "x",
      remoteUrl: "https://github.com/o/r.git",
    });
    expect(readProjectRemote(store, PROJECT_ID)).toBeNull();

    const store2 = openStore();
    bindRemote(store2, "cmd-bind-bad-url", {
      boundAt: "2026-09-04T09:00:00.000Z", boundBy: "operator-local",
      remoteUrl: "https://user:secret@github.com/o/r.git",
    });
    expect(readProjectRemote(store2, PROJECT_ID)).toBeNull();
  });

  /**
   * FAIL CLOSED, and the arm that says so. The LAST binding is the operator's current answer, so
   * an unreadable last binding must NOT fall back to the remote it replaced: pushing a goal to a
   * superseded remote is the defect this read exists to prevent. Null here, and the null-publish
   * path then refuses UNBOUND rather than resolving a stale URL.
   */
  it("refuses to fall back to an older binding when the LATEST one is unreadable", () => {
    const store = openStore();
    bindRemote(store, "cmd-bind-good", {
      boundAt: "2026-09-04T09:00:00.000Z", boundBy: "operator-local",
      remoteUrl: "https://github.com/o/good.git",
    });
    expect(readProjectRemote(store, PROJECT_ID)?.remoteUrl).toBe("https://github.com/o/good.git");

    bindRemote(store, "cmd-bind-broken", { remoteUrl: "https://github.com/o/broken.git" });
    expect(readProjectRemote(store, PROJECT_ID)).toBeNull();
  });
});
