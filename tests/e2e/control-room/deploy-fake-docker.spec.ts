/**
 * A DEPLOY AGAINST THE REAL DAEMON COMPOSITION, WITH A FAKE DOCKER PORT BEHIND IT.
 *
 * WHAT IS REAL: the daemon process, the command edge, admission, the bootstrap prerequisite
 * table, the decision ledger, the durable receipts and every refusal code. The publish this
 * deploy depends on is driven all the way through - a REAL git workspace the lane commits, a
 * REAL landing written by `node-lander.ts` inside a real `agent-wrapper-main.ts`, and a REAL
 * `repository.publish` decision committed by the daemon.
 *
 * WHAT IS A DOUBLE: only the deploy's SPAWNS (`docker`, `ssh`, the transfer), injected through
 * the production composition seam by `fake-docker-dependencies.ts`; and the wrapper's SEAT, for
 * the reason `wrapper-lane.ts` gives - a provider cannot be asked to produce an edit on cue.
 *
 * WHAT THIS PROVES: the daemon COMPOSED the injected seam and DISPATCHED to it, and the deploy
 * reached the docker boundary and wrote a durable receipt readable through the production read
 * path. WHAT IT DOES NOT PROVE: that a container ran, an image was built, or a URL served. The
 * double is a double. A consumer inheriting this lane inherits the first half only.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SqliteEventStore } from "@moe/store";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { readCurrentDeployReceipt } from "../../../apps/daemon/src/deployment/deploy-ledger.js";
import { deployTargetAggregateId } from "../../../apps/daemon/src/deployment/deploy-target-contracts.js";
import { publicationRepositoryId } from "../../../apps/daemon/src/repository/publication-approval-contracts.js";
import { publishAggregateId } from "../../../apps/daemon/src/repository/publish-receipt-contracts.js";
import { resolveRepositoryExecutionIdentity } from "../../../apps/daemon/src/repository/repository-execution-identity.js";
import { lanePids, mintLaneOperatorSeat, readWireProtocolVersion, survivingPids,
  withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane, DaemonLaneOptions, LaneOperatorSeat } from "./daemon-ports.js";
import { landLaneNode } from "./lane-landing.js";
import { readGoalCatalogOverHttp } from "./prd-boundary-readers.js";

/** Admitted by `admitRemoteUrl`; the lane never reaches a network with it. */
const REMOTE_URL = "https://github.com/moe-lane/deploy-fake-docker.git";
const ENVIRONMENT = "staging";
const target = { environment: ENVIRONMENT, network: "lane-network", sshTarget: null, url: "https://lane.test" };

/** Every pid this spec is answerable for: the lane's own, plus any wrapper it started. */
const wrapperPids: number[] = [];

async function command(lane: DaemonLane, kind: string, aggregateId: string, payload: object,
  seat?: LaneOperatorSeat): Promise<unknown> {
  const store = SqliteEventStore.openForProject(join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  let expectedVersion: number;
  try { expectedVersion = store.getAggregateVersion(aggregateId); } finally { store.close(); }
  const response = await fetch(`${lane.daemonOrigin}/command`, { method: "POST",
    headers: { "content-type": "application/json", origin: lane.daemonOrigin, "x-moe-csrf": lane.csrfToken,
      // The MINTED OPERATOR SEAT when one is supplied, the lane credential otherwise. The seat
      // is what carries a HUMAN principal past `publish-services.ts:72`; see mintLaneOperatorSeat.
      "x-moe-session-credential": seat?.credential ?? lane.credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "" },
    body: JSON.stringify({ commandId: `lane-${kind}`, commandKind: kind,
      correlationId: "lane-deploy", expectedVersion, payload, requestDigest: "d".repeat(64),
      schemaVersion: "moe-runtime-command/1", sessionCredential: seat?.credential ?? lane.credential,
      targetAggregateId: aggregateId }),
  });
  return response.json();
}

/**
 * Drives the deploy's PREREQUISITE to a committed decision, honestly, and answers with the sha
 * the repository actually holds.
 *
 * THE CHAIN, all of it real: the wrapper's lander commits into the lane's git workspace and
 * records a COMMITTED landing receipt, which is what `publicationGoalIntegrated` counts; the
 * publish is then dispatched on a MINTED operator seat, because a lane credential is not a
 * HUMAN principal and `publish-services.ts:72` correctly refuses it. Nothing is seeded and no
 * gate is relaxed - a refusal anywhere here fails the test with the daemon's own code.
 */
async function landAndPublish(lane: DaemonLane): Promise<string> {
  const landed = await landLaneNode(lane);
  if (landed.wrapperPid !== null) wrapperPids.push(landed.wrapperPid);
  expect(landed.ok ? "ok" : `LANDING: ${landed.detail}`).toBe("ok");
  if (!landed.ok) throw new Error("unreachable: the assertion above fails first");
  expect(landed.sha, "the lander commits a real sha git resolves").toMatch(/^[0-9a-f]{40}$/u);
  expect(landed.sha, "the landing moves the workspace head off its baseline")
    .not.toBe(lane.workspaceSha);
  const catalog = await readGoalCatalogOverHttp(lane.daemonOrigin, lane.repoRoot,
    lane.credential, lane.csrfToken);
  const goalId = "goals" in catalog ? catalog.goals[0]?.goalId ?? null : null;
  expect(goalId, `the seeded lane must expose a goal: ${JSON.stringify(catalog)}`).not.toBeNull();
  const identity = resolveRepositoryExecutionIdentity(lane.workspace);
  expect(identity.ok, JSON.stringify(identity)).toBe(true);
  if (goalId === null || !identity.ok) throw new Error("unreachable: assertions above fail first");
  const approval = { branch: "main", remoteUrl: REMOTE_URL,
    repositoryId: publicationRepositoryId(identity.identity), sha: landed.sha };
  const answer = await command(lane, "repository.publish", publishAggregateId(goalId),
    { approval, goalId, remoteUrl: REMOTE_URL }, mintLaneOperatorSeat(lane));
  expect(answer, `PUBLISH: ${JSON.stringify(answer)}`).toMatchObject({ outcome: "ACCEPTED" });
  return landed.sha;
}

/**
 * Types the pairing label back on the daemon's own operator channel, exactly as an operator
 * would. HAND-MIRRORED from `repository-workflows.spec.ts` — the same six lines, because the
 * pairing dialog is the daemon's, not this spec's, and a private copy that drifts would pair
 * against a screen the daemon no longer shows.
 */
async function pair(page: Page, lane: DaemonLane): Promise<void> {
  const label = page.getByLabel("Pairing confirmation label");
  await expect(label).toBeVisible({ timeout: 30_000 });
  const value = (await label.textContent())?.trim() ?? "";
  expect(value).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u);
  expect(lane.approvePairing).not.toBeNull(); lane.approvePairing?.(value);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && await label.count() !== 0) {
    await page.getByRole("button", { name: "I entered this label" }).click({ timeout: 2000 })
      .catch(() => undefined);
    await page.waitForTimeout(250);
  }
  await expect(label).toHaveCount(0);
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
  // THE WRAPPER IS COUNTED TOO. `landLaneNode` kills it in its own finally, and this is what
  // proves it: a wrapper that survived would still be staffing against a deleted store.
  expect(await survivingPids([...lanePids(lane), ...wrapperPids])).toEqual([]);
  expect(await portClosed(lane.daemonOrigin)).toBe(true);
  expect(await portClosed(lane.baseUrl)).toBe(true);
  expect(existsSync(dirname(lane.catalogPath))).toBe(false);
}

for (const mode of ["SUCCESS", "DEPLOY_DOCKER_UNAVAILABLE"] as const) {
  test(`real daemon fake docker: ${mode} has a durable receipt`, async () => {
    let started: DaemonLane | undefined;
    wrapperPids.length = 0;
    try {
      const options: DaemonLaneOptions & { fakeDocker: typeof mode } = {
        liveCredentials: "ATTACHED", fakeDocker: mode,
      };
      const result = await withDaemonBackedControlRoom(options, async (lane) => {
        started = lane;
        const root = dirname(lane.catalogPath);
        expect(existsSync(join(root, "deploy-spawn-calls.jsonl")), "lane provider selected").toBe(true);
        const bound = await command(lane, "deployment.set_target",
          deployTargetAggregateId(lane.projectId, ENVIRONMENT), target);
        expect(bound, JSON.stringify(bound)).toMatchObject({ outcome: "ACCEPTED" });
        const sha = await landAndPublish(lane);
        const answer = await command(lane, "deployment.deploy", lane.projectId, { environment: ENVIRONMENT, sha });
        // THE REFUSAL THIS LANE NO LONGER GETS. Before the landing and the publish above, the
        // deploy stopped at the prerequisite table (`bootstrap-services.ts:298`) and never
        // reached the double at all. Asserting its ABSENCE makes a regression in the
        // prerequisite chain fail loudly here instead of silently skipping the seam.
        expect(JSON.stringify(answer)).not.toContain("BOOTSTRAP_PREREQUISITE_MISSING");
        expect(answer, JSON.stringify(answer)).toMatchObject(mode === "SUCCESS" ? { outcome: "ACCEPTED" } : {
          outcome: "PORT_REFUSED", stage: "DISPATCH",
          refusal: { code: mode, layer: "DAEMON_DEPLOY_ENGINE" },
        });
        const store = SqliteEventStore.openForProject(join(root, "store.sqlite"), lane.projectId);
        try {
          const receipt = readCurrentDeployReceipt(store, lane.projectId, ENVIRONMENT);
          expect(receipt).toMatchObject({ outcome: mode === "SUCCESS" ? "DEPLOYED" : "REFUSED", sha });
          expect(receipt?.refusal).toEqual(mode === "SUCCESS" ? null : {
            code: mode, layer: "DAEMON_DEPLOY_ENGINE", detail: "docker: not found",
          });
        } finally { store.close(); }
        // THE DOUBLE WAS REACHED, observed rather than inferred: the injected port appends every
        // spawn it is asked for, and `"version"` is the `docker --version` probe the runner makes
        // before anything else. The default composition would have spawned a real docker instead.
        expect(readFileSync(join(root, "deploy-spawn-calls.jsonl"), "utf8")).toContain('"version"');
      });
      expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
    } finally { await assertStopped(started); }
  });
}

/**
 * THE PUBLISH PRECONDITION, WALKED THROUGH THE BROWSER'S OWN PAIRING.
 *
 * `deployment.deploy`'s prerequisite table (`bootstrap-sequence.ts:55`) is
 * `Object.freeze(["repository.publish"])` and reads COMMITTED DECISION KINDS, so a deploy
 * cannot pass on a git sha alone. This arm proves the publish that unlocks it is reachable by
 * a REAL PAIRED HUMAN, not only by a minted seat: the label is read off the page and typed
 * back on the daemon's own operator channel.
 *
 * WHY THE DISPATCH STILL CARRIES A MINTED SEAT. Pairing makes the BROWSER SESSION's principal
 * a HUMAN record; a spec-side `fetch` is a different principal and
 * `isDurableHumanPrincipal` correctly refuses it. `session-handshake.ts` returns the plaintext
 * ONCE and the ledger keeps only its sha256, so the paired seat cannot lend its credential to
 * anyone - measured at 21:03Z. The seat is minted through the SAME production seam the daemon
 * composes (`daemon-store-foundation-composition.ts:590`) under a distinct principal id, so it
 * can never be mistaken for the operator's own.
 */
test("real daemon fake docker: a paired human publishes the lane's own landed commit", async ({ page }) => {
  let started: DaemonLane | undefined;
  wrapperPids.length = 0;
  try {
    const result = await withDaemonBackedControlRoom({ liveCredentials: "ATTACHED",
      operatorChannel: true, fakeDocker: "SUCCESS" }, async (lane) => {
      started = lane;
      await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded" });
      await pair(page, lane);
      expect(lane.workspaceSha, "the lane commits a real sha it reads back from git")
        .toMatch(/^[0-9a-f]{40}$/u);
      await landAndPublish(lane);
    });
    expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
  } finally { await assertStopped(started); }
});

test("real daemon fake docker: teardown also runs when the body throws", async () => {
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
