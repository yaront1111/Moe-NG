/**
 * AN ENVIRONMENT GOES DOWN AND THE OPERATOR ROLLS IT BACK, IN A REAL BROWSER, AGAINST A REAL
 * DAEMON. The journey monitoring/backup/rollback shipped for, driven end to end for the first
 * time: a good release, a bad one, three failed probes, ONE incident card, the rollback the
 * daemon itself offers on that card, and the recovery its own probe loop observes afterwards.
 *
 * WHAT IS REAL. The daemon process; the durable schedule and the health-probe job it arms; REAL
 * HTTP probes over the loopback to a REAL server; the bounded probe ring and the incident row;
 * the deploy ledger; `deployment.rollback` at the production command edge with its operator
 * fence; and all three browser surfaces - the Needs-you incident card, its arm-then-confirm
 * rollback control, and the Health screen's Environments section - served by the shipped bundle.
 *
 * WHAT IS A DOUBLE, and it is exactly two things. (1) The deploy's SPAWNS, injected at the
 * production composition seam by `fake-docker-dependencies.ts`, so no container runs. (2) The
 * wrapper's SEAT, for the reason `wrapper-lane.ts` gives. The environment's HTTP answer is
 * therefore served by `lane-rollback-incident.ts`'s endpoint rather than by a container - and it
 * is not a switch this spec flips: it answers healthy only while the CURRENT deploy receipt names
 * the good sha, so the outage and the recovery are both consequences of receipts the daemon
 * committed. See that module's header for what this can and cannot prove.
 *
 * WHY THE ROLLBACK IS DISPATCHED TWICE, and why that is the point rather than a workaround. The
 * shipped browser pairs into a NON-OPERATOR credential (`main.tsx:128` ->
 * `live-handshake.ts:170-186`), and `deployment.rollback` fences on the CONFIGURED OPERATOR at
 * its own handler entry (`rollback-command.ts:80-83`) - an async entry the registry's synchronous
 * operator check never reaches. So the paired human's confirm is REFUSED, by code and by layer,
 * and the card shows them which authority said no, exactly as `preview-approve-live.spec.ts`
 * asserts the same wall for `preview.decide`. The rollback that actually runs is then dispatched
 * by the configured operator, which `lane.credential` provably is.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { readCurrentDeployReceipt } from "../../../apps/daemon/src/deployment/deploy-ledger.js";
import { deployTargetAggregateId }
  from "../../../apps/daemon/src/deployment/deploy-target-contracts.js";
import type { DeployReceiptV1 }
  from "../../../apps/daemon/src/deployment/deploy-receipt-contracts.js";
import { mintLaneOperatorSeat, withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";
import { CARD_MS, LANE_TIMEOUT_MS, assertStopped, pair } from "./lane-preview-arms.js";
import {
  currentDeploySha, landAndPublish, laneCommand, readLaneHealth, startEnvironmentEndpoint,
  withLaneStore,
} from "./lane-rollback-incident.js";
import type { LaneEnvironmentEndpoint } from "./lane-rollback-incident.js";

const ENVIRONMENT = "preview";
/**
 * The floor is arithmetic, not a guess: the sweep reconciles the per-environment schedules on its
 * OWN tick (60 s, `DEFAULT_PROBE_INTERVAL_MS`), the dedicated job then arms at the operator's
 * interval, and DOWN needs `HEALTH_FAILURE_THRESHOLD` = 3 of them. 60 + 3x5 = 75 s before any
 * browser poll is added, so a card budget would expire on a healthy system.
 */
const OUTAGE_MS = 300_000;
/** The tightest interval `admitProbeInterval` accepts (`MIN_PROBE_INTERVAL_MS`). */
const PROBE_INTERVAL_MS = 5_000;

/** Every pid this spec is answerable for beyond the lane's own. */
const wrapperPids: number[] = [];

function receiptOf(lane: DaemonLane): DeployReceiptV1 | null {
  return withLaneStore(lane, (store) =>
    readCurrentDeployReceipt(store, lane.projectId, ENVIRONMENT));
}

async function deploy(lane: DaemonLane, sha: string): Promise<DeployReceiptV1> {
  const answer = await laneCommand(lane, "deployment.deploy", lane.projectId, { environment: ENVIRONMENT, sha });
  // The prerequisite chain refuses BEFORE the double is reached, so its absence is asserted:
  // a regression there would otherwise look like a deploy that simply never spawned anything.
  expect(JSON.stringify(answer)).not.toContain("BOOTSTRAP_PREREQUISITE_MISSING");
  expect(answer, `DEPLOY ${sha}: ${JSON.stringify(answer)}`).toMatchObject({ outcome: "ACCEPTED" });
  const receipt = receiptOf(lane);
  expect(receipt, `no receipt after deploying ${sha}`).not.toBeNull();
  expect(receipt).toMatchObject({ outcome: "DEPLOYED", sha });
  expect(receipt?.imageDigest, "a rollback target needs a digest").toMatch(/^sha256:[0-9a-f]{64}$/u);
  if (receipt === null) throw new Error("unreachable: the assertion above fails first");
  return receipt;
}

/**
 * The daemon's own verdict, polled until the outage is real. This is what gives the browser
 * assertions an EXACT incident id to name instead of a prefix match over whatever card is there.
 */
async function waitForIncident(lane: DaemonLane): Promise<number> {
  const deadline = Date.now() + OUTAGE_MS;
  let last = "";
  while (Date.now() < deadline) {
    const health = await readLaneHealth(lane, ENVIRONMENT);
    last = JSON.stringify(health);
    const incident: unknown = health["incident"];
    if (health["state"] === "DOWN" && typeof incident === "object" && incident !== null) {
      const id: unknown = (incident as Record<string, unknown>)["id"];
      if (typeof id === "number") return id;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  expect(`the environment never reached DOWN with an open incident: ${last}`).toBe("DOWN");
  throw new Error("unreachable: the assertion above fails first");
}

/**
 * EVERY EXIT PATH STOPS WHAT THE ARM STARTED, and each stop is MEASURED rather than assumed: the
 * doubled environment's port is probed with a REAL connect, because `close()` returning is not
 * evidence a keep-alive socket let go of it, and the lane's own pids and scratch tree go through
 * `assertStopped`. Epic rail 4: a lane that leaks a port makes every later gate inadmissible.
 */
async function stopEverything(lane: DaemonLane | undefined,
  endpoint: LaneEnvironmentEndpoint | undefined): Promise<void> {
  await endpoint?.close();
  if (endpoint !== undefined) {
    expect(await endpoint.closed(), "the doubled environment releases its port").toBe(true);
  }
  await assertStopped(lane, wrapperPids);
}

async function openIncidentCard(page: Page, incidentId: number): Promise<string> {
  const testId = `cr.needsyou.incident.${ENVIRONMENT}#${String(incidentId)}`;
  await page.getByTestId("cr.nav.approvals").click();
  await expect(page.getByTestId("cr.needsyou.root")).toBeVisible({ timeout: CARD_MS });
  await expect(page.getByTestId(testId)).toBeVisible({ timeout: CARD_MS });
  return testId;
}

test("real daemon: a bad release goes DOWN, the incident card offers the rollback, the rollback recovers it",
  async ({ page }) => {
    // `LANE_TIMEOUT_MS` budgets a lane with a landing in it; the outage this spec waits out is on
    // top of that, and the wait is the daemon's own 60 s reconcile tick plus three probes.
    test.setTimeout(LANE_TIMEOUT_MS + OUTAGE_MS);
    let started: DaemonLane | undefined;
    let endpoint: LaneEnvironmentEndpoint | undefined;
    wrapperPids.length = 0;
    try {
      const result = await withDaemonBackedControlRoom({
        fakeDocker: "SUCCESS", liveCredentials: "ATTACHED", operatorChannel: true,
      }, async (lane) => {
        started = lane;
        // THE GOOD SHA IS THE LANE'S OWN BASELINE COMMIT, which git really holds, so the deploy's
        // `git rev-parse --verify <sha>^{commit}` preflight passes on it exactly as it does on the
        // landed one. Two real commits, two real images, one rollback target between them.
        const goodSha = lane.workspaceSha;
        endpoint = await startEnvironmentEndpoint(
          () => currentDeploySha(lane, ENVIRONMENT) === goodSha);
        const bound = await laneCommand(lane, "deployment.set_target",
          deployTargetAggregateId(lane.projectId, ENVIRONMENT),
          { environment: ENVIRONMENT, network: "lane-network", sshTarget: null, url: endpoint.url });
        expect(bound, JSON.stringify(bound)).toMatchObject({ outcome: "ACCEPTED" });
        // BEFORE THE LANDING, deliberately: the sweep reconciles the dedicated schedule on its own
        // 60 s tick, and the landing is the slowest thing here. Setting it first means the arm has
        // happened by the time there is anything to probe.
        const timed = await laneCommand(lane, "monitoring.set_probe_interval", lane.projectId,
          { environment: ENVIRONMENT, intervalMs: PROBE_INTERVAL_MS });
        expect(timed, `PROBE INTERVAL: ${JSON.stringify(timed)}`).toMatchObject({ outcome: "ACCEPTED" });

        const badSha = await landAndPublish(lane, wrapperPids);
        const good = await deploy(lane, goodSha);
        expect(good.url, "the receipt names where this environment answers").toBe(endpoint.url);
        const bad = await deploy(lane, badSha);
        expect(bad.receiptId).not.toBe(good.receiptId);

        await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded" });
        await pair(page, lane);
        const incidentId = await waitForIncident(lane);
        const card = await openIncidentCard(page, incidentId);
        await expect(page.getByTestId(card)).toHaveAttribute("data-state", "DOWN");
        await expect(page.getByTestId(`${card}.state`)).toContainText(`incident ${String(incidentId)}`);
        // NO ERROR LINE, AND THAT IS THE TRUTH HERE rather than a gap: `errorLineOf` reads the
        // last REFUSED deploy receipt, and both deploys succeeded. The environment is down
        // because it stopped ANSWERING, which is precisely the case a deploy receipt cannot
        // explain - so the card says so instead of inventing a line.
        await expect(page.getByTestId(`${card}.noerror`)).toBeVisible();
        // ONE CARD FOR ONE OUTAGE, counted across the WHOLE queue: a duplicate raise mints a
        // SECOND incident id and a second testid, invisible to a lookup keyed on the first.
        await expect(page.locator("[data-kind='INCIDENT']"),
          "three failures raise one incident, not one per probe").toHaveCount(1);

        // THE HEALTH SCREEN AGREES, from its own read: `data-status` is the frame's state copied
        // across, so this is the daemon's verdict rendered twice, not a second opinion.
        await page.getByTestId("cr.nav.health").click();
        await expect(page.getByTestId(`cr.environments.card.${ENVIRONMENT}`))
          .toHaveAttribute("data-status", "DOWN", { timeout: CARD_MS });

        // ARM, THEN CONFIRM. The first press only opens the confirmation, and the confirmation
        // names the sha the daemon resolved from the receipt it would spend - the good one.
        await openIncidentCard(page, incidentId);
        await expect(page.getByTestId(`${card}.confirm`)).toHaveCount(0);
        await page.getByTestId(`${card}.rollback`).click();
        await expect(page.getByTestId(`${card}.confirm`))
          .toHaveText(`Roll back ${ENVIRONMENT} to ${goodSha}`);
        await page.getByTestId(`${card}.rollback`).click();
        // THE WALL, BY CODE AND BY LAYER, in the browser's own words.
        await expect(page.getByTestId(`cr.needsyou.result.${ENVIRONMENT}#${String(incidentId)}`))
          .toContainText("OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION", { timeout: CARD_MS });
        expect(receiptOf(lane)?.receiptId, "the paired browser's confirm committed nothing")
          .toBe(bad.receiptId);
        // THE SAME REQUEST FROM A MINTED HUMAN SEAT that is not the configured operator is refused
        // identically, which is what proves the refusal is about the PRINCIPAL and not the browser.
        const minted = await laneCommand(lane, "deployment.rollback", lane.projectId,
          { environment: ENVIRONMENT, restoreDatabase: false, toReceiptRef: good.receiptId },
          mintLaneOperatorSeat(lane));
        expect(JSON.stringify(minted)).toContain("OPERATOR_PRINCIPAL_REQUIRED");
        expect(JSON.stringify(minted)).toContain("DAEMON_AUTHORIZATION");

        // THE ROLLBACK THAT RUNS, by the configured operator. No database restore is requested:
        // `rollback-port.ts` sends false and only false, and this mirrors it.
        const rolled = await laneCommand(lane, "deployment.rollback", lane.projectId,
          { environment: ENVIRONMENT, restoreDatabase: false, toReceiptRef: good.receiptId });
        expect(rolled, `ROLLBACK: ${JSON.stringify(rolled)}`).toMatchObject({ outcome: "ACCEPTED" });
        const after = receiptOf(lane);
        expect(after, "the rollback appends a receipt of its own").not.toBeNull();
        expect(after?.receiptId).not.toBe(good.receiptId);
        expect(after?.sha, "which redeploys the PREVIOUS sha").toBe(goodSha);
        expect(after?.imageDigest, "from the PREVIOUS image, never a rebuild").toBe(good.imageDigest);

        // RECOVERY, OBSERVED BY THE PROBE LOOP AND READ BACK IN THE BROWSER. The card leaves
        // Needs-you because the daemon CLOSED the incident, not because anything dismissed it.
        await page.getByTestId("cr.nav.health").click();
        await expect(page.getByTestId(`cr.environments.card.${ENVIRONMENT}`))
          .toHaveAttribute("data-status", "UP", { timeout: CARD_MS });
        await page.getByTestId("cr.nav.approvals").click();
        await expect(page.getByTestId("cr.needsyou.root")).toBeVisible({ timeout: CARD_MS });
        await expect(page.getByTestId(card)).toHaveCount(0, { timeout: CARD_MS });
        const recovered = await readLaneHealth(lane, ENVIRONMENT);
        expect(recovered, JSON.stringify(recovered)).toMatchObject({ incident: null, state: "UP" });
        // THE ENDPOINT REALLY ANSWERED, both ways. Without this, a lane whose probes never left
        // the daemon would still satisfy every assertion above by staying DEGRADED-then-DOWN.
        expect(endpoint.statuses).toContain(503);
        expect(endpoint.statuses).toContain(200);
      });
      expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
    } finally { await stopEverything(started, endpoint); }
  });

/**
 * THE FAILURE PATH TEARS DOWN TOO. A journey with a landing, two deploys and a five-minute outage
 * in it fails sometimes, and epic rail 4 binds the failing exit as hard as the passing one. The
 * body throws a sentinel matched BY IDENTITY, so a lane that swallowed it and answered a refusal
 * instead would fail here rather than read as a pass.
 */
test("real daemon: the incident lane tears down when its body throws", async () => {
  let started: DaemonLane | undefined;
  let endpoint: LaneEnvironmentEndpoint | undefined;
  wrapperPids.length = 0;
  const failure = new Error("E2E_BODY_SENTINEL");
  try {
    endpoint = await startEnvironmentEndpoint(() => true);
    await expect(withDaemonBackedControlRoom({
      fakeDocker: "SUCCESS", liveCredentials: "ATTACHED", seed: "NONE",
    }, async (lane) => { started = lane; throw failure; })).rejects.toBe(failure);
  } finally { await stopEverything(started, endpoint); }
});
