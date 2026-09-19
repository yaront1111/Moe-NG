import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { readLandingReceipt, readLatestLandingBaseline } from "../repository/landing-ledger.js";
import { landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { prepareRuntimeMetadataExcludes } from "../repository/runtime-metadata-excludes.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { calibration, envelope, packageItems, policyInput, send, submitPayload } from "../review/review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "../review/verifier-receipt-ledger.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { ensureNodeTree, forgetNodeTrees } from "./node-worktrees.js";
import { createRepositoryDeliveryRuntime, readRepositoryDeliveryFacts } from "./repository-delivery-runtime.js";

/**
 * THE THREE EXITS, END TO END, OVER REAL GIT AND THE PRODUCTION COMPOSITION (UnAI 2026-09-19): a
 * merge conflict, a landing refused over an edited runtime file, and a landing that looked in the
 * wrong checkout. Nothing is stood in but the seats themselves, the verifier's test command and
 * where a node is briefed: the runtime, coordinator, verifier, lander, integrator, withdrawal
 * scanner, admission gates, stores and Git are the ones production runs. It lives beside
 * repository-delivery-runtime.test.ts rather than in it because that file is already past the
 * size this repository splits at.
 */
const cleanup: (() => void)[] = [];
afterEach(() => { forgetNodeTrees(); for (const close of cleanup.splice(0).reverse()) close(); });
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"] }).trim();
const NODES = ["a", "b", "c"] as const;
/** Nodes briefed into the project's own checkout, the way every node was before it had a tree. */
const SHARED = ["m", "n"] as const;

async function fixture() {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "moe-delivery-withdrawal-")));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const workspace = join(directory, "repo"); mkdirSync(workspace);
  git(workspace, "init", "--quiet", "-b", "main");
  git(workspace, "config", "user.email", "integration@example.test");
  git(workspace, "config", "user.name", "Integration Fixture");
  git(workspace, "config", "core.autocrlf", "false");
  writeFileSync(join(workspace, "shared.txt"), "base\n");
  // A TRACKED runtime file, as UnAI's launcher was: the one class of dirt that refuses a landing.
  mkdirSync(join(workspace, ".moe-next")); writeFileSync(join(workspace, ".moe-next", "start.ps1"), "# launcher\n");
  git(workspace, "add", "--", "shared.txt", ".moe-next/start.ps1");
  git(workspace, "commit", "--quiet", "-m", "initial");
  // The exclusions every hosted project carries (`/.moe-next/` in info/exclude), by the production
  // writer the host runs before each start, so before any tree exists. Without them the verifier
  // reads the node trees inside the project's checkout as submodules and refuses to bind it.
  expect(await prepareRuntimeMetadataExcludes({ configPath: join(workspace, "moe.config.json"), projectRoot: workspace,
    storePath: join(workspace, "store.sqlite") })).toEqual({ ok: true });
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
  // Where each node is briefed: its own tree, or the project's checkout. An arm moves one to stand
  // in for the mission resolver (wrapper-review-missions.test.ts holds that resolver's own arms).
  const placed = new Map<string, string>([...[...trees].map(([nodeRef, tree]) => [nodeRef, tree.path] as const),
    ...SHARED.map((nodeRef) => [nodeRef as string, workspace] as const)]);
  const runtime = createRepositoryDeliveryRuntime({ compiledWorkspace: workspace, landingOn: true, nodes: () => [...placed.keys()].map((nodeRef) => ({ nodeRef })),
    log: (line) => logs.push(line), storePath,
    fence: { admit: () => ({ ok: true }), recordLiveChild: () => [], retireLiveChild: () => [] },
    verifier: { deps: provider.provide(), mintId: randomUUID, operatorCredential: credential, projectId, store,
      nodeMission: (nodeRef) => placed.has(nodeRef) ? { instructions: "implement", test: "test-fixture", title: `Node ${nodeRef}`, workspace: placed.get(nodeRef)! } : null,
      verificationAuthority: () => ({ calibration: calibration(), packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
        policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) }),
      runTest: async () => ({ byteCount: 2, exitCode: 0, output: "ok", sha256: createHash("sha256").update("ok").digest("hex") }),
    },
  });
  cleanup.push(() => { void runtime.close(); });
  const start = (nodeRef: string) => {
    const request: SpawnRequest = { credential: "seat", expiresAt: "2026-09-20T00:00:00.000Z", kind: "node.deliver",
      mission: "implement", sessionId: randomUUID(), workItemId: `node.deliver@${nodeRef}`, workspace: placed.get(nodeRef)! };
    return runtime.start(async () => ({ ok: true, pid: process.pid, exit: Promise.resolve() }))(request);
  };
  /** One seat: staffed where the node is briefed, does `work` there, submits a clean review, exits. */
  const seat = async (nodeRef: string, work: (tree: string) => void): Promise<void> => {
    const started = await start(nodeRef);
    if (!started.ok) throw new Error(`${nodeRef}: ${started.code}\n${logs.join("\n")}`);
    work(placed.get(nodeRef)!);
    const review = readReviewLedger(store, projectId, nodeRef);
    expect(send(store, { ...envelope("review.submit", review.version, submitPayload(review.lineage.highestRound + 1, [], { subjectRef: nodeRef }), randomUUID()), projectId }).ok).toBe(true);
    await started.exit;
  };
  const landedCommit = (nodeRef: string) => {
    const accepted = readReviewLedger(store, projectId, nodeRef).accepted;
    if (accepted === undefined) throw new Error(`${nodeRef} is not accepted\n${logs.join("\n")}`);
    const landed = readLandingReceipt(store, projectId, landingReceiptId(projectId, nodeRef, accepted.verifierReceiptId));
    if (!landed.ok || landed.receipt.commit === null) throw new Error(`${nodeRef} did not land\n${logs.join("\n")}`);
    return landed.receipt.commit;
  };
  const merged = (sha: string): boolean => {
    try { git(workspace, "merge-base", "--is-ancestor", sha, "HEAD"); return true; } catch { return false; }
  };
  return { facts: (nodeRef: string) => readRepositoryDeliveryFacts(store, projectId, nodeRef), landedCommit,
    landedSha: (nodeRef: string): string => landedCommit(nodeRef).sha, logs, merged, placed, projectId, runtime, seat, start, store, trees, workspace };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** What one node was told, in order: its own `[lander]`, `[withdrawal]` and `[integration]` lines. */
const linesOf = (f: Fixture, nodeRef: string): readonly string[] => f.logs.filter((line) => /^\[[a-z]+\] /u.test(line) && line.split(" ")[1] === `${nodeRef}:`);

it("returns a conflicted node to a seat, merges the branch that waited behind it in the same pass, and lands the seat's merge", async (context) => {
  const f = await fixture();
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

// UnAI 2026-09-19: a tracked .moe-next/start.ps1 was edited while a seat worked in the project's
// checkout. The landing was refused for good, the accepted files stayed uncommitted there, and
// that dirt kept the integrator on SKIPPED for every other node.
it("returns a node whose landing was refused over an edited runtime file to a seat, and lands exactly its files", async (context) => {
  const f = await fixture();
  context.onTestFailed(() => { console.error(f.logs.join("\n")); });
  const launcher = join(f.workspace, ".moe-next", "start.ps1");
  await f.seat("m", (root) => {
    writeFileSync(join(root, "m.txt"), "m\n"); writeFileSync(join(root, "shared.txt"), "m edits the shared line\n");
    writeFileSync(launcher, "# edited under the seat\n");
  });

  await f.runtime.advance();

  expect(linesOf(f, "m").at(-1)).toContain("[lander] m: REFUSED (TRACKED_RUNTIME_METADATA_DIRTY");
  expect(f.facts("m")).toBe("REFUSED");

  await f.runtime.advance();

  expect(linesOf(f, "m").at(-1)).toBe(`[withdrawal] m: LANDING_REFUSED (TRACKED_RUNTIME_METADATA_DIRTY in ${f.workspace}, before any landing intent; the acceptance was withdrawn and the node returns to a seat)`);
  expect(f.facts("m")).toBe("READY");
  // Nothing was stashed, reset or committed on the way: the accepted work is exactly where it was.
  expect(git(f.workspace, "status", "--porcelain", "--untracked-files=no").split("\n").map((line) => line.trim())).toEqual(["M .moe-next/start.ps1", "M shared.txt"]);

  // GATE B STANDS for everybody else: another node on the very same dirt is still refused. Its
  // admission checkpoints the runtime file (Gate A, as before) and then refuses the product dirt.
  expect(await f.start("n")).toMatchObject({ ok: false, code: "REPOSITORY_DELIVERY_BASELINE_UNAVAILABLE" });
  expect(linesOf(f, "n")).toEqual([expect.stringContaining("[lander] n: RUNTIME_METADATA_CHECKPOINTED"),
    expect.stringContaining("[lander] n: BASELINE_WORKSPACE_DIRTY (2 changed paths)")]);

  // The operator edits the launcher again, so the withdrawn node meets both gates itself.
  writeFileSync(launcher, "# edited again\n");
  const mark = linesOf(f, "m").length;
  await f.seat("m", () => undefined);

  expect(linesOf(f, "m").slice(mark, mark + 2)).toEqual([expect.stringContaining("[lander] m: RUNTIME_METADATA_CHECKPOINTED"),
    "[lander] m: BASELINE_RECORDED (2 dirty path(s) before the seat, all this node's own undelivered work and none recorded)"]);
  expect(readLatestLandingBaseline(f.store, f.projectId, "m")?.entries).toEqual([]);

  await f.runtime.advance();

  const landed = f.landedCommit("m");
  expect({ branch: landed.branch, files: [...landed.files].sort() }).toEqual({ branch: "main", files: ["m.txt", "shared.txt"] });
  expect(git(f.workspace, "show", "--name-only", "--format=", landed.sha).split("\n").sort()).toEqual(["m.txt", "shared.txt"]);
  expect(f.logs.join("\n")).not.toContain("VERIFIED_WORKSPACE_PATHS_MISMATCH");
  expect(f.facts("m")).toBe("LANDED");
  expect(git(f.workspace, "status", "--porcelain")).toBe("");
}, 600_000);

// UnAI 2026-09-19: a restart without MOE_NODE_TREES briefed a node into the shared checkout while
// its 34 changed files sat in its own tree. The landing found nothing there and was credited as a
// node that owed no bytes.
it("returns a node credited with nothing to a seat in the tree that holds its work, and lands it from there", async (context) => {
  const f = await fixture();
  context.onTestFailed(() => { console.error(f.logs.join("\n")); });
  const tree = f.trees.get("c")!;
  f.placed.set("c", f.workspace);
  await f.seat("c", () => { writeFileSync(join(tree.path, "c.txt"), "c\n"); writeFileSync(join(tree.path, "shared.txt"), "c edits the shared line\n"); });

  await f.runtime.advance();

  expect(linesOf(f, "c").at(-1)).toContain("[lander] c: REFUSED (NOTHING_TO_COMMIT");

  await f.runtime.advance();

  expect(linesOf(f, "c").at(-1)).toBe(`[withdrawal] c: DELIVERED_NOTHING (the landing found nothing in ${f.workspace} while ${tree.path} holds 2 uncommitted path(s); the acceptance was withdrawn and the node returns to a seat)`);
  expect(f.facts("c")).toBe("READY");

  // Where the mission resolver briefs a node whose tree is on disk, whatever the knob says.
  f.placed.set("c", tree.path);
  await f.seat("c", () => undefined);
  expect(readLatestLandingBaseline(f.store, f.projectId, "c")).toMatchObject({ entries: [], workspace: tree.path });

  await f.runtime.advance();

  const landed = f.landedCommit("c");
  expect({ branch: landed.branch, files: [...landed.files].sort() }).toEqual({ branch: tree.branch, files: ["c.txt", "shared.txt"] });
  expect(linesOf(f, "c").at(-1)).toContain("[integration] c: MERGED");
  expect(readFileSync(join(f.workspace, "c.txt"), "utf8")).toBe("c\n");
}, 600_000);
