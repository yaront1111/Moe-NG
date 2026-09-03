import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { readPublishLedger, readPublishReceipt, recordPublishReceipt } from "./publish-ledger.js";
import {
  NODE_PUBLISHER_PRINCIPAL_ID, REPOSITORY_PUBLISH_COMMAND_KIND, admitRemoteUrl, publishAggregateId,
  publishLinkFor, publishReceiptId,
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
