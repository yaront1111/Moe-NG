import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { calibration, envelope, packageItems, policyInput, seedVerifierReceipt, send, submitPayload } from "../review/review-test-fixtures.js";
import { landingAggregateId } from "../repository/landing-receipt-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { NODE_VERIFIER_PRINCIPAL_ID, readVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { AgentProcessFailureError } from "./agent-spawn-contract.js";
import type { AgentSpawnStart } from "./agent-spawn-contract.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { createRepositoryDeliveryRuntime, readRepositoryDeliveryFacts } from "./repository-delivery-runtime.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "moe-delivery-runtime-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const workspace = join(directory, "repo"); mkdirSync(workspace);
  git(workspace, "init", "--quiet", "-b", "main");
  writeFileSync(join(workspace, "keep.txt"), "before\n"); writeFileSync(join(workspace, "remove.txt"), "old\n");
  git(workspace, "add", "--", "keep.txt", "remove.txt");
  git(workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "initial");
  const projectId = "runtime-test"; const credential = "operator-runtime-test";
  const storePath = join(directory, "store.db");
  const provider = createStoreDependencies({ credential, principalId: "operator-local", projectId, storePath });
  cleanup.push(() => provider.close());
  const store = SqliteEventStore.openForProject(storePath, projectId); cleanup.push(() => store.close());
  installTestRecoveryBinding(store);
  let retired = false; let tests = 0; let landingOn = true; let verified = "after\n";
  const logs: string[] = [];
  const runtime = createRepositoryDeliveryRuntime({ compiledWorkspace: workspace, get landingOn() { return landingOn; }, nodes: () => [{ nodeRef: "a" }, { nodeRef: "b" }],
    log: (line) => logs.push(line), storePath,
    fence: { admit: () => retired ? { ok: true } : { ok: false, code: "AGENT_STAFFING_CHILD_LIVE", layer: "WRAPPER_STAFFING" },
      recordLiveChild: () => [], retireLiveChild: () => [] },
    verifier: { deps: provider.provide(), mintId: randomUUID, nodeMission: () => ({ instructions: "implement", test: "test-fixture", title: "Node delivery", workspace }),
      operatorCredential: credential, projectId, store,
      verificationAuthority: () => ({ calibration: calibration(), packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
        policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) }),
      runTest: async () => {
        tests += 1;
        expect(readFileSync(join(workspace, "keep.txt"), "utf8")).toBe(verified);
        return { byteCount: 2, exitCode: 0, output: "ok", sha256: createHash("sha256").update("ok").digest("hex") };
      },
    },
  });
  const submit = (nodeRef: string) => {
    const review = readReviewLedger(store, projectId, nodeRef);
    expect(send(store, { ...envelope("review.submit", review.version, submitPayload(review.lineage.highestRound + 1, [], { subjectRef: nodeRef }), randomUUID()), projectId }).ok).toBe(true);
  };
  const request = (nodeRef: string): SpawnRequest => ({ credential: "seat", expiresAt: "2026-09-06T00:00:00.000Z", kind: "node.deliver",
    mission: "implement", sessionId: randomUUID(), workItemId: `node.deliver@${nodeRef}`, workspace });
  return { runtime, workspace, store, projectId, logs, submit, request, tests: () => tests,
    storeId: realpathSync.native(storePath),
    disableLanding: () => { landingOn = false; }, retire: () => { retired = true; },
    /** The content the verifier's own test command asserts; a node that changes nothing leaves it at the baseline. */
    expectVerified: (content: string) => { verified = content; } };
}

describe("production repository delivery composition", () => {
  it("holds existing accepted work without a landing effect when landing is disabled", async () => {
    const f = fixture();
    const started = await f.runtime.start(async () => ({ ok: true, pid: process.pid, exit: Promise.resolve() }))(f.request("a"));
    if (!started.ok) throw new Error(started.code);
    await started.exit; f.retire();
    writeFileSync(join(f.workspace, "keep.txt"), "after\n");
    const seeded = seedVerifierReceipt(f.store, "a", f.projectId);
    expect(send(f.store, { ...envelope("integration.accept_output", seeded.currentVersion,
      { receiptId: seeded.receiptId, subjectRef: "a" }), projectId: f.projectId }).ok).toBe(true);
    const version = f.store.getAggregateVersion(landingAggregateId("a"));
    f.disableLanding(); await f.runtime.advance();
    expect(f.logs.join("\n")).toContain("REPOSITORY_DELIVERY_LANDING_REQUIRED");
    expect(f.store.getAggregateVersion(landingAggregateId("a"))).toBe(version);
    expect(readRepositoryDeliveryFacts(f.store, f.projectId, "a")).toBe("ACCEPTED");
    expect(createRepositoryExecutionPort().inspect(f.workspace)).toMatchObject({ reservation: { phase: "AWAITING_LANDING" } });
  }, 120_000);
  it("serializes two nodes in one real checkout and lands the exact receipt tree", async (context) => {
    const f = fixture(); let finish!: () => void;
    context.onTestFailed(() => { console.error(f.logs.join("\n")); });
    const exit = new Promise<void>((resolve) => { finish = resolve; });
    const spawn: AgentSpawnStart = async () => ({ ok: true, pid: process.pid, exit });
    const started = await f.runtime.start(spawn)(f.request("a"));
    expect(started.ok).toBe(true);
    writeFileSync(join(f.workspace, "keep.txt"), "after\n"); rmSync(join(f.workspace, "remove.txt")); f.submit("a");
    await f.runtime.advance(); expect(f.tests()).toBe(0);
    expect(await f.runtime.start(spawn)(f.request("b"))).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
    finish(); if (started.ok) await started.exit; f.retire(); await f.runtime.advance();
    expect(f.logs.join("\n")).toContain("COMMITTED");
    expect(readRepositoryDeliveryFacts(f.store, f.projectId, "a")).toBe("LANDED");
    expect(git(f.workspace, "status", "--porcelain")).toBe("");
    const accepted = readReviewLedger(f.store, f.projectId, "a").accepted!;
    const receipt = readVerifierReceipt(f.store, f.projectId, accepted.verifierReceiptId);
    expect(receipt.ok && receipt.receipt.execution.workspaceBinding?.treeSha).toBe(git(f.workspace, "rev-parse", "HEAD^{tree}"));
    const next = await f.runtime.start(async () => ({ ok: true, pid: process.pid, exit: Promise.resolve() }))(f.request("b"));
    expect(next.ok).toBe(true); if (next.ok) await next.exit;
    writeFileSync(join(f.workspace, "b.txt"), "second node\n"); f.submit("b"); await f.runtime.advance();
    expect(readRepositoryDeliveryFacts(f.store, f.projectId, "b")).toBe("LANDED");
    expect(git(f.workspace, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("b.txt");
    expect(createRepositoryExecutionPort().inspect(f.workspace)).toEqual({ ok: true, reservation: null });
  }, 600_000);

  it("lands tracked edits and deletions left by a failed attempt using its original baseline", async (context) => {
    const f = fixture(); let fail!: (error: Error) => void;
    context.onTestFailed(() => { console.error(f.logs.join("\n")); });
    const exit = new Promise<void>((_, reject) => { fail = reject; });
    const first = await f.runtime.start(async () => ({ ok: true, pid: process.pid, exit }))(f.request("a"));
    if (!first.ok) throw new Error(first.code);
    writeFileSync(join(f.workspace, "keep.txt"), "after\n"); rmSync(join(f.workspace, "remove.txt"));
    fail(new AgentProcessFailureError("EXIT_NONZERO", 1, null)); await expect(first.exit).rejects.toThrow();
    f.retire(); await f.runtime.advance();
    const retry = await f.runtime.start(async () => ({ ok: true, pid: process.pid, exit: Promise.resolve() }))(f.request("a"));
    if (!retry.ok) throw new Error(retry.code);
    await retry.exit; f.submit("a"); await f.runtime.advance();
    expect(f.logs.filter((line) => line.includes("BASELINE_RECORDED"))).toHaveLength(1);
    expect(readRepositoryDeliveryFacts(f.store, f.projectId, "a")).toBe("LANDED");
    expect(git(f.workspace, "diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD").split(/\r?\n/u)).toEqual(["M\tkeep.txt", "D\tremove.txt"]);
  }, 600_000);

  // DoD 5: the two-process reproduction. Real temp checkout, real sqlite reservation store.
  // A seat that verified clean refuses NOTHING_TO_COMMIT, and the NEXT independent node must
  // still be able to claim the root. Pre-fix this fails at that second claim with
  // REPOSITORY_EXECUTION_BUSY because the reservation is wedged in the terminal BLOCKED phase.
  it("frees the checkout for an independent node after a landing that commits nothing", async (context) => {
    const f = fixture(); let finish!: () => void;
    context.onTestFailed(() => { console.error(f.logs.join("\n")); });
    const exit = new Promise<void>((resolve) => { finish = resolve; });
    const started = await f.runtime.start(async () => ({ ok: true, pid: process.pid, exit }))(f.request("a"));
    if (!started.ok) throw new Error(started.code);
    // No workspace edit anywhere in this arm: the seat leaves git status clean, which is the trigger.
    f.expectVerified("before\n");
    const head = git(f.workspace, "rev-parse", "HEAD");
    f.submit("a");
    finish(); await started.exit; f.retire();
    await f.runtime.advance();
    expect(f.tests()).toBe(1);
    expect(f.logs.join("\n")).toContain("NOTHING_TO_COMMIT");
    // Nothing was written: the refusal is decided before any Git effect.
    expect(git(f.workspace, "rev-parse", "HEAD")).toBe(head);
    expect(git(f.workspace, "status", "--porcelain")).toBe("");
    const next = await f.runtime.start(async () => ({ ok: true, pid: process.pid, exit: Promise.resolve() }))(f.request("b"));
    // Names the refusal rather than only its falsity: pre-fix this is REPOSITORY_EXECUTION_BUSY.
    expect({ ok: next.ok, code: next.ok ? null : next.code }).toEqual({ ok: true, code: null });
    if (next.ok) await next.exit;
    // The reservation that refused is gone rather than parked: node-b now owns the root.
    expect(createRepositoryExecutionPort().inspect(f.workspace)).toMatchObject({ ok: true, reservation: { nodeRef: "b" } });
  }, 600_000);
  // DoD 2, first bucket: a refusal decided before any journaled intent is its OWN fact.
  it("derives REFUSED_NO_EFFECT, not REFUSED, when the landing journaled no intent", async (context) => {
    const f = fixture();
    context.onTestFailed(() => { console.error(f.logs.join("\n")); });
    const started = await f.runtime.start(async () => ({ ok: true, pid: process.pid, exit: Promise.resolve() }))(f.request("a"));
    if (!started.ok) throw new Error(started.code);
    await started.exit; f.retire();
    // Cloned from the landing-disabled arm above, MINUS its file write: nothing differs from the baseline.
    const seeded = seedVerifierReceipt(f.store, "a", f.projectId);
    expect(send(f.store, { ...envelope("integration.accept_output", seeded.currentVersion,
      { receiptId: seeded.receiptId, subjectRef: "a" }), projectId: f.projectId }).ok).toBe(true);
    // Captured while the reservation still exists; the intent key is (owner, baseline, session), all fixed by now.
    const held = createRepositoryExecutionPort().readOwned(f.workspace, f.storeId, f.projectId);
    if (!held.ok || held.handle === null) throw new Error("expected a live reservation to read");
    await f.runtime.advance();
    expect(f.logs.join("\n")).toContain("NOTHING_TO_COMMIT");
    expect(readRepositoryDeliveryFacts(f.store, f.projectId, "a", held.handle)).toBe("REFUSED_NO_EFFECT");
    // Without a handle the intent key cannot be computed at all, so the answer fails closed to REFUSED.
    expect(readRepositoryDeliveryFacts(f.store, f.projectId, "a")).toBe("REFUSED");
    expect(createRepositoryExecutionPort().inspect(f.workspace)).toEqual({ ok: true, reservation: null });
  }, 120_000);

  // DoD 2, second bucket, asserted separately: the SAME refusal code with an intent already journaled
  // stays REFUSED and still blocks. This is what makes the fix a narrowing rather than a blanket un-block —
  // the discriminator is the journal, not the refusal code.
  it("keeps a refusal that already journaled an intent in the REFUSED bucket and still blocks", async (context) => {
    const f = fixture(); let finish!: () => void;
    context.onTestFailed(() => { console.error(f.logs.join("\n")); });
    const exit = new Promise<void>((resolve) => { finish = resolve; });
    const started = await f.runtime.start(async () => ({ ok: true, pid: process.pid, exit }))(f.request("a"));
    if (!started.ok) throw new Error(started.code);
    writeFileSync(join(f.workspace, "keep.txt"), "after\n");
    f.submit("a"); finish(); await started.exit; f.retire();
    // A real index lock fails the commit AFTER the intent is journaled, and the attempt is retryable.
    const lock = join(f.workspace, ".git", "index.lock");
    writeFileSync(lock, "");
    await f.runtime.advance();
    expect(f.logs.join("\n")).toContain("GIT_INDEX_LOCKED");
    rmSync(lock);
    // The seat's change is reverted before the retry, so the second attempt has nothing to commit —
    // same NOTHING_TO_COMMIT code as the arm above, but this time an intent is already durable.
    writeFileSync(join(f.workspace, "keep.txt"), "before\n");
    await f.runtime.advance();
    expect(f.logs.join("\n")).toContain("NOTHING_TO_COMMIT");
    const held = createRepositoryExecutionPort().readOwned(f.workspace, f.storeId, f.projectId);
    if (!held.ok || held.handle === null) throw new Error("expected the wedged reservation to still exist");
    expect(readRepositoryDeliveryFacts(f.store, f.projectId, "a", held.handle)).toBe("REFUSED");
    expect(createRepositoryExecutionPort().inspect(f.workspace)).toMatchObject({ ok: true, reservation: { phase: "BLOCKED" } });
    const next = await f.runtime.start(async () => ({ ok: true, pid: process.pid, exit: Promise.resolve() }))(f.request("b"));
    expect({ ok: next.ok, code: next.ok ? null : next.code }).toEqual({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
  }, 600_000);
});
