import { afterEach, describe, expect, it } from "vitest";

import type { GitCommitResult, GitLandingPort, GitObserveResult } from "../repository/git-landing-port.js";
import { readLandingReceipt, readLatestLandingBaseline } from "../repository/landing-ledger.js";
import { DELETED_BLOB, landingReceiptId } from "../repository/landing-receipt-contracts.js";
import type { LandingBaselineEntry } from "../repository/landing-receipt-contracts.js";
import { PROJECT_ID, closeStores, hex64, openStore, seedVerifierReceipt } from "../review/review-test-fixtures.js";
import { readVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import { createNodeLander, deliveredPaths, landingMessage } from "./node-lander.js";
import type { NodeMission } from "./agent-wrapper.js";
import type { VerifiedWorkspaceBinding, VerifiedWorkspacePort } from "../repository/verified-workspace-contracts.js";

afterEach(closeStores);

const NODE = "node-land-1";
const WORKSPACE = "D:/ws/project";
const VERIFIER_RECEIPT = hex64("ab");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);
const BLOB_C = "c".repeat(40);
const BINDING: VerifiedWorkspaceBinding = {
  branchRef: "refs/heads/main", dirtySha256: "d".repeat(64), headSha: "f".repeat(40), root: WORKSPACE,
  treeSha: "2".repeat(40), version: "moe-verified-workspace/1",
};

const brief: NodeMission = Object.freeze({
  instructions: "build it", test: "pnpm test", title: "Implement the evidence ledger\nmore", workspace: WORKSPACE,
});

interface FakeGit extends GitLandingPort {
  readonly commits: { paths: readonly string[]; message: string; workspace: string }[];
  observations: GitObserveResult[];
  commitResult: GitCommitResult;
}

function observation(entries: readonly LandingBaselineEntry[]): GitObserveResult {
  return { observation: { entries, root: WORKSPACE }, ok: true };
}

function fakeGit(first: GitObserveResult): FakeGit {
  const git: FakeGit = {
    commitResult: { ok: true, receipt: { branch: "main", parentSha: "f".repeat(40), sha: SHA } },
    commits: [],
    observations: [first],
    async commit(workspace, paths, message) {
      git.commits.push({ message, paths, workspace });
      return git.commitResult;
    },
    async observe() {
      const next = git.observations.length > 1 ? git.observations.shift() : git.observations[0];
      return next as GitObserveResult;
    },
  };
  return git;
}

function bindingOptions(git: GitLandingPort): {
  readVerifiedBinding: () => VerifiedWorkspaceBinding;
  verifiedWorkspace: VerifiedWorkspacePort;
} {
  return {
    readVerifiedBinding: () => BINDING,
    verifiedWorkspace: { capture: async () => ({ binding: BINDING, ok: true as const }), commit: git.commit.bind(git) },
  };
}

function lander(git: GitLandingPort, accepted: { verifierReceiptId: string } | null, mission = brief,
  bindings = bindingOptions(git)) {
  const store = openStore();
  const made = createNodeLander({
    ...bindings,
    clock: () => "2026-09-03T12:00:00.000Z",
    git,
    nodeMission: () => mission,
    nodes: () => [{ nodeRef: NODE }],
    projectId: PROJECT_ID,
    readAccepted: () => accepted,
    store,
  });
  return { made, store };
}

describe("deliveredPaths", () => {
  it("names paths that are new or whose content moved since the baseline, and nothing else", () => {
    const baseline = [
      { blobId: BLOB_A, path: "operator-dirty.ts" },
      { blobId: BLOB_B, path: "seat-rewrites.ts" },
      { blobId: DELETED_BLOB, path: "operator-deleted.ts" },
    ];
    const observed = [
      { blobId: BLOB_A, path: "operator-dirty.ts" },
      { blobId: BLOB_C, path: "seat-rewrites.ts" },
      { blobId: DELETED_BLOB, path: "operator-deleted.ts" },
      { blobId: BLOB_C, path: "src/new.ts" },
      { blobId: DELETED_BLOB, path: "src/old.ts" },
    ];
    expect(deliveredPaths(baseline, observed)).toEqual(["seat-rewrites.ts", "src/new.ts", "src/old.ts"]);
  });

  it("delivers nothing when the workspace is exactly as staffed", () => {
    const same = [{ blobId: BLOB_A, path: "a.ts" }];
    expect(deliveredPaths(same, same)).toEqual([]);
  });
});

describe("landingMessage", () => {
  it("uses the first line of the title as the subject and names the verification", () => {
    const message = landingMessage(brief, NODE, VERIFIER_RECEIPT);
    const lines = message.split("\n");
    expect(lines[0]).toBe("Implement the evidence ledger");
    expect(lines[1]).toBe("");
    expect(message).toContain(`Moe landed node ${NODE}`);
    expect(message).toContain("Verified: pnpm test in D:/ws/project");
    expect(message).toContain(`Verifier receipt: ${VERIFIER_RECEIPT}`);
  });
});

describe("createNodeLander", () => {
  it("refuses a previously accepted node whose verifier receipt has no workspace binding", async () => {
    const git = fakeGit(observation([]));
    const store = openStore();
    const legacy = seedVerifierReceipt(store, NODE);
    const receipt = readVerifierReceipt(store, PROJECT_ID, legacy.receiptId);
    expect(receipt.ok && receipt.receipt.execution.workspaceBinding).toBeUndefined();
    const made = createNodeLander({
      git, nodeMission: () => ({ ...brief, workspace: "/fixture-workspace" }), nodes: () => [{ nodeRef: NODE }], projectId: PROJECT_ID,
      readAccepted: () => ({ verifierReceiptId: legacy.receiptId }), store,
      verifiedWorkspace: bindingOptions(git).verifiedWorkspace,
    });
    await made.baseline(NODE);
    git.observations = [observation([{ blobId: BLOB_B, path: "changed.ts" }])];
    expect(await made.landOnce()).toEqual([expect.objectContaining({ outcome: "REFUSED", detail: expect.stringContaining("LANDING_VERIFIER_BINDING_MISSING") })]);
    expect(git.commits).toEqual([]);
  });

  it("refuses bytes changed after verification before any commit", async () => {
    const git = fakeGit(observation([]));
    const { made } = lander(git, { verifierReceiptId: VERIFIER_RECEIPT }, brief, {
      ...bindingOptions(git), verifiedWorkspace: {
        ...bindingOptions(git).verifiedWorkspace,
        capture: async () => ({ binding: { ...BINDING, treeSha: "3".repeat(40) }, ok: true as const }),
      },
    });
    await made.baseline(NODE);
    git.observations = [observation([{ blobId: BLOB_B, path: "changed.ts" }])];
    expect(await made.landOnce()).toEqual([expect.objectContaining({ outcome: "REFUSED", detail: expect.stringContaining("LANDING_VERIFIED_WORKSPACE_CHANGED") })]);
    expect(git.commits).toEqual([]);
  });

  it("lands tracked, added and deleted work against the reservation's original baseline after a retry", async () => {
    const git = fakeGit(observation([]));
    const store = openStore();
    let originalBaseline: string | null = null;
    const made = createNodeLander({
      ...bindingOptions(git), baselineId: () => originalBaseline,
      git, nodeMission: () => brief, nodes: () => [{ nodeRef: NODE }], projectId: PROJECT_ID,
      readAccepted: () => ({ verifierReceiptId: VERIFIER_RECEIPT }), store,
    });
    const first = await made.baseline(NODE);
    originalBaseline = first.baselineId ?? null;
    const delivered = [{ blobId: BLOB_B, path: "tracked.ts" }, { blobId: BLOB_B, path: "added.ts" }, { blobId: DELETED_BLOB, path: "deleted.ts" }];
    git.observations = [observation(delivered)];
    await made.baseline(NODE);
    expect(readLatestLandingBaseline(store, PROJECT_ID, NODE)?.entries).toEqual(delivered);
    expect(await made.landOnce()).toEqual([expect.objectContaining({ outcome: "COMMITTED" })]);
    expect(git.commits[0]?.paths).toEqual(["tracked.ts", "added.ts", "deleted.ts"]);
  });

  it("records a baseline of the dirty paths when the seat is staffed", async () => {
    const git = fakeGit(observation([{ blobId: BLOB_A, path: "operator-dirty.ts" }]));
    const { made, store } = lander(git, null);
    const report = await made.baseline(NODE);
    expect(report).toEqual({ baselineId: expect.stringMatching(/^[a-f0-9]{64}$/u), detail: "1 dirty path(s) before the seat", nodeRef: NODE, outcome: "BASELINE_RECORDED" });
    expect(readLatestLandingBaseline(store, PROJECT_ID, NODE)?.entries).toEqual([
      { blobId: BLOB_A, path: "operator-dirty.ts" },
    ]);
  });

  it("commits exactly the seat's paths on acceptance and records the landing once", async () => {
    const git = fakeGit(observation([{ blobId: BLOB_A, path: "operator-dirty.ts" }]));
    const { made, store } = lander(git, { verifierReceiptId: VERIFIER_RECEIPT });
    await made.baseline(NODE);
    git.observations = [observation([
      { blobId: BLOB_A, path: "operator-dirty.ts" },
      { blobId: BLOB_B, path: "src/kernel/evidence.ts" },
      { blobId: BLOB_C, path: "src/kernel/evidence.test.ts" },
    ])];
    const first = await made.landOnce();
    expect(first).toEqual([{
      detail: `${SHA.slice(0, 10)} on main, 2 file(s)`, nodeRef: NODE, outcome: "COMMITTED",
    }]);
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]?.paths).toEqual(["src/kernel/evidence.ts", "src/kernel/evidence.test.ts"]);
    expect(git.commits[0]?.workspace).toBe(WORKSPACE);
    const receipt = readLandingReceipt(store, PROJECT_ID, landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT));
    expect(receipt.ok && receipt.receipt.outcome).toBe("COMMITTED");
    expect(receipt.ok && receipt.receipt.commit?.files).toEqual(["src/kernel/evidence.ts", "src/kernel/evidence.test.ts"]);
    expect(receipt.ok && receipt.receipt.commit?.sha).toBe(SHA);
    // A second pass is silent and commits nothing again.
    expect(await made.landOnce()).toEqual([]);
    expect(git.commits).toHaveLength(1);
  });

  it("carries the untracked modules the landed code imports, so HEAD still builds", async () => {
    // identities.ts was untracked BEFORE the seat (dirt to the baseline); the seat's evidence.ts
    // imports it. Without this, evidence.ts landed alone and HEAD did not build (UnAI cbca86a).
    const identities = { blobId: BLOB_A, path: "src/kernel/identities.ts" };
    const operator = { blobId: BLOB_A, path: "src/operator-notes.ts" };
    const git = fakeGit(observation([identities, operator]));
    const texts = new Map<string, string>([
      ["src/kernel/evidence.ts", 'import { uuidV7 } from "./identities.ts";\nimport { x } from "../operator-notes.js";\n'],
      ["src/kernel/identities.ts", 'import { now } from "./clock";\n'],
      ["src/kernel/clock.ts", "export const now = () => 1;\n"],
    ]);
    const store = openStore();
    const made = createNodeLander({
      ...bindingOptions(git),
      clock: () => "2026-09-03T12:00:00.000Z", git, nodeMission: () => brief,
      nodes: () => [{ nodeRef: NODE }], projectId: PROJECT_ID,
      readAccepted: () => ({ verifierReceiptId: VERIFIER_RECEIPT }),
      readText: (_root, path) => texts.get(path) ?? null, store,
    });
    await made.baseline(NODE);
    const clock = { blobId: BLOB_C, path: "src/kernel/clock.ts" };
    git.observations = [{
      observation: {
        entries: [clock, { blobId: BLOB_B, path: "src/kernel/evidence.ts" }, identities, operator],
        root: WORKSPACE,
        // operator-notes.ts is tracked-but-modified: imported, yet NOT carried.
        untracked: ["src/kernel/clock.ts", "src/kernel/identities.ts"],
      },
      ok: true,
    }];
    const reports = await made.landOnce();
    expect(reports[0]?.outcome).toBe("COMMITTED");
    expect(reports[0]?.detail).toContain("3 file(s), 1 imported untracked file(s) carried");
    // clock.ts is delivered on its own merits (new since the baseline); identities.ts is carried
    // through the import; operator-notes.ts stays the operator's.
    expect(git.commits[0]?.paths).toEqual([
      "src/kernel/clock.ts", "src/kernel/evidence.ts", "src/kernel/identities.ts",
    ]);
    const receipt = readLandingReceipt(store, PROJECT_ID, landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT));
    expect(receipt.ok && receipt.receipt.commit?.files).toEqual(git.commits[0]?.paths);
  });

  it("lands a dead earlier attempt's files when the re-staffed seat writes nothing new", async () => {
    // Staffing 1: only operator dirt. The seat writes redaction.ts and dies. Staffing 2: the
    // baseline now holds redaction.ts as "dirt"; the new seat finds the work done and writes
    // nothing. Without this, NOTHING_TO_COMMIT and HEAD never gets redaction.ts (UnAI, 2026-09-05).
    const operator = { blobId: BLOB_A, path: "src/operator-notes.ts" };
    const redaction = { blobId: BLOB_B, path: "src/kernel/redaction.ts" };
    const git = fakeGit(observation([operator]));
    const { made, store } = lander(git, { verifierReceiptId: VERIFIER_RECEIPT });
    await made.baseline(NODE);
    git.observations = [observation([operator, redaction])];
    await made.baseline(NODE);
    git.observations = [{
      observation: { entries: [operator, redaction], root: WORKSPACE, untracked: ["src/kernel/redaction.ts"] },
      ok: true,
    }];
    const reports = await made.landOnce();
    expect(reports[0]?.outcome).toBe("COMMITTED");
    expect(reports[0]?.detail).toContain("1 file(s), 1 from an earlier attempt");
    expect(git.commits[0]?.paths).toEqual(["src/kernel/redaction.ts"]);
    const receipt = readLandingReceipt(store, PROJECT_ID, landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT));
    expect(receipt.ok && receipt.receipt.commit?.files).toEqual(["src/kernel/redaction.ts"]);
  });

  it("refuses durably, with its code, when no baseline was recorded for the node", async () => {
    const git = fakeGit(observation([{ blobId: BLOB_B, path: "src/new.ts" }]));
    const { made, store } = lander(git, { verifierReceiptId: VERIFIER_RECEIPT });
    const reports = await made.landOnce();
    expect(reports[0]?.outcome).toBe("REFUSED");
    expect(reports[0]?.detail).toContain("LANDING_BASELINE_MISSING");
    expect(git.commits).toHaveLength(0);
    const receipt = readLandingReceipt(store, PROJECT_ID, landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT));
    expect(receipt.ok && receipt.receipt.refusal?.code).toBe("LANDING_BASELINE_MISSING");
    expect(await made.landOnce()).toEqual([]);
  });

  it("refuses durably when nothing differs from the baseline", async () => {
    const git = fakeGit(observation([{ blobId: BLOB_A, path: "operator-dirty.ts" }]));
    const { made, store } = lander(git, { verifierReceiptId: VERIFIER_RECEIPT });
    await made.baseline(NODE);
    const reports = await made.landOnce();
    expect(reports[0]?.detail).toContain("NOTHING_TO_COMMIT");
    const receipt = readLandingReceipt(store, PROJECT_ID, landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT));
    expect(receipt.ok && receipt.receipt.outcome).toBe("REFUSED");
  });

  it("records a commit failure with git's own words and does not retry it", async () => {
    const git = fakeGit(observation([]));
    git.commitResult = { code: "GIT_COMMIT_FAILED", detail: "pre-commit hook refused", ok: false };
    const { made } = lander(git, { verifierReceiptId: VERIFIER_RECEIPT });
    await made.baseline(NODE);
    git.observations = [observation([{ blobId: BLOB_B, path: "src/new.ts" }])];
    const reports = await made.landOnce();
    expect(reports[0]?.outcome).toBe("REFUSED");
    expect(reports[0]?.detail).toBe("GIT_COMMIT_FAILED: pre-commit hook refused");
    expect(await made.landOnce()).toEqual([]);
  });

  it("records a refusal when only error prose mentions an index lock", async () => {
    const git = fakeGit(observation([]));
    const { made, store } = lander(git, { verifierReceiptId: VERIFIER_RECEIPT });
    await made.baseline(NODE);
    git.observations = [observation([{ blobId: BLOB_B, path: "src/new.ts" }])];
    git.commitResult = {
      code: "GIT_COMMIT_FAILED", ok: false,
      detail: "fatal: Unable to create 'D:/ws/project/.git/index.lock': File exists.",
    };
    expect(await made.landOnce()).toEqual([{
      detail: "GIT_COMMIT_FAILED: fatal: Unable to create 'D:/ws/project/.git/index.lock': File exists.",
      nodeRef: NODE, outcome: "REFUSED",
    }]);
    const receipt = readLandingReceipt(store, PROJECT_ID, landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT));
    expect(receipt.ok && receipt.receipt.outcome).toBe("REFUSED");
    // Arbitrary prose cannot prove no effect, even if the injected port later says it can commit.
    git.commitResult = { ok: true, receipt: { branch: "main", parentSha: "f".repeat(40), sha: SHA } };
    expect(await made.landOnce()).toEqual([]);
    expect(git.commits).toHaveLength(1);
  });

  it("reports a transient git failure without recording anything, so the next pass retries", async () => {
    const git = fakeGit(observation([]));
    const { made, store } = lander(git, { verifierReceiptId: VERIFIER_RECEIPT });
    await made.baseline(NODE);
    git.observations = [{ code: "GIT_FAILED", detail: "index.lock exists", ok: false }];
    const reports = await made.landOnce();
    expect(reports).toEqual([{ detail: "index.lock exists", nodeRef: NODE, outcome: "GIT_FAILED" }]);
    const receipt = readLandingReceipt(store, PROJECT_ID, landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT));
    expect(receipt.ok).toBe(false);
  });

  it("retries the verified workspace index-lock refusal without consuming acceptance", async () => {
    const git = fakeGit(observation([]));
    const bindings = bindingOptions(git);
    const originalCommit = bindings.verifiedWorkspace.commit;
    let locked = true;
    bindings.verifiedWorkspace.commit = async (...args) => locked
      ? { code: "VERIFIED_WORKSPACE_INDEX_LOCKED", detail: "VERIFIED_WORKSPACE_INDEX_LOCKED", ok: false }
      : originalCommit(...args);
    const { made, store } = lander(git, { verifierReceiptId: VERIFIER_RECEIPT }, brief, bindings);
    await made.baseline(NODE);
    git.observations = [observation([{ blobId: BLOB_B, path: "src/new.ts" }])];
    expect(await made.landOnce()).toEqual([{
      detail: "VERIFIED_WORKSPACE_INDEX_LOCKED", nodeRef: NODE, outcome: "GIT_INDEX_LOCKED",
    }]);
    expect(readLandingReceipt(store, PROJECT_ID, landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT)).ok).toBe(false);
    locked = false;
    expect((await made.landOnce())[0]?.outcome).toBe("COMMITTED");
  });

  it("stays silent for a node the daemon has not accepted", async () => {
    const git = fakeGit(observation([{ blobId: BLOB_B, path: "src/new.ts" }]));
    const { made } = lander(git, null);
    expect(await made.landOnce()).toEqual([]);
    expect(git.commits).toHaveLength(0);
  });
});
