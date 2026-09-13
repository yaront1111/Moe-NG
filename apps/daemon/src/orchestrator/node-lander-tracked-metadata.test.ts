import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeStores } from "../review/review-test-fixtures.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import { createGitLandingPort } from "../repository/git-landing-port.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { landedWithNoEffect, landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { readRepositoryLandingEvidence } from "../repository/repository-landing-intent.js";
import { recoveryEvidenceFixture } from "../repository/repository-recovery-test-fixtures.js";
import { createNodeLander } from "./node-lander.js";

const roots: string[] = [];
afterEach(() => {
  closeStores();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
}).trim();

describe("legacy baselines with tracked runtime metadata", () => {
  it("refuses a real verified candidate without journaling or committing metadata omitted from its old baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe-lander-tracked-metadata-")); roots.push(root);
    git(root, "init", "--quiet", "--initial-branch=trunk");
    mkdirSync(join(root, ".moe-next"));
    writeFileSync(join(root, ".moe-next", "start.ps1"), "# original launcher\n");
    writeFileSync(join(root, "owned.txt"), "before\n");
    git(root, "add", "--", ".moe-next/start.ps1", "owned.txt");
    git(root, "-c", "user.name=Operator", "-c", "user.email=operator@example.test", "commit", "--quiet", "-m", "initial");
    writeFileSync(join(root, ".moe-next", "start.ps1"), "# foreign edit hidden by the old observer\n");
    writeFileSync(join(root, "owned.txt"), "verified node output\n");
    const workspace = createVerifiedWorkspacePort();
    const captured = await workspace.capture(root);
    expect(captured.ok).toBe(true); if (!captured.ok) throw new Error(captured.code);
    expect(git(root, "show", `${captured.binding.treeSha}:.moe-next/start.ps1`)).toContain("foreign edit");
    // Production ledger writes reproduce the historical empty baseline and accepted receipt;
    // the actual captured candidate contains metadata that the old observer silently omitted.
    const f = recoveryEvidenceFixture({ binding: captured.binding });
    expect(f.baseline.baseline.entries).toEqual([]);
    const beforeIndex = readFileSync(join(root, ".git", "index"));
    let commits = 0;
    const lander = createNodeLander({
      store: f.store, projectId: f.handle.owner.projectId, reservationHandle: f.handle,
      baselineId: () => f.baseline.baselineId, git: createGitLandingPort(),
      nodes: () => [{ nodeRef: f.handle.owner.nodeRef }],
      nodeMission: () => ({ title: "Node", instructions: "build", test: "approved-check", workspace: captured.binding.root }),
      verifiedWorkspace: {
        capture: workspace.capture,
        commit: async (...args) => { commits += 1; return workspace.commit(...args); },
      },
    });

    const reports = await lander.landOnce();

    expect(reports).toMatchObject([{ outcome: "REFUSED", detail: expect.stringContaining("TRACKED_RUNTIME_METADATA_DIRTY") }]);
    expect(commits).toBe(0);
    expect(readRepositoryLandingEvidence(f.store, f.handle))
      .toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_MISSING" });
    const landed = readLandingReceipt(f.store, f.handle.owner.projectId,
      landingReceiptId(f.handle.owner.projectId, f.handle.owner.nodeRef, f.verified.receipt.receiptId));
    expect(landed).toMatchObject({ ok: true, receipt: { commit: null, refusal: { code: "TRACKED_RUNTIME_METADATA_DIRTY" } } });
    const reviews = readReviewLedgers(f.store, f.handle.owner.projectId, new Set([f.handle.owner.nodeRef]));
    if (!landed.ok) throw new Error(landed.code);
    expect(landedWithNoEffect(landed.receipt, reviews.landingIntents)).toBe(false);
    expect(git(root, "rev-parse", "HEAD")).toBe(captured.binding.headSha);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(beforeIndex);
    expect(readFileSync(join(root, ".moe-next", "start.ps1"), "utf8")).toContain("foreign edit");
    expect(await lander.landOnce()).toEqual([]);
    expect(commits).toBe(0);
  }, 120_000);
});
