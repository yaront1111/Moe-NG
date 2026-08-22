import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { killTree, spawnNode } from "./daemon-children.js";
import { LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot, seedEnv } from "./daemon-scratch.js";

/**
 * The v2 rebuild's PRD-to-approval journey, driven against a REAL daemon that
 * HOSTS THE BUILT BUNDLE and mints a pairing token — the shipped one-URL path,
 * not the vite proxy the v1 `daemon-board.spec` uses.
 *
 * WHAT THIS PROVES that no unit test can: the runtime credential handshake
 * (GET /bootstrap -> POST /session/pair from the URL fragment) attaches the page
 * with NO baked secret; the plan-review screen reads the daemon's own sealed plan
 * over POST /planning/run/read; the work board renders the real affordance
 * surface; and the control room NEVER authors an approval decision — the Approve
 * control is present but disabled. The whole lane (build, daemon, seed) runs
 * inside the test so the config's per-test budget bounds it, and every child is
 * killed and the scratch store removed in `finally`, mirroring `daemon-ports.ts`.
 */

const DAEMON_READY_MS = 60_000;
const SEED_MS = 90_000;
const BUILD_MS = 180_000;
const ORIGIN_LINE = /listening on (\S+)/u;
const TOKEN_LINE = /pairing token (\S+)/u;

/** Resolves the child's exit code, or null once `ms` is spent. */
const awaitExit = (child: ChildProcess, ms: number): Promise<number | null> =>
  new Promise((done) => {
    const timer = setTimeout(() => { done(null); }, ms);
    child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });

test("v2: pairs by handshake, reads the sealed plan, and never fabricates approval", async ({ page }) => {
  const root = repoRoot();
  expect(root, "repo root (package.json + pnpm-workspace.yaml)").not.toBeNull();
  if (root === null) return;

  const dist = join(root, "apps", "control-room", "dist");
  const scratch = createLaneScratch();
  const children: ChildProcess[] = [];
  try {
    // 1. Build the bundle the daemon hosts. VITE_MOE_LIVE_* are cleared so the
    //    bundle carries no baked secret the static host would refuse to serve.
    const build = spawnNode(
      [join(root, "apps", "control-room", "node_modules", "vite", "bin", "vite.js"), "build"],
      join(root, "apps", "control-room"),
      { ...process.env, VITE_MOE_LIVE_CREDENTIAL: undefined, VITE_MOE_LIVE_CSRF: undefined },
    );
    children.push(build.child);
    expect(await awaitExit(build.child, BUILD_MS), `vite build:\n${build.transcript().slice(-800)}`).toBe(0);
    expect(existsSync(join(dist, "index.html")), "the build must emit index.html").toBe(true);

    // 2. Daemon on an ephemeral port, hosting the bundle and minting a pairing token.
    const daemon = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "daemon-main.ts"),
      `--dependencies=${join(root, "apps", "daemon", "src", "daemon-store-dependencies.ts")}`,
      "--port=0",
      `--csrf-token=${LANE_CSRF_TOKEN}`,
      `--asset-root=${dist}`,
    ], root, daemonEnv(scratch, "SPEED"));
    children.push(daemon.child);
    const origin = await daemon.waitFor(ORIGIN_LINE, DAEMON_READY_MS);
    const pairingToken = await daemon.waitFor(TOKEN_LINE, DAEMON_READY_MS);
    expect(origin, `daemon origin:\n${daemon.transcript().slice(-800)}`)
      .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(pairingToken, "the hosting daemon must mint a pairing token").toBeTruthy();

    // 3. Seed the J1 chain server-side so a real goal and a sealed plan exist.
    const seed = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "orchestrator", "demo-seed-main.ts"),
    ], root, seedEnv(scratch, origin as string, "SPEED"));
    children.push(seed.child);
    expect(await awaitExit(seed.child, SEED_MS), `demo seed:\n${seed.transcript().slice(-1000)}`).toBe(0);

    // 4. The browser pairs through the runtime handshake and reads the daemon's answer.
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    // domcontentloaded, not networkidle: the work board polls the surface every 2s,
    // so the network is never idle; the web-first assertions below wait for attach.
    await page.goto(`${origin as string}/#pair=${pairingToken as string}`, { waitUntil: "domcontentloaded" });

    // Attached: the goals count leaves CONNECTING and names the one real goal.
    await expect(page.getByTestId("cr.goals.count")).toHaveText(/\d+ GOAL/u, { timeout: 20_000 });
    await expect(page.getByText("goal-live-1").first()).toBeVisible();

    // Open the goal -> plan-review over POST /planning/run/read.
    await page.getByRole("button", { name: /open the board/iu }).first().click();
    await expect(page.getByTestId("cr.approve.screen")).toBeVisible();
    await expect(page.getByText(/Ready for your approval/iu)).toBeVisible();

    // The control room NEVER authors the approval decision: present but disabled.
    await expect(page.getByTestId("cr.approve.button")).toBeDisabled();
    await expect(page.getByTestId("cr.approve.note")).toContainText(/no fabricated decision/iu);

    // The read-only work board renders the daemon's real surface.
    await expect(page.getByTestId("cr.board.root")).toBeVisible();

    // Self-hosted fonts + same-origin routes: no CSP violation reaches the console.
    expect(
      consoleErrors.filter((entry) => /Content Security Policy/iu.test(entry)),
      consoleErrors.join(" | "),
    ).toHaveLength(0);
  } finally {
    for (const child of [...children].reverse()) await killTree(child);
    try {
      rmSync(scratch.root, { force: true, recursive: true });
    } catch {
      // A scratch dir that outlives its run is a few hundred KB in TEMP, never a fail.
    }
  }
});
