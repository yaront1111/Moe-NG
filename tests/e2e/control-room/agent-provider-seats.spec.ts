import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { killTree, spawnNode, survivingPids } from "./daemon-children.js";
import { LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot } from "./daemon-ports.js";

/**
 * REAL-DAEMON journey for task-c090faae: the operator chooses which agent CLI staffs this
 * project's seats, and the Seats screen discloses what is actually running on what credential.
 *
 * THE POINT OF DOING THIS AGAINST A LIVE DAEMON is that /sessions/read's browser decoder is
 * EXACT-ARITY: a per-seat member added on the daemon and not in live-sessions.ts does not
 * degrade the Seats screen, it BLANKS it into an ERROR frame. A unit test with a hand-built
 * frame cannot catch that, because the hand-built frame is written against the decoder. Only
 * the daemon's OWN frame, decoded and rendered, proves the two halves moved together - which
 * is the round trip DoD-5 asks for.
 *
 * THE FIXTURE SHELL IS ASSERTED ABSENT, not assumed. The built bundle has been observed to
 * honour `?v1=1&fixtures=1` and mount the legacy demo shell
 * (mem:control-room-production-bundle-serves-fixtures-on-a-url-param), and a journey that
 * silently read fabricated data would prove nothing at all about the daemon. Every assertion
 * below is guarded by a zero-count check on `cr.banner.fixture`.
 *
 * NO SEAT IS STAFFED HERE. This journey deliberately never waits for a real agent to spawn:
 * the provider CLIs have vendor quotas (the lane hit a real claude session limit on
 * 2026-09-07), and a browser proof that depends on a vendor being up is a proof that goes red
 * for reasons that have nothing to do with this code. The paired browser's OWN session is a
 * real seat on this frame, and it is enough to prove the decode.
 */

const DAEMON_READY_MS = 60_000;
const BUILD_MS = 180_000;
const CLICK_BUDGET_MS = 20_000;
const ORIGIN_LINE = /listening on (http:\/\/127\.0\.0\.1:\d+)/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;

const awaitExit = (child: ChildProcess, ms: number): Promise<number | null> =>
  new Promise((done) => {
    const timer = setTimeout(() => { done(null); }, ms);
    child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });

test("the browser chooses the agent provider and Seats discloses it from a real daemon", async ({ page }) => {
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

    // PAIR. The provider setting is OPERATOR_ONLY and MCP-excluded, so an unpaired browser
    // cannot reach it at all - pairing is part of what this journey proves.
    const labelOutput = page.getByLabel("Pairing confirmation label");
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(labelOutput).toBeVisible({ timeout: 20_000 });
    const confirmationLabel = (await labelOutput.textContent())?.trim() ?? "";
    expect(confirmationLabel).toMatch(CONFIRMATION_LABEL);
    expect(daemon.child.stdin, "the explicit operator pipe must exist").not.toBeNull();
    daemon.child.stdin?.write(`${confirmationLabel}\n`);
    await page.getByRole("button", { name: "I entered this label" }).click();
    await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: 60_000 });

    await page.getByTestId("cr.nav.health").click({ timeout: CLICK_BUDGET_MS });
    await expect(page.getByTestId("cr.sessions.root")).toBeVisible({ timeout: 30_000 });
    // FIXTURES ARE NOT WHAT IS BEING READ. Asserted before anything is believed.
    expect(await page.getByTestId("cr.banner.fixture").count(),
      "the production bundle must not have mounted the legacy fixture shell").toBe(0);

    // THE ROUND TRIP. The Seats panel renders at all only if the daemon's OWN frame passed
    // the exact-arity decode; a member added on one side alone would show the refusal note
    // here instead. Assert the refusal is ABSENT as well as the disclosure being present, so
    // a blanked frame cannot read as a pass.
    await expect(page.getByTestId("cr.sessions.refusal")).toHaveCount(0);
    await expect(page.getByTestId("cr.sessions.disclosure")).toBeVisible({ timeout: 20_000 });

    // The paired browser is itself a seat on this frame, so at least one per-seat start row
    // must have decoded. Its provider is the daemon's stated unknown - nothing spawned it -
    // and that is exactly what the row must be able to say without inventing a reading.
    //
    // ATTACHED, then VISIBLE, and the two are separate assertions on purpose. Seats keeps
    // browser seats behind a COLLAPSED `<details>`, so in this lane - where the only seat is
    // the browser itself - the row is in the DOM and hidden. The decode is what `toBeAttached`
    // proves; opening the disclosure proves an operator can actually reach it. Asserting only
    // visibility here fails on a correct screen, and asserting only attachment would pass on
    // one nobody can read.
    const startFacts = page.locator("[data-testid^='cr.sessions.seat.start.']");
    await expect(startFacts.first(), "the daemon's per-seat members must decode")
      .toBeAttached({ timeout: 20_000 });
    const browsers = page.getByTestId("cr.sessions.browsers");
    if (await browsers.count() > 0) await browsers.locator("summary").click();
    await expect(startFacts.first(), "an operator must be able to reach the per-seat facts")
      .toBeVisible({ timeout: 20_000 });
    expect((await startFacts.first().textContent())?.trim() ?? "").toContain("started under");

    // THE CREDENTIAL LINE IS PRESENT AND CARRIES NO VALUE. The lane daemon runs with whatever
    // credential the host has, so what is asserted is the INVARIANT rather than one outcome:
    // the line says something, and nothing on the page looks like a credential value.
    const credential = page.getByTestId("cr.sessions.credential");
    await expect(credential).toBeVisible({ timeout: 20_000 });
    expect(((await credential.textContent()) ?? "").trim().length).toBeGreaterThan(0);

    // THE OVERRIDE DISCLOSURE, DoD-4. The lane sets no MOE_AGENT_COMMAND, so the browser
    // choice is what is in force and the screen must say so rather than staying silent.
    const override = page.getByTestId("cr.sessions.provider.override");
    await expect(override).toBeVisible();
    expect((await override.textContent()) ?? "").toContain("Seats start under");

    // THE TOGGLE. Both providers the daemon knows are offered, in the daemon's order.
    await expect(page.getByTestId("cr.sessions.provider.choose.claude")).toBeVisible();
    await expect(page.getByTestId("cr.sessions.provider.choose.codex")).toBeVisible();
    const configured = page.getByTestId("cr.sessions.provider.configured");
    expect((await configured.textContent()) ?? "").toContain("claude");

    // DoD-1'S WRITE PATH, DRIVEN AS FAR AS IT GOES, AND THE EXACT AUTHORITY THAT STOPS IT.
    // This block replaced a parked `test.fixme` and an assertion that the control was
    // DISABLED. Two different things stood between the browser and this setting, and only one
    // of them is fixed:
    //
    // FIXED (task-96957529): `/affordances/read` minted no `project.set_agent_provider` offer,
    // so `commandBuilderFor` refused INPUT_INVALID at the BROWSER, the control was permanently
    // greyed, and the copy beside it blamed a correctly-paired operator for not pairing. The
    // daemon now mints it (`affordance-agent-provider-offers.ts`). The first two assertions
    // are that fix: no unoffered note, and a LIVE control an operator can actually press.
    //
    // NOT FIXED, AND DELIBERATELY NOT FIXED HERE: the kind is in `OPERATOR_PRINCIPAL_KINDS`,
    // and that fence compares the authenticated principal against the daemon's CONFIGURED
    // operator id. A paired browser is a session-ledger HUMAN, never that principal, so it is
    // refused `OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION` at dispatch. Admitting a
    // paired HUMAN holding ADMIN is a SECURITY-BOUNDARY WIDENING; the precedent
    // (task-6d5db404, `repository.bootstrap`, the typed SOFT_POLICY_WAIVER arm) is that such
    // a widening is its own reviewed row and is never folded into a UI proof row, and this
    // row's rail 2 forbids policy work outright. Greening this line by widening the fence
    // would be a test greening itself.
    //
    // SO THE ASSERTION IS THE REASON CODE, NOT THE OUTCOME. "The write did not happen" would
    // pass identically for a missing offer, an unbuildable envelope, a dead click handler and
    // this refusal — four defects with four different owners. Naming the code and the LAYER
    // pins WHICH authority answered, and it is the one line that will change when the
    // widening lands.
    await expect(page.getByTestId("cr.sessions.provider.unoffered")).toHaveCount(0);
    await expect(page.getByTestId("cr.sessions.provider.choose.codex")).toBeEnabled();
    await page.getByTestId("cr.sessions.provider.choose.codex").click({ timeout: CLICK_BUDGET_MS });
    const refusal = page.getByTestId("cr.sessions.provider.refusal");
    await expect(refusal).toBeVisible({ timeout: 30_000 });
    await expect(refusal).toContainText("OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION");
    // The refusing authority's OWN words, carried through offer-wire's `detail` rather than
    // summarised — the field exists so an operator reads what to fix, not just that it broke.
    await expect(page.getByTestId("cr.sessions.provider.refusal.detail"))
      .toContainText("requires the configured operator principal");
    // NO FALSE SUCCESS AND NO DURABLE MOVE. The acceptance note must be absent, and the
    // CONFIGURED line — re-read from /sessions/read on the panel's own 5s poll — must still
    // say claude, so a refusal that nevertheless wrote could not read as a pass.
    await expect(page.getByTestId("cr.sessions.provider.recorded")).toHaveCount(0);
    await expect(configured).toContainText("claude");

    expect(await page.getByTestId("cr.banner.fixture").count()).toBe(0);
  } finally {
    for (const child of [...children].reverse()) await killTree(child);
    try { rmSync(scratch.root, { force: true, recursive: true }); } catch { /* scratch leftover */ }
  }
  expect(await survivingPids(pids), "the lane must leave no orphan daemon").toEqual([]);
});
