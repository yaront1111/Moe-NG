import { afterEach, describe, expect, it } from "vitest";
import { ALL_HANDLERS, GOAL_ID, PROJECT_ID, closeStores, decisionCount, driveThrough, envelope, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { createPublishRepository } from "./publish-services.js";
import { publicationRepositoryId } from "./publication-approval-contracts.js";

const REMOTE = "https://github.com/example/product.git";
const identity = { gitDirectory: "D:/product/.git", root: "D:/product" };
const approval = { branch: "delivery", remoteUrl: REMOTE, repositoryId: publicationRepositoryId(identity), sha: "a".repeat(40) };
const candidate = { approval, identity };
const encoder = new TextEncoder();
afterEach(closeStores);

function world(kind: "HUMAN" | "AGENT" = "HUMAN", integrated = true) {
  const store = openStore(); driveThrough(store, "repository.publish");
  const principal = createSessionAuthority(store, { clock: () => Date.parse("2026-09-06T00:00:00Z"), projectId: PROJECT_ID })
    .createPrincipal({ commandId: `principal-${kind}`, correlationId: "publication", principalId: "principal-1",
      kind, profileRevisionId: "profile-publication" });
  expect(principal.ok).toBe(true);
  let reads = 0;
  const handler = createPublishRepository({ validateGoal: () => integrated, readPublicationCandidate: () => { reads += 1; return { candidate, ok: true }; } });
  const send = (approved: unknown, remoteUrl: unknown = REMOTE) => runBootstrapCommand(store,
    encoder.encode(JSON.stringify(envelope("repository.publish", 0, { approval: approved, goalId: GOAL_ID, remoteUrl }, "publish-approved"))),
    { ...ALL_HANDLERS, "repository.publish": handler });
  return { reads: () => reads, send, store };
}

describe("publication command approval", () => {
  it("records the exact daemon-observed tuple and canonical identity for a durable human", () => {
    const test = world();
    const result = test.send(approval);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(JSON.parse(new TextDecoder().decode(result.decision.resultBytes))).toEqual({
      candidate, goalId: GOAL_ID, remoteUrl: REMOTE, requestedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(test.reads()).toBe(1);
    const event = test.store.readEvents(`publish:${GOAL_ID}`).find((row) => row.eventType === "RepositoryPublishRequested");
    expect(event).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(event!.payload))).toEqual({ approval, goalId: GOAL_ID,
      remoteUrl: REMOTE, requestedAt: "2026-08-08T00:00:00.000Z" });
    expect(test.send(approval)).toMatchObject({ ok: true });
    expect(test.reads()).toBe(1);
  });

  it.each([
    { ...approval, sha: "b".repeat(40) }, { ...approval, branch: "different" },
    { ...approval, repositoryId: "c".repeat(64) }, { ...approval, remoteUrl: "https://github.com/example/other.git" },
  ])("refuses a changed approval tuple before any durable mutation", (approved) => {
    const test = world(); const before = decisionCount(test.store);
    expect(test.send(approved)).toMatchObject({ ok: false, code: "PUBLISH_APPROVAL_STALE", refusedBy: "DAEMON_PREREQUISITE" });
    expect(decisionCount(test.store)).toBe(before);
  });

  it("refuses an agent principal even when its id matches the configured legacy operator", () => {
    const test = world("AGENT"); const before = decisionCount(test.store);
    expect(test.send(approval)).toMatchObject({ ok: false, code: "PUBLISH_HUMAN_REQUIRED", refusedBy: "DAEMON_AUTHORIZATION" });
    expect(test.reads()).toBe(0);
    expect(decisionCount(test.store)).toBe(before);
  });

  it("does not accept an unbound legacy approval", () => {
    const test = world(); const before = decisionCount(test.store);
    expect(test.send(undefined)).toMatchObject({ ok: false, code: "PUBLISH_APPROVAL_REQUIRED", refusedBy: "DAEMON_INGRESS" });
    expect(test.reads()).toBe(0);
    expect(decisionCount(test.store)).toBe(before);
  });
  it("refuses a candidate whose credited goal landings are absent from its ancestry", () => {
    const test = world("HUMAN", false); const before = decisionCount(test.store);
    expect(test.send(approval)).toMatchObject({ ok: false, code: "PUBLISH_GOAL_NOT_INTEGRATED", refusedBy: "DAEMON_PREREQUISITE" });
    expect(test.reads()).toBe(1); expect(decisionCount(test.store)).toBe(before);
  });
});
