import { afterEach, describe, expect, it } from "vitest";
import { closeStores, openStore, PROJECT_ID } from "../review/review-test-fixtures.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import { readRepositoryLandingEvidence, recordRepositoryLandingCompletion, recordRepositoryLandingIntent } from "./repository-landing-intent.js";
import type { RepositoryLandingIntentInput } from "./repository-landing-intent-contracts.js";

afterEach(closeStores);
const handle: RepositoryExecutionHandle = {
  owner: { projectId: PROJECT_ID, nodeRef: "graph:node", ownershipToken: "a".repeat(64), storeId: "D:/store.sqlite" },
  reservation: { projectId: PROJECT_ID, nodeRef: "graph:node", storeId: "D:/store.sqlite", controllerId: "controller", controllerPid: 31,
    revision: 7, phase: "LANDING", baselineId: "original-baseline", sessionId: "original-session", pid: 71,
    identity: { root: "D:/repository", gitDirectory: "D:/repository/.git" } },
};
const input: RepositoryLandingIntentInput = { handle, verifierReceiptId: "b".repeat(64), paths: ["src/a.ts"], message: "land\n",
  binding: { version: "moe-verified-workspace/1", root: "D:/repository", branchRef: "refs/heads/trunk",
    headSha: "1".repeat(40), treeSha: "2".repeat(40), dirtySha256: "3".repeat(64) } };
const commit = { branch: "trunk", parentSha: input.binding.headSha, sha: "4".repeat(40) };
describe("owner-bound immutable landing journal", () => {
  it("records an immutable exact intent without persisting the owner token", () => {
    const store = openStore(); const written = recordRepositoryLandingIntent(store, input);
    expect(written.ok, JSON.stringify(written)).toBe(true); if (!written.ok) throw new Error(written.code);
    expect(JSON.stringify(written.intent)).not.toContain(handle.owner.ownershipToken);
    expect(written.intent).toMatchObject({ baselineId: "original-baseline", sessionId: "original-session", binding: input.binding });
    expect(readRepositoryLandingEvidence(store, handle)).toEqual({ ok: true, intent: written.intent, completion: null });
    expect(recordRepositoryLandingIntent(store, input)).toEqual(written);
    expect(recordRepositoryLandingIntent(store, { ...input, paths: ["foreign.ts"] })).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_CONFLICT" });
    expect(readRepositoryLandingEvidence(store, { ...handle, owner: { ...handle.owner, ownershipToken: "f".repeat(64) } })).toMatchObject({ ok: false });
  });
  it("records positive Git completion separately from intent and binds every receipt field", () => {
    const store = openStore(); const written = recordRepositoryLandingIntent(store, input);
    expect(written.ok).toBe(true); if (!written.ok) throw new Error(written.code);
    const completed = recordRepositoryLandingCompletion(store, { intent: written.intent, commit });
    expect(completed.ok, JSON.stringify(completed)).toBe(true);
    expect(readRepositoryLandingEvidence(store, handle)).toMatchObject({ ok: true, completion: { commit: { ...commit, files: input.paths, message: input.message } } });
    expect(recordRepositoryLandingCompletion(store, { intent: written.intent, commit: { ...commit, sha: "5".repeat(40) } }))
      .toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_CONFLICT" });
  });
  it("refuses wrong phase, physical root, session, parent or branch evidence", () => {
    const store = openStore();
    for (const forged of [
      { ...input, handle: { ...handle, reservation: { ...handle.reservation, phase: "BLOCKED" as const } } },
      { ...input, binding: { ...input.binding, root: "D:/other" } },
      { ...input, handle: { ...handle, reservation: { ...handle.reservation, sessionId: null } } },
    ]) expect(recordRepositoryLandingIntent(store, forged)).toMatchObject({ ok: false });
    const written = recordRepositoryLandingIntent(store, input); expect(written.ok).toBe(true); if (!written.ok) throw new Error(written.code);
    for (const forged of [{ ...commit, branch: "other" }, { ...commit, parentSha: "9".repeat(40) }]) {
      expect(recordRepositoryLandingCompletion(store, { intent: written.intent, commit: forged })).toMatchObject({ ok: false });
    }
    expect(readRepositoryLandingEvidence(store, { ...handle, reservation: { ...handle.reservation, sessionId: "another-session" } })).toMatchObject({ ok: false });
  });
});
