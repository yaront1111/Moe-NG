import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { killTree, spawnNode, survivingPids } from "./daemon-children.js";
import {
  LANE_CREDENTIAL, LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot, seedEnv,
} from "./daemon-ports.js";
import { readGoalCatalogOverHttp } from "./prd-boundary-readers.js";

/**
 * REAL-DAEMON journeys for the two screens this row's dependencies shipped:
 * Resources (task-2ee775b3) and the contract dossier (task-1c9587ed). Pairing,
 * spawn and seed follow gate1-v1-approval.spec.ts; this file does not re-approve
 * Gate 1, it only proves those screens are reachable on a live daemon.
 */

const DAEMON_READY_MS = 60_000;
const SEED_MS = 90_000;
const BUILD_MS = 180_000;
const ORIGIN_LINE = /listening on (http:\/\/127\.0\.0\.1:\d+)/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
const PRD_TEXT = "# Sign-in\n\nUsers sign in with an email and a password.\n";
const PRD_SHA256 = createHash("sha256").update(PRD_TEXT, "utf8").digest("hex");

const awaitExit = (child: ChildProcess, ms: number): Promise<number | null> =>
  new Promise((done) => {
    const timer = setTimeout(() => { done(null); }, ms);
    child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });

test("Resources and the contract dossier render from a real daemon", async ({ page }) => {
  test.setTimeout(300_000);
  const root = repoRoot();
  expect(root, "repo root (package.json + pnpm-workspace.yaml)").not.toBeNull();
  if (root === null) return;

  const dist = join(root, "apps", "control-room", "dist");
  const scratch = createLaneScratch();
  const children: ChildProcess[] = [];
  const pids: number[] = [];
  try {
    const build = spawnNode(
      [join(root, "apps", "control-room", "node_modules", "vite", "bin", "vite.js"), "build"],
      join(root, "apps", "control-room"),
      { ...process.env, VITE_MOE_LIVE_CREDENTIAL: undefined, VITE_MOE_LIVE_CSRF: undefined },
    );
    children.push(build.child);
    expect(await awaitExit(build.child, BUILD_MS), `vite build:\n${build.transcript().slice(-800)}`)
      .toBe(0);
    expect(existsSync(join(dist, "index.html")), "the build must emit index.html").toBe(true);

    const daemon = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "daemon-main.ts"),
      `--dependencies=${join(root, "apps", "daemon", "src", "daemon-store-dependencies.ts")}`,
      "--port=0",
      `--csrf-token=${LANE_CSRF_TOKEN}`,
      `--asset-root=${dist}`,
      "--operator-stdin",
    ], root, daemonEnv(scratch, "SPEED"));
    children.push(daemon.child);
    if (daemon.child.pid !== undefined) pids.push(daemon.child.pid);
    const origin = await daemon.waitFor(ORIGIN_LINE, DAEMON_READY_MS);
    expect(origin, `daemon origin:\n${daemon.transcript().slice(-800)}`)
      .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    if (typeof origin !== "string") return;

    const seed = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "orchestrator", "demo-seed-main.ts"),
    ], root, seedEnv(scratch, origin, "SPEED"));
    children.push(seed.child);
    expect(await awaitExit(seed.child, SEED_MS), `demo seed:\n${seed.transcript().slice(-1000)}`)
      .toBe(0);

    const labelOutput = page.getByLabel("Pairing confirmation label");
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(labelOutput).toBeVisible({ timeout: 20_000 });
    const confirmationLabel = (await labelOutput.textContent())?.trim() ?? "";
    expect(confirmationLabel).toMatch(CONFIRMATION_LABEL);
    expect(daemon.child.stdin, "the explicit operator pipe must exist").not.toBeNull();
    daemon.child.stdin?.write(`${confirmationLabel}\n`);
    await page.getByRole("button", { name: "I entered this label" }).click();
    await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: 60_000 });

    await page.getByTestId("cr.nav.resources").click();
    await expect(page.getByTestId("cr.resources.screen")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("cr.resources.banner")).toBeVisible();
    const measured = page.locator("[data-testid^='cr.resources.value.']");
    await expect(measured.first(), "at least one resource fact must be measured from the daemon")
      .toBeVisible({ timeout: 20_000 });
    const measuredText = (await measured.first().textContent())?.trim() ?? "";
    expect(measuredText.length, "a measured fact must carry the daemon's value").toBeGreaterThan(0);

    await page.getByTestId("cr.nav.goals").click();
    await expect(page.getByTestId("cr.goals.home")).toBeVisible();
    await page.getByTestId("cr.goals.new").click();
    await expect(page.getByTestId("cr.goals.newgoal.form")).toBeVisible();
    await page.getByTestId("cr.goals.newgoal.title").fill("Contract dossier lane goal");
    await page.getByTestId("cr.goals.newgoal.outcome").fill("The contract dossier is reachable.");
    await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
      buffer: Buffer.from(PRD_TEXT, "utf8"), mimeType: "text/markdown", name: "dossier-prd.md",
    });
    await page.getByTestId("cr.goals.newgoal.create").click();

    let goalId: string | null = null;
    await expect.poll(async () => {
      const catalog = await readGoalCatalogOverHttp(origin, root, LANE_CREDENTIAL, LANE_CSRF_TOKEN);
      if (!("goals" in catalog)) return null;
      const entry = catalog.goals.find((row) => row.binding?.contentSha256 === PRD_SHA256);
      goalId = entry?.goalId ?? null;
      return goalId;
    }, { message: "the created goal must appear bound to the PRD sha", timeout: 30_000 })
      .not.toBeNull();
    if (goalId === null) return;

    await page.getByTestId(`cr.goals.card.${goalId}.open`).click();
    await expect(page.getByTestId("cr.contract.card")).toBeVisible({ timeout: 20_000 });
    const none = page.getByTestId("cr.contract.none");
    const body = page.getByTestId("cr.contract.body");
    const refusal = page.getByTestId("cr.contract.refusal");
    await expect(none.or(body).or(refusal)).toBeVisible({ timeout: 20_000 });
    expect(await page.getByTestId("cr.banner.fixture").count()).toBe(0);
  } finally {
    for (const child of [...children].reverse()) await killTree(child);
    try { rmSync(scratch.root, { force: true, recursive: true }); } catch { /* scratch leftover */ }
  }
  expect(await survivingPids(pids), "the lane must leave no orphan daemon").toEqual([]);
});
