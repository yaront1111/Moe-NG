import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { lanePids, survivingPids, withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";
import { readWireProtocolVersion } from "./daemon-scratch.js";

/**
 * The DAEMON-BACKED journey: one browser, one real daemon, one real seed.
 *
 * WHAT MAKES THIS DIFFERENT FROM `journeys.spec.ts`. That file drives a static
 * server over the built bundle and asserts only what a fixture build can honestly
 * say. This one starts `daemon-main.ts` on an ephemeral port, runs the shipped
 * `demo-seed-main.ts` against it, serves the control room through the Vite dev
 * server's proxy, and asserts the board rendered the DAEMON's own answer.
 *
 * HOW "REAL DATA" IS MADE FALSIFIABLE. The seeded node's aggregate id is minted
 * per run from the scratch directory's random suffix, so the id this journey
 * asserts on cannot appear in the committed fixture corpus — a fixture build
 * cannot pass the positive arm by coincidence. The same id is then read back FROM
 * THE DAEMON through the same proxy, so the DOM is bound to the daemon's answer
 * rather than to this file's expectations.
 *
 * THE FIXTURE-MARKER ASSERTION IS LOAD-BEARING, and the negative arm is what
 * proves it: an absence assertion over a marker that never renders anywhere would
 * pass over nothing, so the same page is re-opened with `?fixtures=1` and the
 * marker must APPEAR. The refusal arm does the same job for the fail-closed path.
 *
 * ONE journey, three arms. Lifecycle, readiness and teardown belong to
 * `daemon-ports.ts` and are composed here, never reimplemented.
 */

/**
 * HAND-TRANSCRIBED from apps/control-room/src/shell-mode.ts (FIXTURES_QUERY_PARAM)
 * and shell-mode-view.tsx, for the reason journeys.spec.ts gives: this directory's
 * tsconfig cannot reach into apps/control-room (TS6059), and deriving the expected
 * strings from the modules that render them would make the assertions
 * self-referential — they would pass whatever the page put on screen.
 */
const FIXTURES_QUERY = "?v1=1&fixtures=1";
const FIXTURE_MARKER = "Fixture board —";
const CREDENTIALS_ABSENT_CODE = "LIVE_CONFIG_MISSING";

/** How live-board.tsx keys a card: `cr.liveboard.card.<kind>@<aggregateId>`. */
const seededCardTestId = (lane: DaemonLane): string =>
  `cr.liveboard.card.node.deliver@${lane.nodeRef}`;

interface SurfaceStep {
  readonly aggregateId: string;
  readonly kind: string;
  readonly status: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stepsOf(payload: unknown): readonly SurfaceStep[] {
  if (!isRecord(payload) || !Array.isArray(payload["steps"])) return [];
  return payload["steps"].flatMap((entry): readonly SurfaceStep[] => {
    if (!isRecord(entry)) return [];
    const { aggregateId, kind, status } = entry;
    return typeof aggregateId === "string" && typeof kind === "string" && typeof status === "string"
      ? [{ aggregateId, kind, status }]
      : [];
  });
}

/**
 * Asks the DAEMON the same question the board asks — through the same proxy, with
 * the same credentials the served bundle carries. `x-moe-protocol-version` is
 * read from the generated client's committed bridge; a stale value is answered
 * DISTRIBUTION_MISMATCH at stage COMPATIBILITY rather than with a surface.
 */
async function askDaemon(lane: DaemonLane, path: string, body: string): Promise<unknown> {
  const protocolVersion = await readWireProtocolVersion(lane.repoRoot);
  expect(protocolVersion, "the generated wire protocol version must load").not.toBeNull();
  const response = await fetch(`${lane.baseUrl}${path}`, {
    body,
    headers: {
      "content-type": "application/json",
      "x-moe-csrf": lane.csrfToken,
      "x-moe-protocol-version": protocolVersion ?? "",
      "x-moe-session-credential": lane.credential,
    },
    method: "POST",
  });
  expect(response.status, `${path} must answer 200`).toBe(200);
  return await response.json();
}

/** The live arm: the seeded step, its truth chips, and no fixture marker anywhere. */
async function assertLiveBoard(page: Page, lane: DaemonLane): Promise<void> {
  await page.goto(`${lane.baseUrl}?v1=1`);
  const card = page.getByTestId(seededCardTestId(lane));
  await expect(card, "the seeded node.deliver card must render").toBeVisible({ timeout: 60_000 });
  // In the READY column, which is where the daemon put it — a card rendered under
  // the wrong status would still satisfy a bare visibility check.
  await expect(page.getByTestId("cr.liveboard.column.ready").getByTestId(seededCardTestId(lane)))
    .toHaveCount(1);
  await expect(card).toContainText(lane.nodeRef);

  // Truth chips on the ledger facts the live attachment renders. The relay round
  // trip and the ledger checkpoint are both OBSERVED, and the checkpoint's value
  // is real ledger state, not a label.
  const checkpoint = page.getByTestId("cr.fact.live.checkpoint");
  await expect(checkpoint, "the ledger checkpoint fact must render").toBeVisible();
  await expect(checkpoint.getByTestId("cr.chip.observed")).toHaveAttribute(
    "data-truth-class", "OBSERVED",
  );
  await expect(page.getByTestId("cr.fact.live.connection").getByTestId("cr.chip.observed"))
    .toHaveCount(1);

  // Fail closed: no fixture board underneath and no fixture marker anywhere. The
  // negative arm below proves this absence is not vacuous.
  await expect(page.getByTestId("cr.banner.fixture")).toHaveCount(0);
  await expect(page.getByTestId("cr.config.notice")).toHaveCount(0);
  expect(await page.content()).not.toContain(FIXTURE_MARKER);
}

/**
 * Binds the DOM to the daemon: the rendered card's identity and the rendered
 * checkpoint must both be what the daemon itself answers over the same proxy.
 * A static file server cannot answer either request at all.
 */
async function assertLedgerTruth(page: Page, lane: DaemonLane): Promise<void> {
  const surface = await askDaemon(lane, "/affordances/read", "{}");
  const seeded = stepsOf(surface).filter((step) => step.aggregateId === lane.nodeRef);
  expect(seeded, `the daemon must serve a step for ${lane.nodeRef}`).toEqual([
    { aggregateId: lane.nodeRef, kind: "node.deliver", status: "READY" },
  ]);

  const page1 = await askDaemon(lane, "/events/read", JSON.stringify({
    limit: 5, projection: "moe.board", subscriberId: "control-room-1",
  }));
  expect(isRecord(page1) && page1["outcome"]).toBe("PAGE");
  const checkpoint = isRecord(page1) ? page1["checkpoint"] : null;
  expect(typeof checkpoint, "the event page must carry a checkpoint").toBe("string");
  // The rendered checkpoint IS the ledger's, character for character.
  await expect(page.getByTestId("cr.fact.live.checkpoint").getByTestId("cr.value"))
    .toHaveText(String(checkpoint));
}

/** The negative arm: the same served bundle, with fixtures asked for explicitly. */
async function assertFixtureMarkerAppears(page: Page, lane: DaemonLane): Promise<void> {
  await page.goto(`${lane.baseUrl}${FIXTURES_QUERY}`);
  const banner = page.getByTestId("cr.banner.fixture");
  await expect(banner, "the fixture marker must appear when fixtures are asked for")
    .toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText(FIXTURE_MARKER);
  // And the live board is gone: the two modes are exclusive, so the positive
  // arm's absence assertion is about a marker that demonstrably can render.
  await expect(page.getByTestId("cr.liveboard")).toHaveCount(0);
}

test("the live board renders the daemon's own seeded step, and says so honestly", async ({ page }, testInfo) => {
  const live = await withDaemonBackedControlRoom({ liveCredentials: "ATTACHED" }, async (lane) => {
    // DoD 1: a spawned daemon, not a static file server. Its origin is its own
    // process on its own ephemeral port, and that process is alive right now.
    expect(lane.daemonOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(lane.daemonOrigin).not.toBe(lane.baseUrl);
    expect(lane.daemonPid).toBeGreaterThan(0);
    expect(lane.daemonPid).not.toBe(lane.serverPid);
    expect(await survivingPids([lane.daemonPid]), "the spawned daemon must be running")
      .toEqual([lane.daemonPid]);

    await assertLiveBoard(page, lane);
    await assertLedgerTruth(page, lane);
    await assertFixtureMarkerAppears(page, lane);

    const evidence = `daemon pid ${String(lane.daemonPid)} at ${lane.daemonOrigin}; `
      + `server pid ${String(lane.serverPid)} at ${lane.baseUrl}; seeded ${lane.nodeRef}`;
    testInfo.annotations.push({ description: evidence, type: "daemon-lane" });
    console.log(`[daemon-lane] ${evidence}`);
    return { evidence, pids: lanePids(lane) };
  });

  // The lane's outcome is pinned too: a run that refused before the body, or that
  // left a process behind, must never read as a passing journey.
  expect(live.ok ? "ok" : `${live.code}: ${live.detail}`).toBe("ok");
  if (!live.ok) return;
  expect(await survivingPids(live.value.pids), "teardown must leave no orphans").toEqual([]);
  console.log(`[daemon-lane] no orphans after teardown: ${live.value.pids.join(",")}`);

  // The refusal arm: the SAME server, serving a bundle with no credentials. It
  // must name its own code rather than quietly falling back to fixtures.
  const refused = await withDaemonBackedControlRoom(
    { liveCredentials: "ABSENT" },
    async (lane) => {
      await page.goto(`${lane.baseUrl}?v1=1`);
      const notice = page.getByTestId("cr.config.notice");
      await expect(notice, "an unconfigured build must refuse visibly")
        .toBeVisible({ timeout: 60_000 });
      await expect(notice).toContainText(CREDENTIALS_ABSENT_CODE);
      await expect(notice).toContainText("VITE_MOE_LIVE_CREDENTIAL");
      await expect(notice).toContainText("VITE_MOE_LIVE_CSRF");
      // No silent fallback in either direction: no live board, no fixture board.
      await expect(page.getByTestId("cr.liveboard")).toHaveCount(0);
      await expect(page.getByTestId("cr.banner.fixture")).toHaveCount(0);
      return lanePids(lane);
    },
  );
  expect(refused.ok ? "ok" : `${refused.code}: ${refused.detail}`).toBe("ok");
  if (refused.ok) expect(await survivingPids(refused.value)).toEqual([]);
});
