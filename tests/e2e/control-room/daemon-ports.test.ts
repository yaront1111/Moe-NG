/**
 * The daemon-backed lane's project root, proven without a daemon or a browser.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT. `activationReceiptInput` resolves the daemon's project
 * root as `MOE_PROJECT_ROOT ?? process.cwd()`, and every lane daemon is spawned with the CHECKOUT
 * as its cwd - so a lane environment without the variable sends every daemon this directory
 * starts to ONE `<checkout>/.moe-next/backups/`, where concurrent activations prune each other's
 * stamps and are refused ACTIVATION_BACKUP_FAILED. The same flake `e2e-harness.test.ts` pins for
 * the foundation roster. Every spec here spawns with `daemonEnv(createLaneScratch())`, so that
 * pair is the seam, and it is graded through the daemon's OWN resolver rather than by key name.
 *
 * `.test.ts`, not `.spec.ts`: the root vitest include carries it into the node lane, and the
 * browser lane matches `*.spec.ts` only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { activationReceiptInput } from "../../../apps/daemon/src/bootstrap/activation-command-entry.js";
import { createLaneScratch, daemonEnv, laneProjectRoot, repoRoot } from "./daemon-ports.js";
import type { LaneApprovalMode, LaneScratch } from "./daemon-ports.js";

const scratches: LaneScratch[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    rmSync(scratch.root, { force: true, maxRetries: 5, recursive: true });
  }
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true }).trim();

const newScratch = (landing = false): LaneScratch => {
  const scratch = createLaneScratch(landing);
  scratches.push(scratch);
  return scratch;
};

/** What the spawned daemon would resolve, with the checkout as its cwd exactly as the specs spawn it. */
const resolvedProjectRoot = (scratch: LaneScratch, approval: LaneApprovalMode, checkout: string): string =>
  activationReceiptInput(scratch.projectId, daemonEnv(scratch, approval), checkout).projectRoot;

describe("daemon-backed lane project root", () => {
  it("hands every lane daemon its own scratch project root, never the checkout", () => {
    const checkout = repoRoot();
    expect(checkout, "repo root (package.json + pnpm-workspace.yaml)").not.toBeNull();
    if (checkout === null) return;
    const pair = [newScratch(), newScratch(true)];
    for (const approval of ["SPEED", "HUMAN"] as const) {
      const roots = pair.map((scratch) => resolvedProjectRoot(scratch, approval, checkout));
      expect(roots.map((root) => resolve(root)), `${approval}: never the checkout`).not.toContain(resolve(checkout));
      expect(roots, `${approval}: the scratch's own root`).toEqual(pair.map((scratch) => scratch.projectRoot));
      expect(new Set(roots).size, `${approval}: one root per lane`).toBe(pair.length);
    }
    for (const scratch of pair) {
      // Inside the scratch the lane already deletes on every exit path, at the derived location
      // `resolveLaneScratch` rebuilds it from.
      expect(relative(scratch.root, scratch.projectRoot).startsWith(".."), "inside the scratch").toBe(false);
      expect(scratch.projectRoot).toBe(laneProjectRoot(scratch.root));
    }
  });

  /**
   * The same root feeds `git rev-parse` for the repository and distribution members, so a root
   * that is not a repository would trade the shared-backups refusal for
   * ACTIVATION_REPOSITORY_UNMEASURED. Read FROM the root, as the daemon reads it.
   */
  it("gives that root a HEAD of its own and leaves the scratch root itself unrepositoried", () => {
    const checkout = repoRoot();
    if (checkout === null) throw new Error("repo root unresolved");
    const scratch = newScratch();
    const root = resolvedProjectRoot(scratch, "SPEED", checkout);
    const head = git(root, "rev-parse", "HEAD");
    expect(head).toMatch(/^[0-9a-f]{40}$/u);
    // Its OWN top level: an empty prefix means the root is where its repository starts.
    expect(git(root, "rev-parse", "--show-prefix")).toBe("");
    expect(head).not.toBe(git(checkout, "rev-parse", "HEAD"));
    expect(head).not.toBe(scratch.workspaceSha);
    // NOTHING THE SPECS READ MOVES: a non-landing node spec points at the scratch root, which
    // `repository-delivery-runtime.ts` must keep finding NOT to be a repository.
    expect(existsSync(join(scratch.root, ".git")), "the scratch root stays a plain directory").toBe(false);
  });
});
