import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { lanePids, readWireProtocolVersion, survivingPids, withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";

/**
 * THE PROJECT'S GIT REMOTE IS A DAEMON FACT THE BROWSER READS - and an unpublishable goal is
 * offered no publish card at all. One browser, one real daemon, the shipped seed.
 *
 * WHAT THIS PROVES THAT A UNIT TEST CANNOT.
 *  (1) `/repository/remote/read` is reachable FROM THE PAGE. The v2 browser talks to the daemon
 *      through the Vite dev proxy, and that proxy serves exactly `DEV_PROXY_PATHS`. A route
 *      missing from that list never reaches the daemon at all: MEASURED 2026-09-05 by deleting
 *      the entry and re-running this journey, the dev server answers the POST **404** and the arm
 *      below reds with "/repository/remote/read must answer 200 ... Received: 404". So the card
 *      naming the daemon's own answer below IS the proxy pin, executed rather than asserted.
 *  (2) UNBOUND IS A STATE. A fresh store has bound nothing, and the daemon says so with an
 *      all-null REMOTE frame. Nothing in this lane may read that as an error.
 *  (3) NOTHING LANDED MEANS NO CARD, against the daemon's real ladder rather than a fixture
 *      surface: `affordance-planning-offers.ts` withholds `repository.publish` until some node
 *      of the goal is landed as a commit, and the browser renders nothing where the card would be.
 *
 * WHAT THIS LANE CANNOT REACH TODAY, said plainly rather than faked. A landed commit is written
 * ONLY by `apps/daemon/src/orchestrator/node-lander.ts` under the command kind
 * `internal.repository.landing_receipt`, which has no HTTP ingress - it is absent from the
 * daemon's PAYLOAD_KEYS roster, so no browser and no spec-side fetch can author one. The shipped
 * demo seed never calls the lander either. A journey that drove a real first publish would
 * therefore have to build a landing lane first. The live drive on UnAI is where a real publish is
 * exercised; here the reachable half is proven honestly and the unreachable half is not simulated.
 *
 * THE ABSENCE ASSERTION IS NOT VACUOUS. The same surface read that carries no `repository.publish`
 * is asserted to carry OTHER offers, so "no publish offer" is distinguished from "no offers".
 */

/**
 * HAND-TRANSCRIBED from apps/control-room/src (v2/ops/repository-card.tsx test ids and wording,
 * v2/goals/goal-publish.tsx test ids, live/live-repository-remote.ts frame keys) for the reason
 * daemon-board.spec.ts gives: this directory's tsconfig cannot reach into apps/ (TS6059), and
 * deriving the expected strings from the modules that render them would make the assertions
 * self-referential - they would pass whatever the page put on screen.
 */
const REPOSITORY_REMOTE_PATH = "/repository/remote/read";
const REMOTE_FRAME_KEYS = ["boundAt", "boundBy", "outcome", "readAt", "remoteUrl"] as const;
const UNBOUND_WORDS = "No remote bound - bind it from the Publish card on any goal.";
const PUBLISH_KIND = "repository.publish";
const PAIRING_BUDGET_MS = 30_000;
const CLICK_BUDGET_MS = 10_000;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Asks the DAEMON the same question the page asks, with the credentials the bundle carries. */
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

/** The operator's real pairing ritual; see provider-pause.spec.ts for why every click is bounded. */
async function pairBrowser(page: Page, lane: DaemonLane): Promise<void> {
  const approve = lane.approvePairing;
  expect(approve, "the lane must expose an operator channel").not.toBeNull();
  const output = page.getByLabel("Pairing confirmation label");
  await expect(output).toBeVisible({ timeout: 30_000 });
  const label = (await output.textContent())?.trim() ?? "";
  expect(label, "the browser must be shown a real label").toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u);
  approve?.(label);
  const confirm = page.getByRole("button", { name: "I entered this label" });
  const deadline = Date.now() + PAIRING_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await output.count() === 0) return;
    await confirm.click({ timeout: 5_000 }).catch(() => undefined);
    await sleep(1_000);
  }
  await expect(output, "the pairing card must close").toHaveCount(0, { timeout: 10_000 });
}

/** The daemon's own REMOTE frame for a store that has bound nothing. Recorded, then asserted. */
async function assertUnboundFrame(lane: DaemonLane): Promise<Readonly<Record<string, unknown>>> {
  const frame = await askDaemon(lane, REPOSITORY_REMOTE_PATH, "{}");
  expect(isRecord(frame), `${REPOSITORY_REMOTE_PATH} must answer an object`).toBe(true);
  const record = isRecord(frame) ? frame : {};
  // The EXACT key set the committed control-room decoder admits. A daemon that grew or dropped a
  // key here would refuse at the browser's decoder, and this arm is what catches that first.
  expect(Object.keys(record).sort()).toEqual([...REMOTE_FRAME_KEYS]);
  expect(record["outcome"]).toBe("REMOTE");
  expect(record["remoteUrl"], "a fresh store has bound no remote").toBeNull();
  expect(record["boundAt"]).toBeNull();
  expect(record["boundBy"]).toBeNull();
  expect(typeof record["readAt"], "the daemon states when it read").toBe("string");
  return record;
}

/** The seeded goal has nothing landed, so the daemon must withhold `repository.publish`. */
async function assertPublishWithheld(lane: DaemonLane): Promise<void> {
  const surface = await askDaemon(lane, "/affordances/read", "{}");
  expect(isRecord(surface) && surface["outcome"]).toBe("SURFACE");
  // The daemon names the roster `nextAllowedCommands`; `offers` is the BROWSER's decoded name
  // for it (live-board-feed.ts:265). Reading the browser's name off the daemon's frame silently
  // yields an empty list, which is why the non-vacuity control below is here at all - it is what
  // caught this spec reading the wrong key.
  const offers = isRecord(surface) && Array.isArray(surface["nextAllowedCommands"])
    ? surface["nextAllowedCommands"] : [];
  const kinds = offers.flatMap((offer) => (isRecord(offer) && typeof offer["commandKind"] === "string"
    ? [offer["commandKind"]] : []));
  // NOT VACUOUS: the surface really is offering things, just never a publish.
  expect(kinds.length, "the seeded surface must offer something").toBeGreaterThan(0);
  expect(kinds, "nothing is landed, so no publish may be offered").not.toContain(PUBLISH_KIND);
}

test("the browser reads the project's bound remote from the daemon, and no publish card exists with nothing landed",
  async ({ page }, testInfo) => {
    const live = await withDaemonBackedControlRoom(
      { liveCredentials: "ATTACHED", operatorChannel: true, seed: "SHIPPED" },
      async (lane) => {
        expect(lane.daemonOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
        expect(lane.daemonPid).not.toBe(lane.serverPid);

        const frame = await assertUnboundFrame(lane);
        await assertPublishWithheld(lane);

        await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("cr2.shell.root")).toHaveCount(1, { timeout: 30_000 });
        await pairBrowser(page, lane);
        await page.getByTestId("cr.nav.health").click({ timeout: CLICK_BUDGET_MS });

        // THE PROXY PIN, EXECUTED. Reaching this text means the dev server proxied the route to
        // the daemon; unproxied, the decoder would have refused the SPA's HTML instead.
        const remote = page.getByTestId("cr.health.repository.remote");
        await expect(remote, "the Repository card must state the daemon's answer")
          .toHaveText(UNBOUND_WORDS, { timeout: 30_000 });
        await expect(page.getByTestId("cr.health.repository.refusal")).toHaveCount(0);
        // Unbound withholds the two facts rather than printing them as "unknown".
        await expect(page.getByTestId("cr.health.repository.facts")).toHaveCount(0);
        // Change on Health says where the rebind happens; it never claims to rebind from here.
        await page.getByTestId("cr.health.repository.change").click({ timeout: CLICK_BUDGET_MS });
        await expect(page.getByTestId("cr.health.repository.changehow"))
          .toContainText("Publish card on any goal", { timeout: 10_000 });

        // NOTHING LANDED -> NO CARD, in the real browser over the real daemon.
        await expect(page.getByTestId("cr.publish.root")).toHaveCount(0);
        await expect(page.getByTestId("cr.publish.button")).toHaveCount(0);
        await expect(page.getByTestId("cr.publish.remote")).toHaveCount(0);

        const evidence = `daemon pid ${String(lane.daemonPid)} at ${lane.daemonOrigin}; `
          + `unbound frame ${JSON.stringify(frame)}`;
        testInfo.annotations.push({ description: evidence, type: "publish-remote-lane" });
        console.log(`[publish-remote] ${evidence}`);
        return lanePids(lane);
      },
    );
    expect(live.ok ? "ok" : `${live.code}: ${live.detail}`).toBe("ok");
    if (live.ok) expect(await survivingPids(live.value), "teardown must leave no orphans").toEqual([]);
  });
