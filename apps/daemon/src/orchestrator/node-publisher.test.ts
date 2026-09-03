import { afterEach, describe, expect, it } from "vitest";

import type { GitPublishPort, GitPushResult } from "../repository/git-landing-port.js";
import { readPublishLedger } from "../repository/publish-ledger.js";
import { REPOSITORY_PUBLISH_COMMAND_KIND, publishAggregateId } from "../repository/publish-receipt-contracts.js";
import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { createNodePublisher } from "./node-publisher.js";

afterEach(closeStores);

const GOAL = "goal-publisher-1";
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const encoder = new TextEncoder();

function requestPublish(store: ReturnType<typeof openStore>, commandId: string, remoteUrl: string): string {
  const aggregateId = publishAggregateId(GOAL);
  const result = { goalId: GOAL, remoteUrl, requestedAt: "2026-09-03T12:00:00.000Z" };
  const response = store.commitExpectedVersionDecision({
    commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: encoder.encode(JSON.stringify(result)),
    correlationId: "test-publish", decidedAt: "2026-09-03T12:00:00.000Z",
    events: [{ eventId: `${commandId}-Requested`, eventType: "RepositoryPublishRequested", payload: encoder.encode("{}") }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId, principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: encoder.encode("{}"), targetAggregateId: aggregateId,
  });
  return response.decision.decisionId;
}

function fakeGit(result: GitPushResult): GitPublishPort & { readonly pushes: { remoteUrl: string; workspace: string }[] } {
  const pushes: { remoteUrl: string; workspace: string }[] = [];
  return { pushes, async push(workspace, remoteUrl) { pushes.push({ remoteUrl, workspace }); return result; } };
}

describe("createNodePublisher", () => {
  it("pushes once per decision to the remote it names, records the receipt with the link, then stays silent", async () => {
    const store = openStore();
    const decisionId = requestPublish(store, "cmd-p1", "https://github.com/o/r.git");
    const git = fakeGit({ ok: true, receipt: { branch: "main", sha: SHA } });
    const publisher = createNodePublisher({
      clock: () => "2026-09-03T12:05:00.000Z", git, projectId: PROJECT_ID, store, workspace: "D:/ws",
    });
    const reports = await publisher.publishOnce();
    expect(reports).toEqual([{
      detail: `${SHA.slice(0, 10)} main -> https://github.com/o/r.git (https://github.com/o/r/tree/main)`,
      goalId: GOAL, outcome: "PUSHED",
    }]);
    expect(git.pushes).toEqual([{ remoteUrl: "https://github.com/o/r.git", workspace: "D:/ws" }]);
    const receipt = readPublishLedger(store, PROJECT_ID).get(GOAL)?.receipts.get(decisionId);
    expect(receipt).toMatchObject({ branch: "main", outcome: "PUSHED", sha: SHA, url: "https://github.com/o/r/tree/main" });
    expect(await publisher.publishOnce()).toEqual([]);
    expect(git.pushes).toHaveLength(1);
  });

  it("records a refused push with git's words and does not retry it under the same decision", async () => {
    const store = openStore();
    requestPublish(store, "cmd-p2", "git@github.com:o/r.git");
    const git = fakeGit({ code: "GIT_PUSH_FAILED", detail: "remote: Permission denied", ok: false });
    const publisher = createNodePublisher({ git, projectId: PROJECT_ID, store, workspace: "D:/ws" });
    const reports = await publisher.publishOnce();
    expect(reports[0]).toMatchObject({ goalId: GOAL, outcome: "REFUSED" });
    expect(reports[0]?.detail).toBe("GIT_PUSH_FAILED: remote: Permission denied");
    expect(await publisher.publishOnce()).toEqual([]);
    expect(git.pushes).toHaveLength(1);
    // A new decision is a new push.
    requestPublish(store, "cmd-p3", "git@github.com:o/r.git");
    await publisher.publishOnce();
    expect(git.pushes).toHaveLength(2);
  });

  it("reports, without recording, when no workspace is configured", async () => {
    const store = openStore();
    requestPublish(store, "cmd-p4", "https://github.com/o/r.git");
    const git = fakeGit({ ok: true, receipt: { branch: "main", sha: SHA } });
    const publisher = createNodePublisher({ git, projectId: PROJECT_ID, store, workspace: null });
    expect(await publisher.publishOnce()).toEqual([{ detail: "MOE_NODE_WORKSPACE is not set", goalId: GOAL, outcome: "WORKSPACE_UNSET" }]);
    expect(git.pushes).toHaveLength(0);
    expect(readPublishLedger(store, PROJECT_ID).get(GOAL)?.receipts.size).toBe(0);
  });
});
