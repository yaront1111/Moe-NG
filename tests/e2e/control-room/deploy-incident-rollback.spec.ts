/**
 * THE INCIDENT JOURNEY, END TO END, AGAINST A REAL DAEMON: an environment goes DOWN, the
 * Needs-you queue raises ONE incident card, the operator rolls back, and the probe loop closes
 * the incident on its own.
 *
 * WHAT IS REAL. The daemon process and its durable schedule; the health-probe job the
 * composition root arms (`daemon-store-foundation-composition.ts`), reading the deploy receipt
 * and fetching the environment's `/health` over a real socket; the bounded ring and the incident
 * table; `/deployments/health/read`; the `deployment.rollback` offer on `/affordances/read`; the
 * command edge with every fence on it; the durable deploy and rollback receipts; and the shipped
 * v2 control room served from `lane.baseUrl`, paired through the daemon's own operator channel.
 * The deploy's prerequisite is driven honestly - a REAL git workspace, a REAL landing by
 * `node-lander.ts`, and a REAL `repository.publish` decision.
 *
 * WHAT IS A DOUBLE, and only these two. (1) The deploy's SPAWNS - `docker`, `ssh`, the transfer -
 * injected through the production composition seam by `fake-docker-dependencies.ts`, and the
 * wrapper's SEAT, for the reason `wrapper-lane.ts` gives. (2) THE DEPLOYED PRODUCT ITSELF: a
 * `node:http` server this spec owns, serving `DEPLOYMENT_HEALTH_PATH`, whose status this spec
 * flips. That is the ONLY way an outage is expressible in a lane that never runs a container -
 * and it is the honest place to put the double, because everything downstream of the socket is
 * the shipped code. The daemon is never told the product is unhealthy; it FINDS OUT by probing.
 *
 * WHAT THIS PROVES: a real probe loop turns real HTTP failures into DOWN, opens exactly one
 * incident, surfaces it on the shipped incident card with the daemon's own rollback target,
 * spends a real `deployment.rollback` that redeploys the PREVIOUS receipt's image, and closes the
 * incident off a real recovering probe. WHAT IT DOES NOT PROVE: that a container ran, that an
 * image was built, or that the rollback moved bytes on a host. The double is a double, and DoD 5's
 * live drive - real docker, ten real minutes - is the clause that covers the other half.
 *
 * THE HUMAN GATE IS ASSERTED, NOT WORKED AROUND. `rollback-command.ts:80` fences on
 * `principal.principalId !== operatorPrincipalId`, and a PAIRED BROWSER is a durable HUMAN
 * principal that is NOT the configured operator (`live-handshake.ts:228` settles the session on
 * the credential the pairing minted, not the attached one). The affordance is nonetheless minted
 * for every reader by design (`affordance-read.ts:471`), so the card DOES render the control and
 * clicking it is answered by the daemon's own refusal - which this spec asserts by CODE and by
 * LAYER on the card, and then the operator spends the same offer from the operator's own session.
 * That is the same shape `deploy-environment.spec.ts` records for `deployment.deploy`.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SqliteEventStore } from "@moe/store";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { readCurrentDeployReceipt, readDeployLedger }
  from "../../../apps/daemon/src/deployment/deploy-ledger.js";
import { deployTargetAggregateId }
  from "../../../apps/daemon/src/deployment/deploy-target-contracts.js";
import { resolveRollbackTarget } from "../../../apps/daemon/src/deployment/rollback-target.js";
import type { RollbackTarget } from "../../../apps/daemon/src/deployment/rollback-target.js";
import { HEALTH_FAILURE_THRESHOLD }
  from "../../../apps/daemon/src/monitoring/health-probe-contracts.js";
import { MIN_PROBE_INTERVAL_MS }
  from "../../../apps/daemon/src/monitoring/probe-interval-record.js";
import { DEPLOYMENT_HEALTH_PATH }
  from "../../../apps/daemon/src/repository/deployment/deployment-infrastructure-templates.js";
import { publicationRepositoryId }
  from "../../../apps/daemon/src/repository/publication-approval-contracts.js";
import { publishAggregateId }
  from "../../../apps/daemon/src/repository/publish-receipt-contracts.js";
import { resolveRepositoryExecutionIdentity }
  from "../../../apps/daemon/src/repository/repository-execution-identity.js";
import { lanePids, mintLaneOperatorSeat, readWireProtocolVersion, survivingPids,
  withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane, LaneOperatorSeat } from "./daemon-ports.js";
import { LANDING_BUDGET_MS, landLaneNode } from "./lane-landing.js";
import { lanePost } from "./lane-preview.js";
import { seededGoalId } from "./lane-preview-arms.js";

/** Admitted by `admitRemoteUrl`; the lane never reaches a network with it. */
const REMOTE_URL = "https://github.com/moe-lane/deploy-incident-rollback.git";
/**
 * ONE OF `ENVIRONMENT_NAMES`, AND THAT IS LOAD-BEARING RATHER THAN A PREFERENCE. The daemon
 * PROBES every environment the deploy ledger holds a receipt for, whatever it is named - measured
 * 2026-09-08, a `staging` deploy went DOWN and opened incident 1 exactly as this spec expects.
 * But the BROWSER enumerates the environments it asks health for from `/deployments/read`, whose
 * rows are `ENVIRONMENT_NAMES.map(...)` (goal-deployment-read.ts:57) - a fixed roster of
 * preview/production/verify. So an outage on an unrostered environment is real, durable and
 * invisible in the queue, and a lane naming one asserts an empty Needs-you for two minutes.
 */
const ENVIRONMENT = "preview";
/** Strictly longer than `LANDING_BUDGET_MS`; see deploy-fake-docker.spec.ts for why. */
const LANE_TIMEOUT_MS = LANDING_BUDGET_MS + 900_000;
const CARD_MS = 120_000;
/**
 * THE PROBE WINDOW, and every term in it is measured rather than padded. The dedicated
 * per-environment arm is registered by `reconcileProbeSchedules`, which runs on the SWEEP's tick
 * - `DEFAULT_PROBE_INTERVAL_MS`, 60 s - so a freshly written interval costs up to one sweep
 * before the fast arm exists. Then the threshold needs `HEALTH_FAILURE_THRESHOLD` consecutive
 * probes at `MIN_PROBE_INTERVAL_MS`. The rest is margin for a loaded host.
 */
const PROBE_WINDOW_MS = 60_000 + HEALTH_FAILURE_THRESHOLD * MIN_PROBE_INTERVAL_MS + 120_000;

/** Every pid this spec is answerable for: the lane's own, plus any wrapper it started. */
const wrapperPids: number[] = [];

/**
 * THE DEPLOYED PRODUCT, DOUBLED AT ITS SOCKET AND NOWHERE ELSE.
 *
 * It counts the daemon's own hits so "the probe reached the product" is OBSERVED rather than
 * inferred from a state the daemon derived, and it owns its teardown on every exit path -
 * `closeAllConnections` first, because a keep-alive socket the daemon's `fetch` is holding would
 * otherwise leave `close()` pending forever and leak a port past the run (epic rail 4).
 */
interface FakeProduct {
  readonly origin: string;
  close(): Promise<void>;
  hits(): number;
  serve(status: number): void;
}

async function startFakeProduct(initialStatus: number): Promise<FakeProduct> {
  let status = initialStatus;
  let hits = 0;
  const server = createServer((request, response) => {
    if (request.url !== DEPLOYMENT_HEALTH_PATH) { response.writeHead(404).end(); return; }
    hits += 1;
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(status >= 200 && status < 300 ? "ok" : "unhealthy");
  });
  await new Promise<void>((ready) => { server.listen(0, "127.0.0.1", ready); });
  const port = (server.address() as AddressInfo).port;
  return Object.freeze({
    close: (): Promise<void> => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => { done(); });
    }),
    hits: (): number => hits,
    origin: `http://127.0.0.1:${String(port)}`,
    serve: (next: number): void => { status = next; },
  });
}

/**
 * One command envelope. `commandId` is a REQUIRED discriminator here, not a convenience: this
 * lane dispatches `deployment.deploy` twice, and a reused id is answered by the store's own
 * replay of the FIRST decision - which would leave one receipt in the ledger and no rollback
 * target at all.
 */
async function command(lane: DaemonLane, kind: string, aggregateId: string, commandId: string,
  payload: object, seat?: LaneOperatorSeat): Promise<unknown> {
  const store = SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  let expectedVersion: number;
  try { expectedVersion = store.getAggregateVersion(aggregateId); } finally { store.close(); }
  const response = await fetch(`${lane.daemonOrigin}/command`, { method: "POST",
    headers: { "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken,
      "x-moe-session-credential": seat?.credential ?? lane.credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "" },
    body: JSON.stringify({ commandId, commandKind: kind, correlationId: "lane-incident",
      expectedVersion, payload, requestDigest: "d".repeat(64),
      schemaVersion: "moe-runtime-command/1",
      sessionCredential: seat?.credential ?? lane.credential, targetAggregateId: aggregateId }),
  });
  return response.json();
}

/** The deploy's prerequisite, driven honestly; answers with the sha the repository holds. */
async function landAndPublish(lane: DaemonLane, goalId: string): Promise<string> {
  const landed = await landLaneNode(lane);
  if (landed.wrapperPid !== null) wrapperPids.push(landed.wrapperPid);
  expect(landed.ok ? "ok" : `LANDING: ${landed.detail}`).toBe("ok");
  if (!landed.ok) throw new Error("unreachable: the assertion above fails first");
  expect(landed.sha, "the lander commits a real sha git resolves").toMatch(/^[0-9a-f]{40}$/u);
  expect(landed.sha, "and it is not the baseline this lane also deploys")
    .not.toBe(lane.workspaceSha);
  const identity = resolveRepositoryExecutionIdentity(lane.workspace);
  expect(identity.ok, JSON.stringify(identity)).toBe(true);
  if (!identity.ok) throw new Error("unreachable: the assertion above fails first");
  const approval = { branch: "main", remoteUrl: REMOTE_URL,
    repositoryId: publicationRepositoryId(identity.identity), sha: landed.sha };
  const answer = await command(lane, "repository.publish", publishAggregateId(goalId),
    "lane-publish", { approval, goalId, remoteUrl: REMOTE_URL }, mintLaneOperatorSeat(lane));
  expect(answer, `PUBLISH: ${JSON.stringify(answer)}`).toMatchObject({ outcome: "ACCEPTED" });
  return landed.sha;
}

/** HAND-MIRRORED from deploy-environment.spec.ts: the pairing dialog is the daemon's, not ours. */
async function pair(page: Page, lane: DaemonLane): Promise<void> {
  const label = page.getByLabel("Pairing confirmation label");
  await expect(label).toBeVisible({ timeout: CARD_MS });
  const value = (await label.textContent())?.trim() ?? "";
  expect(value).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u);
  expect(lane.approvePairing).not.toBeNull(); lane.approvePairing?.(value);
  const deadline = Date.now() + CARD_MS;
  while (Date.now() < deadline && await label.count() !== 0) {
    await page.getByRole("button", { name: "I entered this label" }).click({ timeout: 2000 })
      .catch(() => undefined);
    await page.waitForTimeout(250);
  }
  await expect(label).toHaveCount(0);
}

/** The PRODUCTION read the browser renders from, asked over the same wire the browser uses. */
async function healthOf(lane: DaemonLane): Promise<Record<string, unknown>> {
  const answer = await lanePost(lane, "/deployments/health/read", { environment: ENVIRONMENT });
  expect(answer.status, `HEALTH READ: ${JSON.stringify(answer.body)}`).toBe(200);
  return answer.body;
}

/** Waits on the DAEMON's own verdict. A lapsed budget fails with the last frame it saw. */
async function waitForHealth(lane: DaemonLane, holds: (body: Record<string, unknown>) => boolean,
  what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + PROBE_WINDOW_MS;
  let last: Record<string, unknown> = {};
  for (;;) {
    last = await healthOf(lane);
    if (holds(last)) return last;
    if (Date.now() >= deadline) break;
    await new Promise<void>((tick) => { setTimeout(tick, 2_000); });
  }
  expect(`${what} — last frame ${JSON.stringify(last)}`).toBe(what);
  throw new Error("unreachable: the assertion above fails first");
}

function ledgerTarget(lane: DaemonLane): RollbackTarget | null {
  const store = SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  try {
    return resolveRollbackTarget(readDeployLedger(store, lane.projectId).get(ENVIRONMENT) ?? null);
  } finally { store.close(); }
}

function currentReceipt(lane: DaemonLane): ReturnType<typeof readCurrentDeployReceipt> {
  const store = SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  try { return readCurrentDeployReceipt(store, lane.projectId, ENVIRONMENT); } finally { store.close(); }
}

function portClosed(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(origin);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const done = (closed: boolean): void => { socket.destroy(); resolve(closed); };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(false)); socket.once("error", () => done(true));
  });
}

async function assertStopped(lane: DaemonLane | undefined, product: FakeProduct): Promise<void> {
  await product.close();
  expect(await portClosed(product.origin), "the doubled product releases its port").toBe(true);
  expect(lane, "the real daemon and server must have started").toBeDefined();
  if (lane === undefined) return;
  expect(await survivingPids([...lanePids(lane), ...wrapperPids])).toEqual([]);
  expect(await portClosed(lane.daemonOrigin)).toBe(true);
  expect(await portClosed(lane.baseUrl)).toBe(true);
  expect(existsSync(dirname(lane.catalogPath))).toBe(false);
}

test("incident journey: a real probe finds the outage, the card offers the rollback, and the "
  + "operator's rollback closes the incident", async ({ page }) => {
  test.setTimeout(LANE_TIMEOUT_MS);
  let started: DaemonLane | undefined;
  wrapperPids.length = 0;
  const product = await startFakeProduct(200);
  try {
    const result = await withDaemonBackedControlRoom({
      fakeDocker: "SUCCESS", liveCredentials: "ATTACHED", operatorChannel: true,
    }, async (lane) => {
      started = lane;
      const goalId = await seededGoalId(lane);
      // THE TARGET NAMES THE DOUBLED PRODUCT. Without a binding `affordance-read.ts:409`
      // withholds the deploy offer and the probe has no url to reach at all.
      const bound = await command(lane, "deployment.set_target",
        deployTargetAggregateId(lane.projectId, ENVIRONMENT), "lane-set-target",
        { environment: ENVIRONMENT, network: "lane-network", sshTarget: null, url: product.origin });
      expect(bound, `SET_TARGET: ${JSON.stringify(bound)}`).toMatchObject({ outcome: "ACCEPTED" });
      // THE PROBE RATE, AT THE RECORD'S OWN FLOOR - imported, never a literal, so a bound that
      // moves moves this lane with it. Written BEFORE the landing so the sweep tick that
      // reconciles it is spent while the wrapper is still committing.
      const timed = await command(lane, "monitoring.set_probe_interval", lane.projectId,
        "lane-probe-interval", { environment: ENVIRONMENT, intervalMs: MIN_PROBE_INTERVAL_MS });
      expect(timed, `PROBE INTERVAL: ${JSON.stringify(timed)}`).toMatchObject({ outcome: "ACCEPTED" });

      const landedSha = await landAndPublish(lane, goalId);

      // DEPLOY ONE: the image the rollback will go BACK to. Its sha is the workspace baseline,
      // a commit git already holds, so the shipped builder's `rev-parse --verify` still runs.
      const good = await command(lane, "deployment.deploy", `deploy:${goalId}`, "lane-deploy-good",
        { environment: ENVIRONMENT, sha: lane.workspaceSha });
      expect(good, `DEPLOY ONE: ${JSON.stringify(good)}`).toMatchObject({ outcome: "ACCEPTED" });
      const up = await waitForHealth(lane, (body) => body["state"] === "UP",
        "the daemon's own probe reaches the product and reports UP");
      expect(up["incident"], "a healthy environment has no incident").toBeNull();
      expect(product.hits(), "the probe reached the socket, not a derived state")
        .toBeGreaterThan(0);

      // DEPLOY TWO: the image that will go bad. The DEPLOY succeeds - docker is doubled and
      // reports HEALTHY - and the PRODUCT is what fails, which is the whole point: this feature
      // exists for the deploy that lands green and then falls over.
      const bad = await command(lane, "deployment.deploy", `deploy:${goalId}`, "lane-deploy-bad",
        { environment: ENVIRONMENT, sha: landedSha });
      expect(bad, `DEPLOY TWO: ${JSON.stringify(bad)}`).toMatchObject({ outcome: "ACCEPTED" });
      const target = ledgerTarget(lane);
      expect(target, "two ran receipts leave one behind the running image").not.toBeNull();
      expect(target?.sha, "and it is the sha deploy one ran").toBe(lane.workspaceSha);

      // THE OUTAGE. Nothing is seeded into the ring: the product starts refusing and the
      // daemon's own loop discovers it.
      product.serve(503);
      const down = await waitForHealth(lane,
        (body) => body["state"] === "DOWN" && body["incident"] !== null,
        `${String(HEALTH_FAILURE_THRESHOLD)} consecutive real failures read DOWN with one incident`);
      const incident = down["incident"] as { readonly id: number; readonly openedAt: string };
      expect((down["rollbackTarget"] as RollbackTarget | null)?.toReceiptRef,
        "the read offers the SAME receipt the ledger resolver does").toBe(target?.toReceiptRef);

      await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded" });
      await pair(page, lane);
      await page.getByTestId("cr.nav.approvals").click();
      await expect(page.getByTestId("cr.needsyou.root")).toBeVisible({ timeout: CARD_MS });
      const key = `${ENVIRONMENT}#${String(incident.id)}`;
      const card = page.getByTestId(`cr.needsyou.incident.${key}`);
      await expect(card, "the shipped incident card, keyed by the daemon's own incident id")
        .toBeVisible({ timeout: CARD_MS });
      await expect(card).toHaveAttribute("data-state", "DOWN");
      await expect(page.getByTestId(`cr.needsyou.incident.${key}.state`))
        .toContainText(`open since ${incident.openedAt}`);
      // NO DEPLOY REFUSED HERE, so the daemon has no error line and the card SAYS SO rather than
      // inventing one. Asserting the branch pins which of the two the card took.
      await expect(page.getByTestId(`cr.needsyou.incident.${key}.noerror`)).toBeVisible();
      await expect(page.locator("[data-kind='INCIDENT']"), "exactly one card for one outage")
        .toHaveCount(1);

      // ARM, THEN CONFIRM. The first press only opens the confirm; asserting its ABSENCE first
      // is what makes the assertion after the press measure a surface that did not exist before.
      const rollbackButton = page.getByTestId(`cr.needsyou.incident.${key}.rollback`);
      await expect(page.getByTestId(`cr.needsyou.incident.${key}.confirm`)).toHaveCount(0);
      await rollbackButton.click();
      await expect(page.getByTestId(`cr.needsyou.incident.${key}.confirm`))
        .toHaveText(`Roll back ${ENVIRONMENT} to ${target?.sha ?? ""}`, { timeout: CARD_MS });
      await rollbackButton.click();

      // THE HUMAN GATE HOLDS AT THE DAEMON, and the card reports it by CODE and by LAYER. A
      // paired browser is a durable HUMAN principal and still not the CONFIGURED operator.
      const note = page.getByTestId(`cr.needsyou.result.${key}`);
      await expect(note).toBeVisible({ timeout: CARD_MS });
      await expect(note.locator("code"))
        .toHaveText("OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION");
      const untouched = await healthOf(lane);
      expect((untouched["incident"] as { readonly id: number } | null)?.id,
        "a fenced dispatch changes nothing the operator can see").toBe(incident.id);
      expect(currentReceipt(lane)?.sha, "and it redeploys nothing").toBe(landedSha);

      // NOW AS THE OPERATOR, spending the target the card was shown.
      const spent = await command(lane, "deployment.rollback", lane.projectId, "lane-rollback",
        { environment: ENVIRONMENT, restoreDatabase: false, toReceiptRef: target?.toReceiptRef ?? "" });
      expect(spent, `ROLLBACK: ${JSON.stringify(spent)}`).toMatchObject({ outcome: "ACCEPTED" });
      expect(currentReceipt(lane), "the tip receipt is the PREVIOUS image, redeployed")
        .toMatchObject({ imageDigest: target?.imageDigest, outcome: "DEPLOYED", sha: lane.workspaceSha });

      // RECOVERY. The rolled-back image is the one that answers, so the product answers again -
      // and the incident closes on the daemon's own next SUCCESS, with nothing dismissed.
      product.serve(200);
      const recovered = await waitForHealth(lane,
        (body) => body["state"] === "UP" && body["incident"] === null,
        "one recovering probe closes the incident and the environment reads UP");
      expect(recovered["rollbackTarget"], "a rolled-back environment still has somewhere to go")
        .not.toBeNull();

      await page.getByTestId("cr.nav.approvals").click();
      await expect(page.getByTestId("cr.needsyou.root")).toBeVisible({ timeout: CARD_MS });
      await expect(card, "the card leaves the queue because the daemon closed the incident")
        .toHaveCount(0, { timeout: CARD_MS });

      // THE HEALTH SCREEN'S ENVIRONMENTS SECTION, on the same recovered read.
      await page.getByTestId("cr.nav.health").click();
      await expect(page.getByTestId("cr.environments.root")).toBeVisible({ timeout: CARD_MS });
      await expect(page.getByTestId(`cr.environments.card.${ENVIRONMENT}`))
        .toHaveAttribute("data-status", "UP", { timeout: CARD_MS });
    });
    expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
  } finally { await assertStopped(started, product); }
});

test("incident journey: teardown also runs when the body throws", async () => {
  let started: DaemonLane | undefined;
  wrapperPids.length = 0;
  const product = await startFakeProduct(200);
  const failure = new Error("E2E_BODY_SENTINEL");
  try {
    await expect(withDaemonBackedControlRoom({ fakeDocker: "SUCCESS",
      liveCredentials: "ATTACHED", seed: "NONE" }, async (lane) => {
      started = lane; throw failure;
    })).rejects.toBe(failure);
  } finally { await assertStopped(started, product); }
});
