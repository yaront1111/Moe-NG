import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { killTree, spawnNode } from "./daemon-children.js";
import { LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot, seedEnv } from "./daemon-ports.js";

/**
 * The v2 rebuild's PRD-to-approval journey, driven against a REAL daemon that
 * HOSTS THE BUILT BUNDLE and accepts a private foreground approval — the shipped
 * plain-origin path, not the vite proxy the v1 `daemon-board.spec` uses.
 *
 * WHAT THIS PROVES that no unit test can: the runtime credential handshake
 * (GET /bootstrap -> request -> operator approval -> claim) attaches the page
 * with NO baked secret or URL authority; the plan-review screen reads the daemon's own sealed plan
 * over POST /planning/run/read; the work board renders the real affordance
 * surface; and the control room NEVER authors an approval decision — the Approve
 * control is present but disabled. The whole lane (build, daemon, seed) runs
 * inside the test so the config's per-test budget bounds it, and every child is
 * killed and the scratch store removed in `finally`, mirroring `daemon-ports.ts`.
 */

const DAEMON_READY_MS = 60_000;
const SEED_MS = 90_000;
const BUILD_MS = 180_000;
const ORIGIN_LINE = /listening on (http:\/\/127\.0\.0\.1:\d+)/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;

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

  // Structural retirement canary, fail-closed BEFORE any child starts: the durable
  // harness for this lane is `daemon-ports.ts`, and the scratch-named module it
  // superseded must not come back under any name. Asserted on the path's existence
  // rather than on an import, so a re-added module is caught even if nothing here
  // imports it yet. Scoped to this one path — unrelated provider/native probe
  // capabilities that merely contain the word are none of this lane's business.
  expect(
    existsSync(join(root, "tests", "e2e", "control-room", "daemon-scratch.ts")),
    "retired module: tests/e2e/control-room/daemon-scratch.ts must not exist (its helpers live in daemon-ports.ts)",
  ).toBe(false);

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

    // 2. Daemon on an ephemeral port, hosting the bundle with a private stdin
    //    operator channel. The marker is non-secret; the label never enters argv.
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
    const origin = await daemon.waitFor(ORIGIN_LINE, DAEMON_READY_MS);
    expect(origin, `daemon origin:\n${daemon.transcript().slice(-800)}`)
      .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(daemon.transcript()).not.toMatch(
      /pairing token|#pair=|requestId|confirmationLabel|sessionCredential/iu,
    );

    // 3. Seed the J1 chain server-side so a real goal and a sealed plan exist.
    const seed = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "orchestrator", "demo-seed-main.ts"),
    ], root, seedEnv(scratch, origin as string, "SPEED"));
    children.push(seed.child);
    const seedExit = await awaitExit(seed.child, SEED_MS);
    const seedTranscript = seed.transcript();
    // The seed authenticates with the OPERATOR credential, and since ccff6bc1 an
    // operator-authenticated approval.decide carries the daemon's server-assembled
    // human-review witness (planning-services.ts, operatorReviewAuthority): the
    // dispatch itself is the human review, so the seed commits the whole J1 chain
    // and exits 0. The witness travels only with the operator seat - a scoped agent
    // session dispatching the same bytes still answers APPROVAL_HUMAN_REVIEW_REQUIRED
    // - so nothing here invents an approval actor; the helper IS the operator.
    expect(seedExit, `demo seed:\n${seedTranscript.slice(-1000)}`).toBe(0);
    expect(seedTranscript).toContain("committed approval.decide");

    // 4. The browser creates a request and renders only its bounded comparison
    //    label. The foreground operator types that exact label over the private
    //    pipe; only then does the browser claim the approved request.
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    // domcontentloaded, not networkidle: the work board polls the surface every 2s,
    // so the network is never idle; the web-first assertions below wait for attach.
    await page.goto(`${origin as string}/`, { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).origin).toBe(origin);
    expect(new URL(page.url()).hash).toBe("");
    expect(new URL(page.url()).search).toBe("");
    const labelOutput = page.getByLabel("Pairing confirmation label");
    await expect(labelOutput).toBeVisible({ timeout: 20_000 });
    const confirmationLabel = (await labelOutput.textContent())?.trim() ?? "";
    expect(confirmationLabel).toMatch(CONFIRMATION_LABEL);
    expect(await page.content()).not.toContain("requestId");
    expect(daemon.transcript()).not.toContain(confirmationLabel);
    expect(daemon.child.stdin, "the explicit operator pipe must exist").not.toBeNull();
    daemon.child.stdin?.write(`${confirmationLabel}\n`);
    await page.getByRole("button", { name: "I entered this label" }).click();

    // Attached: the goals count leaves CONNECTING and names the one real goal.
    await expect(page.getByTestId("cr.goals.count")).toHaveText(/\d+ GOAL/u, { timeout: 20_000 });
    await expect(page.getByText("goal-live-1").first()).toBeVisible();
    expect(daemon.transcript()).not.toContain(confirmationLabel);

    // A production-attached fact proves the truth/provenance/keyboard invariant
    // together: its class travels with the durable value, Enter opens the exact
    // daemon-projected proof rows, and Escape restores the invoking chip rather than stranding
    // focus in a drawer that no longer exists.
    const goalCard = page.getByTestId("cr.goals.card.goal-live-1");
    const goalTruth = goalCard.getByRole("button", { name: /^Goal: Daemon verified/iu });
    await expect(goalTruth).toHaveAttribute("data-truth-class", "DAEMON_VERIFIED");
    await goalTruth.focus();
    await page.keyboard.press("Enter");
    const proof = page.getByTestId("cr.shell.inspector");
    await expect(proof).toBeVisible();
    await expect(page.getByTestId("cr.shell.inspector.title")).toBeFocused();
    await expect(proof.locator(".cr2-proof-value > span").last()).toHaveText("goal-live-1");
    const receiptRows = await proof.locator(".cr2-proof-row").evaluateAll((rows) => rows.map(
      (row) => ({
        k: row.querySelector(".cr2-proof-row-k")?.textContent ?? null,
        v: row.querySelector(".cr2-proof-row-v")?.textContent ?? null,
      }),
    ));
    expect(receiptRows).toEqual([
      { k: "SOURCE", v: "POST /goals/read" },
      { k: "GOAL", v: "goal-live-1" },
    ]);
    await page.keyboard.press("Escape");
    await expect(proof).toBeHidden();
    await expect(goalTruth).toBeFocused();

    // Open the goal -> plan-review over POST /planning/run/read.
    await page.getByRole("button", { name: /open the board/iu }).first().click();
    await expect(page.getByTestId("cr.approve.screen")).toBeVisible();
    // The seed COMMITS `approval.decide` for this run (demo-seed-plan.ts:95-101 proposes,
    // finalizes, then approves), so the screen must not offer an approval that has already been
    // made — the contradiction task-f053d212 fixed, where the banner read "Ready for your
    // approval" directly above `approval.decide @ run-live-1` in the board's Committed column.
    // Asserted on the banner's own `data-reviewable`, which is the daemon's answer rendered
    // structurally: a negation of one English spelling would be satisfied by any re-wording.
    const banner = page.getByTestId("cr.approve.banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-reviewable", "false");
    // And the read still reports the run's TRUE lifecycle: `approval.decide` writes the goal
    // aggregate, never the run, so PLAN_REVIEW is the honest answer and going quiet about the
    // decision must not become a second falsehood in the other direction.
    await expect(banner).toContainText(/PLAN_REVIEW/u);

    // The control room NEVER authors the approval decision: present but disabled,
    // with the daemon-derived absence named at the plan-approval boundary.
    await expect(page.getByTestId("cr.approve.button")).toBeDisabled();
    await expect(page.getByTestId("cr.approve.reason")).toContainText(
      /APPROVAL_AFFORDANCE_ABSENT.*CONTROL_ROOM_PLAN_APPROVAL/iu,
    );

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
