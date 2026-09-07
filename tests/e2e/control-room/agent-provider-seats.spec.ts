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

    // AND IT IS CORRECTLY REFUSED, WHICH IS THE MEASURED TRUTH OF THIS TREE - see the fixme
    // below. The daemon does not offer `project.set_agent_provider` on /affordances/read at
    // all, so there is no version to write at and the control fails CLOSED: both buttons
    // disabled, and a sentence saying WHY rather than a dead control. That is a property
    // worth pinning on its own - a toggle that silently did nothing would be worse than one
    // that says it cannot act.
    await expect(page.getByTestId("cr.sessions.provider.choose.codex")).toBeDisabled();
    expect((await page.getByTestId("cr.sessions.provider.unoffered").textContent()) ?? "")
      .toContain("cannot change the provider");

    expect(await page.getByTestId("cr.banner.fixture").count()).toBe(0);
  } finally {
    for (const child of [...children].reverse()) await killTree(child);
    try { rmSync(scratch.root, { force: true, recursive: true }); } catch { /* scratch leftover */ }
  }
  expect(await survivingPids(pids), "the lane must leave no orphan daemon").toEqual([]);
});

/**
 * DoD-1's WRITE HALF, parked as an executable statement of what is missing rather than
 * deleted or quietly weakened.
 *
 * THE BROWSER SIDE IS COMPLETE AND UNIT-PROVEN: the port builds the daemon's exact
 * three-key payload, overlays only the operator's choice, and spends an offer through the
 * generated builder (agent-provider-port.test.ts, agent-provider-toggle.test.tsx). What is
 * missing is on the DAEMON: `/affordances/read` never offers `project.set_agent_provider`.
 * Measured 2026-09-07 at HEAD 6dbdbe69 - `affordance-read.ts` builds its offer array by
 * mapping `BOOTSTRAP_COMMAND_KINDS` (bootstrap-contracts.ts:30), plus the planning and
 * deploy-target resolvers, and the kind is in NONE of them. `commandBuilderFor`
 * (generated-client.ts:119) refuses without an affordance - `AFFORDANCE_REQUIRED_ERROR` -
 * because it reads `commandId`, `expectedVersion` and `targetAggregateId` off the offer. So
 * no browser can write this setting today, however correct its caller half.
 *
 * IT IS PARKED RATHER THAN FIXED HERE BECAUSE IT IS A REBUILD, NOT A PROOF (this row's rail
 * 3). `BOOTSTRAP_COMMAND_KINDS` is order-asserted by existing suites - its own comment says
 * so - and has ten non-test consumers including the bootstrap ledger, the cutover service,
 * the session contracts and the command graph contracts. Adding a kind there also adds a
 * `ChainStep` every consumer of the chain array reads.
 *
 * UNPARK IT by removing `.fixme` once the daemon offers the kind. Nothing else here changes.
 */
test.fixme("the chosen provider round-trips through the daemon and back", async () => {
  // Body intentionally empty: the assertions cannot be written honestly against a surface
  // that offers nothing, and a body full of skipped expectations would read as coverage.
});
