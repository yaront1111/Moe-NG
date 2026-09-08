import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SqliteEventStore } from "@moe/store";

import { publicationRepositoryId }
  from "../../../apps/daemon/src/repository/publication-approval-contracts.js";
import { readPublishLedger }
  from "../../../apps/daemon/src/repository/publish-ledger.js";
import { publishAggregateId }
  from "../../../apps/daemon/src/repository/publish-receipt-contracts.js";
import { createRepositoryExecutionPort }
  from "../../../apps/daemon/src/repository/repository-execution-port.js";
import { resolveRepositoryExecutionIdentity }
  from "../../../apps/daemon/src/repository/repository-execution-identity.js";
import { FAKE_PR_URL } from "./fake-gh-contract.js";
import { killTree, running } from "./daemon-children.js";
import { lanePids, mintLaneOperatorSeat, readWireProtocolVersion, survivingPids,
  withDaemonBackedControlRoom } from "./daemon-ports.js";
import { resolveLaneScratch, startWrapper, WRAPPER_INTERVAL_MS, wrapperEnv }
  from "./wrapper-lane.js";
import type { DaemonLane, DaemonLaneOptions, LaneOperatorSeat, LaneScratch }
  from "./daemon-ports.js";
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
/** How long the daemon's advance tick gets to run `publishOnce` and record its receipt. */
const PUBLISH_BUDGET_MS = 120_000;
const PAIRING_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
/**
 * THE REMOTE IS A REAL GIT REPOSITORY, and it has to be.
 *
 * `release-evidence-read.ts:216` measures the dossier's sha from `publication?.outcome ===
 * "PUSHED" ? publication.sha : null`, and `git-publication-port.ts:66` gets there only by
 * running an actual `git push -- <remoteUrl> <sha>:refs/heads/<branch>`. The
 * `https://github.com/moe-lane/...` placeholder this file used to carry -- the same idiom
 * `deploy-environment.spec.ts:23` records as "this lane's publish has no reachable remote" --
 * therefore CANNOT publish: the push fails, the receipt is REFUSED, the dossier's sha stays
 * null and the card truthfully prints "Nothing is published yet". That is the product being
 * right, so the fix is to give it a remote that exists rather than to relax the card.
 *
 * A BARE REPOSITORY IN THE LANE SCRATCH IS NOT A DOUBLE. The push, the objects, the ref and
 * the `git ls-remote` re-measurement `release-head-proof.ts:15-20` makes before any `gh` spawn
 * are all the production code paths against real git. Only the `gh pr create` SUBPROCESS stays
 * faked, which is this lane's one declared double. Nothing is seeded and no gate is relaxed.
 *
 * FORWARD SLASHES ARE LOAD-BEARING: `admitRemoteUrl` (publish-receipt-contracts.ts:77) matches
 * `D:/path/x.git` through REMOTE_SSH but refuses the backslash form, and refuses `file://` by
 * the name of its scheme -- so `D:\path\x.git` would be PUBLISH_REMOTE_URL_INVALID.
 */
function createLaneRemote(root: string): string {
  const remote = join(root, "release-remote.git");
  execFileSync("git", ["init", "--bare", "--quiet", remote], { windowsHide: true });
  return remote.replaceAll("\\", "/");
}

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
async function landAndPublish(
  lane: DaemonLane,
): Promise<{ goalId: string; remoteUrl: string; sha: string }> {
  // RESOLVED BEFORE the helper runs, and that ordering is load-bearing: `resolveLaneScratch`
  // keys on `node-specs/node.json`, and `landLaneNode` retires that spec on its way through
  // (lane-contract-goal.ts:159), so afterwards it answers null for a lane that plainly exists.
  const laneScratch = resolveLaneScratch(lane);
  expect(laneScratch, "the lane scratch must resolve before the spec is retired").not.toBeNull();
  if (laneScratch === null) throw new Error("unreachable: the assertion above fails first");
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
  const remoteUrl = createLaneRemote(dirname(lane.catalogPath));
  const approval = { branch: "main", remoteUrl,
    repositoryId: publicationRepositoryId(identity.identity), sha: contract.landedSha };
  const published = await command(lane, "repository.publish", publishAggregateId(goalId),
    { approval, goalId, remoteUrl }, mintLaneOperatorSeat(lane));
  expect(published, `PUBLISH: ${JSON.stringify(published)}`).toMatchObject({ outcome: "ACCEPTED" });
  // ACCEPTED IS THE DISPATCH, NOT THE PUSH. The publisher writes its own receipt under its own
  // principal, and a refused push still leaves the command ACCEPTED -- so asserting only the
  // outcome above would let an unreachable remote travel 120s downstream and re-surface as
  // "the card is missing a sha", a true sentence about the wrong subject. Assert the receipt,
  // and quote the publisher's OWN refusal when it is not PUSHED.
  wrapperPids.push(await tickPublisher(lane, laneScratch, contract.scratch.workspace));
  expect(await awaitPublishOutcome(lane, goalId), "the publisher must have pushed the goal's branch")
    .toBe("PUSHED");
  return { goalId, remoteUrl, sha: contract.landedSha };
}

/**
 * ONE PASS OF THE REAL WRAPPER, because the wrapper is what publishes.
 *
 * `repository-delivery-runtime.ts:128` runs `publishOnce` on the wrapper's advance tick, and
 * outside `release.decide`'s own reconciliation that is its ONLY caller -- `node-publisher.ts`
 * is imported by exactly those two. A deployment's wrapper polls continuously, so an operator's
 * `repository.publish` is picked up seconds later; THIS LANE kills its wrapper after each
 * delivery pass, so by the time the publish request lands nothing is left polling and it sits
 * unpublished forever. That is a lane artefact, not a product gap, and the honest repair is to
 * run the real wrapper -- recording a receipt on the daemon's behalf would fake the push.
 *
 * `MOE_WRAPPER_ONCE` bounds it to a single pass. Every node is delivered and the goal is closed
 * by now, so the pass staffs nothing and commits nothing: the exact-SHA criterion evidence the
 * card renders is still measured at the same head afterwards.
 */
async function tickPublisher(
  lane: DaemonLane, scratch: LaneScratch, workspace: string,
): Promise<number> {
  const tracked: ChildProcess[] = [];
  const watched = startWrapper(lane.repoRoot, {
    ...wrapperEnv(scratch, "node --version", WRAPPER_INTERVAL_MS, true),
    MOE_WRAPPER_ONCE: "1", MOE_NODE_SPECS_DIR: "", MOE_NODE_WORKSPACE: workspace,
  }, tracked);
  try {
    const deadline = Date.now() + PUBLISH_BUDGET_MS;
    while (running(watched.child) && Date.now() < deadline) await sleep(250);
    expect(watched.child.pid, "the wrapper must report a pid this spec can account for")
      .not.toBeUndefined();
    return watched.child.pid ?? 0;
  } finally {
    for (const child of [...tracked].reverse()) await killTree(child);
  }
}

/**
 * The publisher's receipt, POLLED. `repository-delivery-runtime.ts:128` runs `publishOnce` on
 * the daemon's own advance tick, so the receipt lands strictly after the command returns -- a
 * single read here answered "NO PUBLISH RECEIPT WAS RECORDED" on a run whose push then
 * succeeded. Bounded, and a timeout still reports the last thing the ledger actually said.
 */
async function awaitPublishOutcome(lane: DaemonLane, goalId: string): Promise<string> {
  const deadline = Date.now() + PUBLISH_BUDGET_MS;
  let outcome = publishOutcome(lane, goalId);
  while (outcome !== "PUSHED" && Date.now() < deadline) {
    await sleep(1_000);
    outcome = publishOutcome(lane, goalId);
  }
  return outcome;
}

/** The publisher's own receipt for this goal, as `PUSHED` or the refusal it recorded instead. */
function publishOutcome(lane: DaemonLane, goalId: string): string {
  const store = SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  try {
    const state = readPublishLedger(store, lane.projectId).get(goalId);
    const receipts = [...state?.receipts.values() ?? []];
    const receipt = receipts[receipts.length - 1];
    if (receipt !== undefined) {
      return receipt.outcome === "PUSHED"
        ? "PUSHED" : `${receipt.outcome}: ${JSON.stringify(receipt.refusal)}`;
    }
    // NO RECEIPT IS THREE DIFFERENT FACTS and they need different fixes: the publish request
    // never committed, or it committed and `publishOnce` answered UNKNOWN without recording.
    // `node-publisher.ts:41-43` returns UNKNOWN whenever `publicationReservation` is null, and
    // that is null when the workspace lock is held by SOMETHING ELSE -- so the reservation's
    // owner is the discriminator, and printing it is the difference between a fix and a guess.
    const held = createRepositoryExecutionPort().inspect(lane.workspace);
    const lock = held.ok
      ? JSON.stringify({ nodeRef: held.reservation?.nodeRef ?? null, phase: held.reservation?.phase ?? null })
      : JSON.stringify(held);
    return `NO PUBLISH RECEIPT: requests=${state?.requests.length ?? 0} lock=${lock}`;
  } finally { store.close(); }
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
        const { goalId, remoteUrl, sha } = await landAndPublish(lane);

        // THE EVIDENCE READ IS LIVE. `/release/read` answers through the real listener before a
        // single browser assertion is made, so everything below is about a real daemon.
        const evidence = await readRelease(lane, goalId);
        expect(evidence, `RELEASE READ: ${JSON.stringify(evidence)}`)
          .toMatchObject({ kind: "PRESENT" });

        await page.goto(lane.baseUrl);
        await pairBrowser(page, lane);
        // OPEN THE GOAL FOR REAL, and let a broken locator SAY SO. The release card mounts on
        // the open goal (cordum-app.tsx:311), so a navigation that silently does not arrive
        // reports itself 120s later as "the card is missing" -- a true statement about the
        // wrong subject. `cr.goals.card.<id>.open` is the testid the product actually ships
        // (goals-home.tsx GoalCard, used by deploy-environment.spec.ts:126 and six others);
        // an earlier draft here waited on a `cr.goal.open.<id>` that exists in NO source file
        // and swallowed the timeout, which is how a locator typo wore a product defect's face.
        await page.getByTestId("cr.nav.goals").click({ timeout: CARD_MS });
        await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: CARD_MS });
        await page.getByTestId(`cr.goals.card.${goalId}.open`).click({ timeout: CARD_MS });

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
        expect(call["argv"]).toEqual(expect.arrayContaining(["pr", "create", "--repo", remoteUrl]));
      });
      why = result.ok ? "ok" : `${result.code}: ${result.detail}`;
      expect(why).toBe("ok");
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { await assertStopped(started, why); }
  });
