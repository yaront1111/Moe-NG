import { afterEach, describe, expect, it } from "vitest";
import type { PublicationGitPort } from "../repository/publication-effect-contracts.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { readPublishLedger } from "../repository/publish-ledger.js";
import { REPOSITORY_PUBLISH_COMMAND_KIND, publishAggregateId } from "../repository/publish-receipt-contracts.js";
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
    async observe() { throw new Error("unbound request must not query remote"); } };
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
