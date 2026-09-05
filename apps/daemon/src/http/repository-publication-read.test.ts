import { afterEach, expect, it } from "vitest";
import { GOAL_ID, PROJECT_ID, closeStores, driveThrough, openStore, FIXTURE_PUBLICATION_APPROVAL } from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createRepositoryRemoteReadPort, handleRepositoryRemoteReadRequest } from "./repository-remote-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { Authenticator } from "./http-contract.js";
afterEach(closeStores);
const encoder = new TextEncoder();
it("prepares only the exact approved route shape and exposes no private repository identity", () => {
  const store = openStore(); driveThrough(store, "repository.publish");
  let reads = 0;
  const repositoryRemote = createRepositoryRemoteReadPort({ projectId: PROJECT_ID, store,
    readPublicationCandidate: () => { reads += 1; return { ok: true, candidate: {
      approval: FIXTURE_PUBLICATION_APPROVAL, identity: { root: "D:/fixture/repo", gitDirectory: "D:/fixture/repo/.git" } } }; } });
  const authenticator: Authenticator = { authenticate: () => ({ verdict: "AUTHENTICATED", principal: {
    principalId: "human", projectId: PROJECT_ID, capabilities: [CAPABILITIES.GOAL] } }) };
  const dispatch = (value: unknown) => handleRepositoryRemoteReadRequest({ authenticator, repositoryRemote }, {
    body: encoder.encode(JSON.stringify(value)), credential: "test", protocolVersion: WIRE_PROTOCOL_VERSION });
  expect(dispatch({ goalId: GOAL_ID, remoteUrl: FIXTURE_PUBLICATION_APPROVAL.remoteUrl })).toMatchObject({ kind: "REPLY",
    body: { outcome: "PUBLICATION_CANDIDATE", goalId: GOAL_ID, approval: FIXTURE_PUBLICATION_APPROVAL } });
  const prepared = dispatch({ goalId: GOAL_ID, remoteUrl: FIXTURE_PUBLICATION_APPROVAL.remoteUrl });
  expect(JSON.stringify(prepared)).not.toContain("gitDirectory"); expect(JSON.stringify(prepared)).not.toContain("D:/");
  expect(dispatch({})).toMatchObject({ body: { outcome: "REMOTE" } });
  const count = reads;
  for (const malformed of [{ goalId: GOAL_ID }, { remoteUrl: null }, { goalId: GOAL_ID, remoteUrl: null, sha: "a" }, { goalId: GOAL_ID, remoteUrl: 7 }]) {
    expect(dispatch(malformed)).toMatchObject({ kind: "LISTENER_REFUSAL", code: "LISTENER_REPOSITORY_REMOTE_REQUEST_INVALID" });
  }
  expect(reads).toBe(count);
});
