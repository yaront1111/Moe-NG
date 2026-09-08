import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SqliteEventStore } from "@moe/store";

import { publicationRepositoryId }
  from "../../../apps/daemon/src/repository/publication-approval-contracts.js";
import { publishAggregateId }
  from "../../../apps/daemon/src/repository/publish-receipt-contracts.js";
import { resolveRepositoryExecutionIdentity }
  from "../../../apps/daemon/src/repository/repository-execution-identity.js";
import { FAKE_PR_URL } from "./fake-gh-contract.js";
import { lanePids, mintLaneOperatorSeat, readWireProtocolVersion, survivingPids,
  withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane, DaemonLaneOptions, LaneOperatorSeat } from "./daemon-ports.js";
import { createLaneContractGoal } from "./lane-contract-goal.js";

/**
 * GATE 3 IN THE BROWSER, AGAINST A REAL DAEMON: evidence -> card -> approve -> PR link.
 *
 * WHAT IS REAL, and it is nearly all of it: the daemon process, the affordance surface that
 * mints `release.decide`, the `/release/read` evidence projection, the operator fence, the
 * publisher that pushes the goal's branch, the dossier the decision is taken over, the durable
 * release receipt, and the browser bundle that renders every one of those.
 *
 * WHAT IS A DOUBLE: exactly one subprocess -- the `gh pr create` spawn, injected through the
 * production `releasePrPort` seam by `fake-gh-dependencies.ts`. Spawning the real `gh` here
 * would open a pull request on a real repository every time this suite runs, which is a side
 * effect wearing a test's clothes. The REAL `gh` drive belongs to the live drive (DoD 6) and is
 * reported there, with its own PR url, rather than simulated here.
 *
 * WHAT THIS PROVES: the offer the daemon mints reaches the browser, the card renders the
 * evidence summary WITH the UNKNOWN count kept out of covered, the approve arm spends that
 * offer through `spendOffer`, the daemon asks for the pull request it says it asks for
 * (the recorded argv is the production `ghPrArgv`), and the receipt comes back through the
 * read path as a link the operator can click. WHAT IT DOES NOT PROVE: that github.com accepted
 * anything. The double is a double.
 */

/**
 * The goal this journey drives is BUILT, not seeded: `createLaneContractGoal` runs the real
 * wrapper on three delivery passes and then verifies every criterion against the landed tree.
 * `contract-goal.spec.ts:49` budgets 900s for that helper alone, and this journey adds the
 * publish, the browser handshake and the card on top, so the old 420s budget is a guaranteed
 * timeout rather than a bound on anything. Nothing is relaxed by widening it: every assertion
 * below is unchanged, and `playwright.config.ts:35`'s 180s default is overridden per-test.
 */
const JOURNEY_MS = 1_200_000;
const CARD_MS = 120_000;
const PAIRING_BUDGET_MS = 90_000;
const PAIRING_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
/** Admitted by `admitRemoteUrl`; the lane never reaches a network with it. */
const REMOTE_URL = "https://github.com/moe-lane/release-approval.git";

/** Every pid this spec is answerable for: the lane's own, plus any wrapper it started. */
const wrapperPids: number[] = [];

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

async function command(
  lane: DaemonLane, kind: string, aggregateId: string, payload: object, seat?: LaneOperatorSeat,
): Promise<unknown> {
  const store = SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  let expectedVersion: number;
  try { expectedVersion = store.getAggregateVersion(aggregateId); } finally { store.close(); }
  const response = await fetch(`${lane.daemonOrigin}/command`, { method: "POST",
    headers: { "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken,
      "x-moe-session-credential": seat?.credential ?? lane.credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "" },
    body: JSON.stringify({ commandId: `lane-${kind}`, commandKind: kind,
      correlationId: "lane-release", expectedVersion, payload, requestDigest: "d".repeat(64),
      schemaVersion: "moe-runtime-command/1", sessionCredential: seat?.credential ?? lane.credential,
      targetAggregateId: aggregateId }),
  });
  return response.json();
}

/** The `/release/read` answer over the REAL listener, on the lane credential. */
async function readRelease(lane: DaemonLane, goalId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${lane.daemonOrigin}/release/read`, { method: "POST",
    headers: { "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken, "x-moe-session-credential": lane.credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "" },
    body: JSON.stringify({ goalId }),
  });
  return await response.json() as Record<string, unknown>;
}

/**
 * Drives the release's PREREQUISITE to a committed decision, honestly.
 *
 * THE GOAL IS BUILT, NOT PICKED OFF THE SEED. `createLaneContractGoal` (lane-contract-goal.ts:156)
 * composes the graph, delivers all three nodes through the real wrapper, verifies every criterion
 * against the landed tree and closes the goal — so the goal it returns is CONTRACT-BOUND and
 * criterion-VERIFIED and `readReleaseDossierInput` answers with a dossier rather than null.
 * Taking the goal CATALOG's first entry instead, as this helper used to, hands back the shipped
 * demo seed's LEGACY Foundation goal, whose contract binding was never minted; `/release/read`
 * then answers ABSENT and it is answering CORRECTLY. `contract-goal.spec.ts:96-118` pins that
 * legacy refusal by CODE and LAYER, so the two shapes are separated by a test, not by a comment.
 *
 * `landLaneNode` IS NOT CALLED HERE and must not be: the helper composes it itself at
 * lane-contract-goal.ts:162, deliberately BEFORE it adds the contract graph. A second landing
 * afterwards adds a commit and invalidates the exact-SHA criterion evidence this card renders.
 *
 * The publish below is unchanged and is dispatched on a MINTED operator seat, because a lane
 * credential is not a HUMAN principal. Nothing is seeded and no gate is relaxed.
 */
async function landAndPublish(lane: DaemonLane): Promise<{ goalId: string; sha: string }> {
  const contract = await createLaneContractGoal(lane);
  // Every wrapper the helper started is this spec's to account for: pids that never reach the
  // module array are invisible to `assertStopped`/`survivingPids` and leak into the next spec.
  wrapperPids.push(...contract.wrapperPids);
  expect(contract.landedSha, "the lander commits a real sha git resolves")
    .toMatch(/^[0-9a-f]{40}$/u);
  expect(contract.landedSha, "the head must have moved off the lane baseline")
    .not.toBe(lane.workspaceSha);
  // The helper reads its sha from `laneWorkspaceIdentity(scratch.root)`, which is
  // `join(root, "workspace")` — the very directory `lane.workspace` names (daemon-ports.ts:156,
  // :217-222, :651). Same tree, so this identity matches that sha.
  const identity = resolveRepositoryExecutionIdentity(lane.workspace);
  expect(identity.ok, JSON.stringify(identity)).toBe(true);
  if (!identity.ok) throw new Error("unreachable: the assertion above fails first");
  const goalId = contract.goalRef;
  const approval = { branch: "main", remoteUrl: REMOTE_URL,
    repositoryId: publicationRepositoryId(identity.identity), sha: contract.landedSha };
  const published = await command(lane, "repository.publish", publishAggregateId(goalId),
    { approval, goalId, remoteUrl: REMOTE_URL }, mintLaneOperatorSeat(lane));
  expect(published, `PUBLISH: ${JSON.stringify(published)}`).toMatchObject({ outcome: "ACCEPTED" });
  return { goalId, sha: contract.landedSha };
}

/** The operator's real pairing ritual, copied from preview-approve.spec.ts:57-72. */
async function pairBrowser(page: Page, lane: DaemonLane): Promise<void> {
  const approve = lane.approvePairing;
  expect(approve, "the lane must expose an operator channel").not.toBeNull();
  const output = page.getByLabel("Pairing confirmation label");
  await expect(output).toBeVisible({ timeout: 30_000 });
  const label = (await output.textContent())?.trim() ?? "";
  expect(label, "the browser must be shown a real label").toMatch(PAIRING_LABEL);
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

function portClosed(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(origin);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const done = (closed: boolean): void => { socket.destroy(); resolve(closed); };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(false)); socket.once("error", () => done(true));
  });
}

/** EVERY EXIT PATH, including a failing one: the daemon child, its port and its store
 *  directory die here, not at the end of a happy path. */
async function assertStopped(lane: DaemonLane | undefined, why: string): Promise<void> {
  expect(lane, `the real daemon and server must have started: ${why}`).toBeDefined();
  if (lane === undefined) return;
  expect(await survivingPids([...lanePids(lane), ...wrapperPids])).toEqual([]);
  expect(await portClosed(lane.daemonOrigin)).toBe(true);
  expect(await portClosed(lane.baseUrl)).toBe(true);
  expect(existsSync(dirname(lane.catalogPath))).toBe(false);
}

test("real daemon: the operator reads the evidence, approves the release and gets the PR link",
  async ({ page }) => {
    test.setTimeout(JOURNEY_MS);
    let started: DaemonLane | undefined;
    // Held so a lane that never reached `body` reports the daemon's OWN refusal rather than a
    // bare "undefined": a start failure with no reason is the one failure nobody can act on.
    let why = "the lane returned no outcome";
    wrapperPids.length = 0;
    try {
      const options: DaemonLaneOptions & { fakeGh: "SUCCESS" } = {
        fakeGh: "SUCCESS", liveCredentials: "ATTACHED", operatorChannel: true,
      };
      const result = await withDaemonBackedControlRoom(options, async (lane) => {
        started = lane;
        const root = dirname(lane.catalogPath);
        expect(existsSync(join(root, "release-pr-calls.jsonl")), "lane provider selected").toBe(true);
        const { goalId, sha } = await landAndPublish(lane);

        // THE EVIDENCE READ IS LIVE. `/release/read` answers through the real listener before a
        // single browser assertion is made, so everything below is about a real daemon.
        const evidence = await readRelease(lane, goalId);
        expect(evidence, `RELEASE READ: ${JSON.stringify(evidence)}`)
          .toMatchObject({ kind: "PRESENT" });

        await page.goto(lane.baseUrl);
        await pairBrowser(page, lane);
        await page.getByRole("button", { name: /goals/iu }).first().click({ timeout: CARD_MS })
          .catch(() => undefined);
        await page.getByTestId(`cr.goal.open.${goalId}`).click({ timeout: CARD_MS })
          .catch(() => undefined);

        // THE CARD IS THERE, because the daemon offers the decision. The covered/UNKNOWN split
        // is asserted in the browser for the same reason it is asserted in the component arms:
        // an operator reading one number would approve evidence nobody re-measured.
        const card = page.getByTestId("cr.release.root");
        await expect(card).toBeVisible({ timeout: CARD_MS });
        const covered = await page.getByTestId("cr.release.covered").textContent();
        expect(covered ?? "").toMatch(/^Criteria covered \d+ of \d+$/u);
        const unknown = await page.getByTestId("cr.release.unknown").count();
        if (unknown > 0) {
          expect(await page.getByTestId("cr.release.unknown").textContent())
            .toContain("could not be re-measured");
        }
        await expect(page.getByTestId("cr.release.sha")).toContainText(sha.slice(0, 10));

        // ARM, THEN CONFIRM: the same two clicks an operator makes.
        const approve = page.getByTestId("cr.release.button");
        await approve.click();
        await expect(approve).toContainText("Confirm: release");
        await approve.click();

        // THE PR LINK, read back off the daemon's own receipt through `/release/read`.
        const link = page.getByTestId("cr.release.link");
        await expect(link).toBeVisible({ timeout: CARD_MS });
        await expect(link).toHaveAttribute("href", FAKE_PR_URL);

        // THE DAEMON ASKED FOR THE PULL REQUEST IT SAYS IT ASKED FOR. The recorded argv is the
        // PRODUCTION `ghPrArgv`, so a regression that dropped `--base` or pushed the wrong head
        // fails here rather than passing on a green link.
        const calls = readFileSync(join(root, "release-pr-calls.jsonl"), "utf8").trim();
        expect(calls, "the injected pr port must have been reached").not.toBe("");
        const call = JSON.parse(calls.split("\n")[0] ?? "{}") as Record<string, unknown>;
        expect(call["sha"]).toBe(sha);
        expect(call["base"]).toBe("main");
        expect(call["argv"]).toEqual(expect.arrayContaining(["pr", "create", "--repo", REMOTE_URL]));
      });
      why = result.ok ? "ok" : `${result.code}: ${result.detail}`;
      expect(why).toBe("ok");
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { await assertStopped(started, why); }
  });
