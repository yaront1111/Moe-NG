import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { calibration, envelope, packageItems, policyInput, send, submitPayload } from "../review/review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "../review/verifier-receipt-ledger.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { ensureNodeTree, forgetNodeTrees } from "./node-worktrees.js";
import { createRepositoryDeliveryRuntime, readRepositoryDeliveryFacts } from "./repository-delivery-runtime.js";

/**
 * THE CONFLICT EXIT, END TO END, OVER REAL GIT AND THE PRODUCTION COMPOSITION (UnAI 2026-09-19).
 * Three nodes code in their own working trees; two edit the same line. Nothing is stood in but the
 * seats themselves and the verifier's test command: the runtime, coordinator, verifier, lander,
 * integrator, withdrawal scanner, stores and Git are the ones production runs. It lives beside
 * repository-delivery-runtime.test.ts rather than in it because that file is already past the
 * size this repository splits at.
 */
const cleanup: (() => void)[] = [];
afterEach(() => { forgetNodeTrees(); for (const close of cleanup.splice(0).reverse()) close(); });
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"] }).trim();
const NODES = ["a", "b", "c"] as const;

function fixture() {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "moe-delivery-withdrawal-")));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const workspace = join(directory, "repo"); mkdirSync(workspace);
  git(workspace, "init", "--quiet", "-b", "main");
  git(workspace, "config", "user.email", "integration@example.test");
  git(workspace, "config", "user.name", "Integration Fixture");
  git(workspace, "config", "core.autocrlf", "false");
  writeFileSync(join(workspace, "shared.txt"), "base\n");
  git(workspace, "add", "--", "shared.txt");
  git(workspace, "commit", "--quiet", "-m", "initial");
  const trees = new Map(NODES.map((nodeRef) => {
    const tree = ensureNodeTree({ nodeRef, projectRoot: workspace });
    if (tree === null) throw new Error(`no tree for ${nodeRef}`);
    return [nodeRef as string, tree] as const;
  }));
  const projectId = "withdrawal-runtime"; const credential = "operator-withdrawal-runtime";
  const storePath = join(directory, "store.db");
  const provider = createStoreDependencies({ credential, principalId: "operator-local", projectId, storePath });
  cleanup.push(() => provider.close());
  const store = SqliteEventStore.openForProject(storePath, projectId); cleanup.push(() => store.close());
  installTestRecoveryBinding(store);
  const logs: string[] = [];
  const runtime = createRepositoryDeliveryRuntime({ compiledWorkspace: workspace, landingOn: true, nodes: () => NODES.map((nodeRef) => ({ nodeRef })),
    log: (line) => logs.push(line), storePath,
    fence: { admit: () => ({ ok: true }), recordLiveChild: () => [], retireLiveChild: () => [] },
    verifier: { deps: provider.provide(), mintId: randomUUID, operatorCredential: credential, projectId, store,
      nodeMission: (nodeRef) => trees.has(nodeRef) ? { instructions: "implement", test: "test-fixture", title: `Node ${nodeRef}`, workspace: trees.get(nodeRef)!.path } : null,
      verificationAuthority: () => ({ calibration: calibration(), packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
        policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) }),
      runTest: async () => ({ byteCount: 2, exitCode: 0, output: "ok", sha256: createHash("sha256").update("ok").digest("hex") }),
    },
  });
  cleanup.push(() => { void runtime.close(); });
  /** One seat: staffed in the node's own tree, does `work` there, submits a clean review, exits. */
  const seat = async (nodeRef: string, work: (tree: string) => void): Promise<void> => {
    const tree = trees.get(nodeRef)!.path;
    const request: SpawnRequest = { credential: "seat", expiresAt: "2026-09-20T00:00:00.000Z", kind: "node.deliver",
      mission: "implement", sessionId: randomUUID(), workItemId: `node.deliver@${nodeRef}`, workspace: tree };
    const started = await runtime.start(async () => ({ ok: true, pid: process.pid, exit: Promise.resolve() }))(request);
    if (!started.ok) throw new Error(`${nodeRef}: ${started.code}\n${logs.join("\n")}`);
    work(tree);
    const review = readReviewLedger(store, projectId, nodeRef);
    expect(send(store, { ...envelope("review.submit", review.version, submitPayload(review.lineage.highestRound + 1, [], { subjectRef: nodeRef }), randomUUID()), projectId }).ok).toBe(true);
    await started.exit;
  };
  const landedSha = (nodeRef: string): string => {
    const accepted = readReviewLedger(store, projectId, nodeRef).accepted;
    if (accepted === undefined) throw new Error(`${nodeRef} is not accepted\n${logs.join("\n")}`);
    const landed = readLandingReceipt(store, projectId, landingReceiptId(projectId, nodeRef, accepted.verifierReceiptId));
    if (!landed.ok || landed.receipt.commit === null) throw new Error(`${nodeRef} did not land\n${logs.join("\n")}`);
    return landed.receipt.commit.sha;
  };
  const merged = (sha: string): boolean => {
    try { git(workspace, "merge-base", "--is-ancestor", sha, "HEAD"); return true; } catch { return false; }
  };
  return { facts: (nodeRef: string) => readRepositoryDeliveryFacts(store, projectId, nodeRef), landedSha, logs, merged,
    projectId, runtime, seat, store, trees, workspace };
}

it("returns a conflicted node to a seat, merges the branch that waited behind it in the same pass, and lands the seat's merge", async (context) => {
  const f = fixture();
  context.onTestFailed(() => { console.error(f.logs.join("\n")); });
  await f.seat("a", (tree) => writeFileSync(join(tree, "shared.txt"), "a edits the shared line\n"));
  await f.seat("b", (tree) => writeFileSync(join(tree, "shared.txt"), "b edits the same line\n"));

  await f.runtime.advance();

  expect(f.logs.filter((line) => line.startsWith("[integration]"))).toEqual([
    expect.stringContaining("[integration] a: MERGED"), expect.stringContaining("[integration] b: CONFLICT")]);
  const conflictedSha = f.landedSha("b");
  expect(f.facts("b")).toBe("LANDED");

  // A third node lands while the conflict is unanswered. Before the withdrawal it waited forever.
  await f.seat("c", (tree) => writeFileSync(join(tree, "c.txt"), "c\n"));
  const mark = f.logs.length;

  await f.runtime.advance();

  const pass = f.logs.slice(mark);
  const withdrawn = pass.findIndex((line) => line.startsWith("[withdrawal] b: INTEGRATION_CONFLICT"));
  const mergedC = pass.findIndex((line) => line.startsWith("[integration] c: MERGED"));
  expect(withdrawn).toBeGreaterThanOrEqual(0);
  expect(mergedC).toBeGreaterThan(withdrawn);
  expect(f.merged(f.landedSha("c"))).toBe(true);
  expect(f.merged(conflictedSha)).toBe(false);
  expect(f.facts("b")).toBe("READY");
  const finding = readReviewLedger(f.store, f.projectId, "b").rounds.at(-1)?.lineage.records.at(-1)?.finding.detail ?? "";
  expect(finding).toContain(`Your accepted work is safe on ${f.trees.get("b")!.branch} at ${conflictedSha}`);
  expect(finding).toContain("Git could not join 1 path(s):\nshared.txt\n");
  const recipe = /^1\. Run: git (.+)$/mu.exec(finding)?.[1]?.split(" ");
  expect(recipe?.at(-1)).toBe("main");
  // Nothing more is withdrawn or merged while the seat has not answered.
  const quiet = f.logs.length;
  await f.runtime.advance();
  expect(f.logs.slice(quiet).filter((line) => line.startsWith("[withdrawal]") || line.startsWith("[integration]"))).toEqual([]);

  // The seat follows the recipe it was handed, in its own tree: merge, settle, COMMIT the merge.
  await f.seat("b", (tree) => {
    expect(() => git(tree, ...recipe!)).toThrow();
    writeFileSync(join(tree, "shared.txt"), "a edits the shared line\nb edits the same line\n");
    git(tree, "add", "--", "shared.txt");
    git(tree, "-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-edit");
    expect(git(tree, "status", "--porcelain")).toBe("");
  });

  await f.runtime.advance();

  const answered = f.landedSha("b");
  expect(answered).toBe(git(f.trees.get("b")!.path, "rev-parse", "HEAD"));
  expect(answered).not.toBe(conflictedSha);
  expect(f.logs.join("\n")).toContain("adopted from the seat's own commit");
  expect(f.logs.join("\n")).toContain("[integration] b: MERGED");
  expect(f.merged(answered)).toBe(true);
  expect(readFileSync(join(f.workspace, "shared.txt"), "utf8")).toBe("a edits the shared line\nb edits the same line\n");
  expect(readFileSync(join(f.workspace, "c.txt"), "utf8")).toBe("c\n");
  expect(git(f.workspace, "status", "--porcelain", "--untracked-files=no")).toBe("");
}, 600_000);
