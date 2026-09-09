/**
 * THE DEPLOY JOURNEY: a bound target, a deploy, and the url read back — driven in the browser
 * against a REAL daemon.
 *
 * WHAT IS REAL: the daemon process, the command edge, admission, the bootstrap prerequisite
 * table, the decision ledger, the durable deploy receipt, the offer surface, `/activity/read`,
 * `/runs/read`, and the shipped v2 control room served from `lane.baseUrl`. The publish this
 * deploy depends on is driven all the way through — a REAL git workspace, a REAL landing by
 * `node-lander.ts`, and a REAL `repository.publish` decision.
 *
 * WHAT IS A DOUBLE: only the deploy's SPAWNS (`docker`, `ssh`, the transfer), injected through
 * the production composition seam by `fake-docker-dependencies.ts`; and the wrapper's SEAT.
 *
 * WHAT THIS PROVES: the daemon composed the injected seam, dispatched to it, wrote a durable
 * receipt, and the shipped browser renders that receipt's url. WHAT IT DOES NOT PROVE: that a
 * container ran, that an image was built, or that the url served real bytes. The double is a
 * double, and DoD 6's live drive — real docker — is the clause that covers the other half.
 *
 * TWO THINGS THIS LANE CANNOT DO, BOTH MEASURED RATHER THAN WORKED AROUND.
 *
 * 1. THE CARD'S DEPLOY BUTTON IS DISABLED HERE, and that is a product fact, not a spec bug.
 * `goal-deployment-read.ts:34` reports a deployable sha ONLY once the publish PUSHED
 * (`publication?.outcome === "PUSHED" ? publication.sha : null`), and this lane's publish has
 * no reachable remote, so the card renders "Nothing is landed to deploy yet" and every button
 * comes back `[disabled]` — measured at 11:54Z. The seam that WOULD make a push succeed
 * (`fakeGh`) is mutually exclusive with `fakeDocker`: `daemon-ports.ts:470-473` injects ONE
 * dependencies module, so no lane can fake a remote and a docker at the same time. This spec
 * therefore ASSERTS the disabled state and its words instead of clicking a button that cannot
 * be clicked, and drives the deploy as the operator. Faking a push, or relaxing the card so the
 * button enables without one, would both trade a real gate for a green.
 *
 * 2. THE BROWSER MAY NOT DISPATCH THIS COMMAND AT ALL, and that is epic rail 4 holding.
 * `deployment.deploy` fences at handler entry on `principal.principalId !== operatorPrincipalId`
 * (deploy-command.ts:183-187) and `deployment.set_target` sits in `OPERATOR_PRINCIPAL_KINDS`
 * with NO widening at daemon-command-registry.ts:353-355 — the widened kinds are the approval
 * intent, the criterion kinds, `repository.publish` and the contract clarification. A paired
 * browser is a durable HUMAN principal and still not the CONFIGURED operator. Asserted at the
 * command edge with a MINTED operator seat, which is exactly that shape: a real durable human
 * that is not the operator. The refusal is asserted by its stable CODE and its LAYER.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SqliteEventStore } from "@moe/store";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { readCurrentDeployReceipt } from "../../../apps/daemon/src/deployment/deploy-ledger.js";
import { deployTargetAggregateId } from "../../../apps/daemon/src/deployment/deploy-target-contracts.js";
import { publicationRepositoryId } from "../../../apps/daemon/src/repository/publication-approval-contracts.js";
import { publishAggregateId } from "../../../apps/daemon/src/repository/publish-receipt-contracts.js";
import { resolveRepositoryExecutionIdentity } from "../../../apps/daemon/src/repository/repository-execution-identity.js";
import { lanePids, mintLaneOperatorSeat, readWireProtocolVersion, survivingPids,
  withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane, LaneOperatorSeat } from "./daemon-ports.js";
import { LANDING_BUDGET_MS, landLaneNode } from "./lane-landing.js";
import { lanePost } from "./lane-preview.js";
import { seededGoalId } from "./lane-preview-arms.js";

/** Admitted by `admitRemoteUrl`; the lane never reaches a network with it. */
const REMOTE_URL = "https://github.com/moe-lane/deploy-environment.git";
const ENVIRONMENT = "preview";
const TARGET = { environment: ENVIRONMENT, network: "lane-network", sshTarget: null, url: "https://lane.test" };
const RECEIPT_KIND = "internal.deployment.deploy_receipt";

/** Strictly longer than `LANDING_BUDGET_MS`; see deploy-fake-docker.spec.ts for why. */
const LANE_TIMEOUT_MS = LANDING_BUDGET_MS + 420_000;
const CARD_MS = 30_000;

/** Every pid this spec is answerable for: the lane's own, plus any wrapper it started. */
const wrapperPids: number[] = [];

async function command(lane: DaemonLane, kind: string, aggregateId: string, payload: object,
  seat?: LaneOperatorSeat): Promise<unknown> {
  const store = SqliteEventStore.openForProject(join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  let expectedVersion: number;
  try { expectedVersion = store.getAggregateVersion(aggregateId); } finally { store.close(); }
  const response = await fetch(`${lane.daemonOrigin}/command`, { method: "POST",
    headers: { "content-type": "application/json", origin: lane.daemonOrigin, "x-moe-csrf": lane.csrfToken,
      "x-moe-session-credential": seat?.credential ?? lane.credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "" },
    body: JSON.stringify({ commandId: `lane-${kind}`, commandKind: kind,
      correlationId: "lane-deploy-journey", expectedVersion, payload, requestDigest: "d".repeat(64),
      schemaVersion: "moe-runtime-command/1", sessionCredential: seat?.credential ?? lane.credential,
      targetAggregateId: aggregateId }),
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
  const identity = resolveRepositoryExecutionIdentity(lane.workspace);
  expect(identity.ok, JSON.stringify(identity)).toBe(true);
  if (!identity.ok) throw new Error("unreachable: the assertion above fails first");
  const approval = { branch: "main", remoteUrl: REMOTE_URL,
    repositoryId: publicationRepositoryId(identity.identity), sha: landed.sha };
  const answer = await command(lane, "repository.publish", publishAggregateId(goalId),
    { approval, goalId, remoteUrl: REMOTE_URL }, mintLaneOperatorSeat(lane));
  expect(answer, `PUBLISH: ${JSON.stringify(answer)}`).toMatchObject({ outcome: "ACCEPTED" });
  return landed.sha;
}

/** HAND-MIRRORED from repository-workflows.spec.ts: the pairing dialog is the daemon's. */
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

async function openGoal(page: Page, goalId: string): Promise<void> {
  await page.getByTestId("cr.nav.goals").click();
  await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: CARD_MS });
  await page.getByTestId(`cr.goals.card.${goalId}.open`).click();
}

function receiptOf(lane: DaemonLane): ReturnType<typeof readCurrentDeployReceipt> {
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

async function assertStopped(lane: DaemonLane | undefined): Promise<void> {
  expect(lane, "the real daemon and server must have started").toBeDefined();
  if (lane === undefined) return;
  expect(await survivingPids([...lanePids(lane), ...wrapperPids])).toEqual([]);
  expect(await portClosed(lane.daemonOrigin)).toBe(true);
  expect(await portClosed(lane.baseUrl)).toBe(true);
  expect(existsSync(dirname(lane.catalogPath))).toBe(false);
}

test("deploy journey: a bound target, an operator deploy, and the url the browser reads back",
  async ({ page }) => {
    test.setTimeout(LANE_TIMEOUT_MS);
    let started: DaemonLane | undefined;
    wrapperPids.length = 0;
    try {
      const result = await withDaemonBackedControlRoom({
        fakeDocker: "SUCCESS", liveCredentials: "ATTACHED", operatorChannel: true,
      }, async (lane) => {
        started = lane;
        const goalId = await seededGoalId(lane);
        // THE TARGET FIRST. Without a binding `affordance-read.ts:409` withholds the deploy
        // offer entirely and the card renders no button to click, so the refusal arm below
        // would pass vacuously against a surface that never offered anything.
        const bound = await command(lane, "deployment.set_target",
          deployTargetAggregateId(lane.projectId, ENVIRONMENT), TARGET);
        expect(bound, `SET_TARGET: ${JSON.stringify(bound)}`).toMatchObject({ outcome: "ACCEPTED" });
        const sha = await landAndPublish(lane, goalId);

        await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded" });
        await pair(page, lane);

        // NEEDS-YOU LISTS THE GOAL — DoD 4's appearance half, through the shipped surface.
        await page.getByTestId("cr.nav.approvals").click();
        await expect(page.getByTestId("cr.needsyou.root")).toBeVisible({ timeout: CARD_MS });
        await expect(page.locator("[data-kind='DEPLOY']")).toHaveCount(1, { timeout: CARD_MS });

        await openGoal(page, goalId);
        await expect(page.getByTestId("cr.deploy.root")).toBeVisible({ timeout: CARD_MS });
        await expect(page.getByTestId(`cr.deploy.${ENVIRONMENT}.target`))
          .toContainText(TARGET.network, { timeout: CARD_MS });

        // THE BUTTON IS PRESENT AND DISABLED, with the reason in words beside it. Both halves
        // are asserted: a card that hid the row entirely would leave the operator with no way
        // to learn that a publish is what they are waiting on, and a card that enabled the
        // button would dispatch a deploy the daemon has no sha for.
        await expect(page.getByTestId("cr.deploy.unlanded"))
          .toHaveText("Nothing is landed to deploy yet.", { timeout: CARD_MS });
        await expect(page.getByTestId(`cr.deploy.${ENVIRONMENT}.button`)).toBeDisabled();
        await expect(page.getByTestId(`cr.deploy.${ENVIRONMENT}.state`)).toHaveText("Never deployed.");

        // THE HUMAN GATE, at the command edge. A MINTED operator seat is a durable HUMAN
        // principal and still not the CONFIGURED operator — the same class the paired browser
        // is in — so this is the refusal a browser dispatch would receive.
        const asHuman = await command(lane, "deployment.deploy", `deploy:${goalId}`,
          { environment: ENVIRONMENT, sha }, mintLaneOperatorSeat(lane));
        expect(JSON.stringify(asHuman), "refused by CODE").toContain("OPERATOR_PRINCIPAL_REQUIRED");
        expect(JSON.stringify(asHuman), "and by LAYER").toContain("DAEMON_AUTHORIZATION");
        // IT COMMITTED NOTHING. Asserted BEFORE the operator's own deploy, because afterwards a
        // receipt exists either way and this arm could never fail.
        expect(receiptOf(lane), "a fenced dispatch writes no receipt").toBeNull();

        // NOW AS THE OPERATOR, which is who this command is reserved for.
        const deployed = await command(lane, "deployment.deploy", `deploy:${goalId}`,
          { environment: ENVIRONMENT, sha });
        expect(deployed, `DEPLOY: ${JSON.stringify(deployed)}`).toMatchObject({ outcome: "ACCEPTED" });
        const receipt = receiptOf(lane);
        expect(receipt, JSON.stringify(receipt)).toMatchObject({ outcome: "DEPLOYED", sha });
        const url = receipt?.url ?? null;
        expect(url, "a DEPLOYED receipt names where the environment answers").not.toBeNull();

        // RUNS: the receipt reaches `/activity/read` WITH ITS VERDICT, which is what makes a
        // REFUSED deploy read differently from this one. Asserted at the read boundary rather
        // than by scraping the feed, so the assertion names the fact the browser renders from.
        // PROJECT-WIDE, not `{ goalRef }`. The receipt is committed on the ENVIRONMENT's own
        // aggregate (`deploy:<projectId>:<environment>`), not the goal's, so a goal-scoped read
        // would not carry it even where the goal is known — and in this lane it is not: the
        // scoped read answers ACTIVITY_READ_GOAL_UNKNOWN, because the seeded goal has no
        // source-document binding. Measured at 11:57Z.
        const activity = await lanePost(lane, "/activity/read", {});
        const entries = (activity.body["entries"] ?? []) as { commandKind?: string; verdict?: string }[];
        const receipts = entries.filter((entry) => entry.commandKind === RECEIPT_KIND);
        expect(receipts.length, `no deploy receipt in ${JSON.stringify(activity.body)}`)
          .toBeGreaterThan(0);
        expect(receipts.map((entry) => entry.verdict)).toContain("DEPLOYED");

        // NEEDS-YOU STOPS LISTING IT — DoD 4's disappearance half, same surface, same session.
        // Navigating away and back is deliberate rather than a reload: the deploy was
        // dispatched out of band, so the card still holds a frame from before it, and a reload
        // drops the paired session this page is holding.
        await page.getByTestId("cr.nav.approvals").click();
        await expect(page.getByTestId("cr.needsyou.root")).toBeVisible({ timeout: CARD_MS });
        await expect(page.locator("[data-kind='DEPLOY']")).toHaveCount(0, { timeout: CARD_MS });

        // THE URL, READ BACK IN THE SHIPPED BROWSER, from the daemon's own receipt.
        await openGoal(page, goalId);
        await expect(page.getByTestId(`cr.deploy.${ENVIRONMENT}.url`))
          .toHaveText(url ?? "", { timeout: CARD_MS });
        await expect(page.getByTestId(`cr.deploy.${ENVIRONMENT}.state`),
          "the row stops saying it was never deployed").not.toHaveText("Never deployed.");
      });
      expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
    } finally { await assertStopped(started); }
  });

test("deploy journey: teardown also runs when the body throws", async () => {
  let started: DaemonLane | undefined;
  wrapperPids.length = 0;
  const failure = new Error("E2E_BODY_SENTINEL");
  try {
    await expect(withDaemonBackedControlRoom({ liveCredentials: "ATTACHED", seed: "NONE",
      fakeDocker: "SUCCESS" }, async (lane) => {
      started = lane; throw failure;
    })).rejects.toBe(failure);
  } finally { await assertStopped(started); }
});
