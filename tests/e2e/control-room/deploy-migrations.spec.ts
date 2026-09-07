/**
 * THE MIGRATION JOURNEY: what a schema did, seen by an operator in the shipped browser.
 *
 * WHAT IS REAL: the daemon process, the deploy command edge, the durable deploy receipts, the
 * durable `moe-migration-receipt/1` records written through the SHIPPED writer
 * (`recordMigrationReceipt`), `readMigrationObservation`'s confinement and verification of the
 * backup reference against a real file on disk, `/activity/read`, `/runs/read`, and the v2
 * control room served from `lane.baseUrl`.
 *
 * WHAT IS A DOUBLE: only the deploy's SPAWNS (docker, ssh, transfer) through
 * `fake-docker-dependencies.ts`, and the wrapper's seat. The migration receipts are written by
 * the production writer rather than a migration ENGINE run - engine behaviour (backup before
 * migrate, MIGRATION_BACKUP_FAILED applying nothing, the restore round trip) is task-0a56ecee's
 * landed arms and the revert is task-537320ee's. THIS journey proves an operator can SEE what
 * those did, which is the half no unit test can reach.
 *
 * THREE MEASURED FACTS THAT SHAPE EVERY ARM BELOW, none of them worked around.
 *
 * 1. THE MIGRATION RECEIPT CANNOT REACH THE GOAL-SCOPED DECISION FEED, and that is the producer
 * row's deliberate design rather than a gap. The receipt carries NO goalRef and NO nodeRef
 * (migration-observation.ts), and it commits on its own `migration:<receiptId>` aggregate, so a
 * goal-scoped `/activity/read` cannot carry it. The PROJECT-WIDE feed can and does: Health
 * mounts `LiveActivity goalRef={null}` (live-ops.tsx:145), which is the surface asserted here.
 * The verdict itself is asserted at the read boundary, exactly as deploy-environment.spec.ts
 * does, because that is the fact the browser renders from.
 *
 * 2. THE NODE CARD IS NOT REACHABLE FROM A LANE AT HEAD, twice over. A seeded lane exposes NO
 * run goal - project-scoped `/runs/read` answers `{"goals":[],"outcome":"RUNS"}` even after a
 * real landing, and a goal-scoped read answers RUNS_READ_GOAL_UNKNOWN for a goal with no
 * source-document binding - so the board has no node card to look inside. And even with one, no
 * line would render: a declaration rides an AUTHORED source
 * (`scheduler-node-planning-authority.ts:141`) and both authority-body writers on disk state NONE
 * deliberately (`compiled-policy-authority-body.ts`, `journey-authority-bodies.ts`), because
 * minting `[]` would move `graphContentHash` for every shipped journey. An absence arm over zero
 * node cards is a zero-case sweep, so this spec asserts the READ's own answer instead; the four
 * node-card renderings are covered by board-screen.test.tsx against the landed `RunNodeView`.
 *
 * 3. THE BACKUP ROOT IS HOST-SCOPED. `goal-deployment-read.ts:55` reads
 * `MOE_DEPLOY_BUILD_CONTEXT` from the DAEMON's own environment, and `daemonEnv` spreads
 * `process.env` into the child - so this spec sets the variable around the lane and restores it,
 * rather than widening `DaemonLaneOptions` for a display need. Without it every backup would
 * stay UNVERIFIED and the VERIFIED arm could never fail.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SqliteEventStore } from "@moe/store";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { readCurrentDeployReceipt } from "../../../apps/daemon/src/deployment/deploy-ledger.js";
import { deployTargetAggregateId } from "../../../apps/daemon/src/deployment/deploy-target-contracts.js";
import { DEPLOY_BUILD_CONTEXT_ENV_KEY } from "../../../apps/daemon/src/deployment/deploy-command.js";
import {
  BACKUP_DIRECTORY, BACKUP_LEAF, PRE_MIGRATION_BACKUP_LEAF,
} from "../../../apps/daemon/src/bootstrap/activation-receipts-measure.js";
import {
  MIGRATION_RECEIPT_COMMAND_KIND, MIGRATION_RECEIPT_VERSION, migrationRefusal,
  migrationReceiptId, recordMigrationReceipt,
} from "../../../apps/daemon/src/repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../../../apps/daemon/src/repository/migrations/migration-receipt.js";
import { publicationRepositoryId } from "../../../apps/daemon/src/repository/publication-approval-contracts.js";
import { publishAggregateId } from "../../../apps/daemon/src/repository/publish-receipt-contracts.js";
import { resolveRepositoryExecutionIdentity } from "../../../apps/daemon/src/repository/repository-execution-identity.js";
import { lanePids, mintLaneOperatorSeat, readWireProtocolVersion, survivingPids,
  withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane, LaneOperatorSeat } from "./daemon-ports.js";
import { LANDING_BUDGET_MS, landLaneNode } from "./lane-landing.js";
import { lanePost } from "./lane-preview.js";
import { seededGoalId } from "./lane-preview-arms.js";

/** MIDDLE DOT, the separator `migration-presentation.tsx` composes with. ASCII source, real glyph. */
const MIDDOT = "·";
/** Admitted by `admitRemoteUrl`; the lane never reaches a network with it. */
const REMOTE_URL = "https://github.com/moe-lane/deploy-migrations.git";
const APPLIED_ENV = "preview";
const REFUSED_ENV = "production";
/** Never deployed on purpose: no deploy receipt is the UNKNOWN arm's only honest source. */
const UNKNOWN_ENV = "verify";
const target = (environment: string) => ({ environment, network: `lane-${environment}`,
  sshTarget: null, url: `https://${environment}.lane.test` });

/** `\d{13,17}[-_]...` - what `migrationFilename` admits and the observation re-checks on the way out. */
const FIRST_MIGRATION = "20260907120000001-add-orders.sql";
const SECOND_MIGRATION = "20260907120000002-add-orders-index.sql";
const FAILING_MIGRATION = "20260907120000003-add-orders-fk.sql";
/** `^\d{17}\.sql$` - what `BACKUP_LEAF_NAME` admits as a pre-migration dump leaf. */
const BACKUP_LEAF_FILE = "20260907120000000.sql";
const APPLIED_DIGEST = "a".repeat(64);
const REFUSED_DIGEST = "b".repeat(64);

const LANE_TIMEOUT_MS = LANDING_BUDGET_MS + 420_000;
const CARD_MS = 30_000;

/** Every pid this spec is answerable for: the lane's own, plus any wrapper it started. */
const wrapperPids: number[] = [];

/**
 * PER-DISPATCH, NOT PER-AGGREGATE. Both deploys target the SAME `deploy:<goalId>` aggregate with
 * DIFFERENT payloads, and a command id replayed with different bytes is refused
 * BOOTSTRAP_COMMAND_BYTES_CONFLICT @ DAEMON_PREREQUISITE - measured at 19:07Z, where an
 * aggregate-keyed id made the production deploy fail before any migration arm ran.
 */
let dispatches = 0;

async function command(lane: DaemonLane, kind: string, aggregateId: string, payload: object,
  seat?: LaneOperatorSeat): Promise<unknown> {
  const store = SqliteEventStore.openForProject(join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  let expectedVersion: number;
  try { expectedVersion = store.getAggregateVersion(aggregateId); } finally { store.close(); }
  dispatches += 1;
  const response = await fetch(`${lane.daemonOrigin}/command`, { method: "POST",
    headers: { "content-type": "application/json", origin: lane.daemonOrigin, "x-moe-csrf": lane.csrfToken,
      "x-moe-session-credential": seat?.credential ?? lane.credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "" },
    body: JSON.stringify({ commandId: `lane-${kind}-${String(dispatches)}`, commandKind: kind,
      correlationId: "lane-migration-journey", expectedVersion, payload, requestDigest: "d".repeat(64),
      schemaVersion: "moe-runtime-command/1", sessionCredential: seat?.credential ?? lane.credential,
      targetAggregateId: aggregateId }),
  });
  return response.json();
}

function withStore<T>(lane: DaemonLane, body: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  try { return body(store); } finally { store.close(); }
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

/**
 * Deploys ONE environment as the operator and answers the deploy receipt's `decisionId` - which
 * IS the key `readMigrationObservation` resolves the migration receipt by. Read from the durable
 * receipt rather than constructed: a constructed key would pass even if the two came apart.
 */
async function deployAndKey(lane: DaemonLane, goalId: string, environment: string,
  sha: string): Promise<string> {
  const bound = await command(lane, "deployment.set_target",
    deployTargetAggregateId(lane.projectId, environment), target(environment));
  expect(bound, `SET_TARGET ${environment}: ${JSON.stringify(bound)}`).toMatchObject({ outcome: "ACCEPTED" });
  const deployed = await command(lane, "deployment.deploy", `deploy:${goalId}`, { environment, sha });
  expect(deployed, `DEPLOY ${environment}: ${JSON.stringify(deployed)}`).toMatchObject({ outcome: "ACCEPTED" });
  const receipt = withStore(lane, (store) =>
    readCurrentDeployReceipt(store, lane.projectId, environment));
  expect(receipt, `no deploy receipt for ${environment}`).not.toBeNull();
  const decisionId = receipt?.decisionId ?? "";
  expect(decisionId, "the receipt names the decision the migration receipt is keyed by").not.toBe("");
  return decisionId;
}

/**
 * Writes a real pre-migration dump under the CONFINED directory the observation checks, and
 * answers the `<path>@sha256:<digest>` reference the receipt carries. The digest is not computed
 * from the bytes on purpose: `backupOf` verifies CONFINEMENT and EXISTENCE and then serves the
 * receipt's own digest, so a computed one would assert the file rather than the code path.
 */
function seedBackup(root: string, environment: string, digest: string): string {
  const directory = join(root, BACKUP_DIRECTORY, BACKUP_LEAF, PRE_MIGRATION_BACKUP_LEAF, environment);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, BACKUP_LEAF_FILE);
  // NO CREDENTIALS IN THE FIXTURE, not even a placeholder connection string: epic rail 3 holds
  // for a file a test writes as much as for one the engine does.
  writeFileSync(path, "-- pre-migration dump for the lane; no connection values here\n", "utf8");
  return `${path}@sha256:${digest}`;
}

function receiptFor(lane: DaemonLane, requestId: string, environment: string, sha: string,
  fields: Pick<MigrationReceipt, "applied" | "backupRef" | "outcome" | "refusal">): MigrationReceipt {
  return { version: MIGRATION_RECEIPT_VERSION, receiptId: migrationReceiptId(lane.projectId, requestId),
    requestId, projectId: lane.projectId, environment, sha, decidedAt: new Date().toISOString(),
    ...fields };
}

async function openGoal(page: Page, goalId: string): Promise<void> {
  await page.getByTestId("cr.nav.goals").click();
  await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: CARD_MS });
  await page.getByTestId(`cr.goals.card.${goalId}.open`).click();
}

/** HAND-MIRRORED from deploy-environment.spec.ts: the pairing dialog is the daemon's. */
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

test("migration journey: what the schema did, on the card, in the feed, and NOT on the node",
  async ({ page }) => {
    test.setTimeout(LANE_TIMEOUT_MS);
    let started: DaemonLane | undefined;
    wrapperPids.length = 0;
    dispatches = 0;
    // OUTSIDE the lane so the daemon child inherits it, and restored in the same `finally` that
    // deletes the root - a leaked variable would silently VERIFY a stranger's backup next run.
    const buildContext = realpathSync(mkdtempSync(join(tmpdir(), "moe-migrations-e2e-")));
    const priorBuildContext = process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY];
    process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY] = buildContext;
    try {
      const appliedRef = seedBackup(buildContext, APPLIED_ENV, APPLIED_DIGEST);
      const refusedRef = seedBackup(buildContext, REFUSED_ENV, REFUSED_DIGEST);
      const result = await withDaemonBackedControlRoom({
        fakeDocker: "SUCCESS", liveCredentials: "ATTACHED", operatorChannel: true,
      }, async (lane) => {
        started = lane;
        const goalId = await seededGoalId(lane);
        const sha = await landAndPublish(lane, goalId);

        // TWO DEPLOYS, TWO KEYS. `verify` is deliberately never deployed.
        const appliedKey = await deployAndKey(lane, goalId, APPLIED_ENV, sha);
        const refusedKey = await deployAndKey(lane, goalId, REFUSED_ENV, sha);
        expect(appliedKey, "each environment carries its OWN decision key").not.toBe(refusedKey);

        // THE TWO RECEIPTS, through the SHIPPED writer. The refused one keeps its backup: a
        // migration that failed AFTER a good dump is the exact state this feature exists to make
        // visible, and it must not read as "no backup was taken".
        withStore(lane, (store) => {
          recordMigrationReceipt(store, receiptFor(lane, appliedKey, APPLIED_ENV, sha, {
            applied: [FIRST_MIGRATION, SECOND_MIGRATION], backupRef: appliedRef,
            outcome: "APPLIED", refusal: null,
          }));
          recordMigrationReceipt(store, receiptFor(lane, refusedKey, REFUSED_ENV, sha, {
            applied: [], backupRef: refusedRef, outcome: "REFUSED",
            refusal: migrationRefusal("MIGRATION_FAILED", FAILING_MIGRATION),
          }));
        });

        await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded" });
        await pair(page, lane);

        // ---- SURFACE 1: THE DEPLOYMENTS CARD, three environments, three readings ----
        await openGoal(page, goalId);
        await expect(page.getByTestId("cr.deploy.root")).toBeVisible({ timeout: CARD_MS });

        const appliedLine = page.getByTestId(`cr.deploy.${APPLIED_ENV}.migration`);
        await expect(appliedLine).toHaveText(
          `Applied ${FIRST_MIGRATION}, ${SECOND_MIGRATION}`, { timeout: CARD_MS });
        // BOTH identifiers, never the first and a truncation.
        await expect(appliedLine).toContainText(SECOND_MIGRATION);
        await expect(page.getByTestId(`cr.deploy.${APPLIED_ENV}.backup`))
          .toHaveText(`Backup verified ${MIDDOT} sha256 ${APPLIED_DIGEST}`);

        // REFUSED CARRIES CODE **AND** LAYER and names the failing migration, and says nothing
        // that reads as applied. More than one layer can refuse a migration; a line naming only
        // the word leaves an operator unable to tell which one answered.
        const refusedLine = page.getByTestId(`cr.deploy.${REFUSED_ENV}.migration`);
        await expect(refusedLine).toHaveText(
          `Refused ${MIDDOT} MIGRATION_FAILED ${MIDDOT} DAEMON_INGRESS ${MIDDOT} at ${FAILING_MIGRATION}`,
          { timeout: CARD_MS });
        await expect(refusedLine).not.toContainText("Applied");
        await expect(refusedLine).not.toContainText("Reverted");
        // ITS BACKUP SURVIVED THE REFUSAL, and the card says so rather than implying none exists.
        await expect(page.getByTestId(`cr.deploy.${REFUSED_ENV}.backup`))
          .toHaveText(`Backup verified ${MIDDOT} sha256 ${REFUSED_DIGEST}`);

        // UNKNOWN IS A STATE, NOT AN ABSENCE: named by its code, never zero, never blank, never
        // "nothing to apply". An environment that was never deployed is the honest source of it.
        const unknownLine = page.getByTestId(`cr.deploy.${UNKNOWN_ENV}.migration`);
        await expect(unknownLine).toHaveText(
          `Migration state is not known here ${MIDDOT} MIGRATION_RECEIPT_ABSENT ${MIDDOT} DAEMON_INGRESS`,
          { timeout: CARD_MS });
        // `backupState` is null while UNKNOWN, so there is NO backup sentence to render at all.
        await expect(page.getByTestId(`cr.deploy.${UNKNOWN_ENV}.backup`)).toHaveCount(0);

        // NO CROSS-ASSOCIATION. Each environment's facts live under ITS OWN row, so one row can
        // never be read off another - asserted on the ROW, which is the element that would leak.
        const appliedRow = page.getByTestId(`cr.deploy.${APPLIED_ENV}.row`);
        await expect(appliedRow).not.toContainText(FAILING_MIGRATION);
        await expect(appliedRow).not.toContainText(REFUSED_DIGEST);
        const refusedRow = page.getByTestId(`cr.deploy.${REFUSED_ENV}.row`);
        await expect(refusedRow).not.toContainText(FIRST_MIGRATION);
        await expect(refusedRow).not.toContainText(APPLIED_DIGEST);

        // THE BACKUP IS A REFERENCE, NEVER AN AFFORDANCE. No path leaves the daemon module, and
        // the digest is not a link: an anchor here would both reconstruct a location and offer a
        // database dump as a download. Asserted over the whole card, not one line.
        const card = page.getByTestId("cr.deploy.root");
        const rendered = (await card.textContent()) ?? "";
        expect(rendered, "no connection string reaches the card").not.toContain("postgres://");
        expect(rendered, "no variable name that would invite one").not.toContain("DATABASE_URL");
        expect(rendered, "the backup PATH stays inside the daemon module").not.toContain(buildContext);
        expect(rendered).not.toContain(BACKUP_LEAF_FILE);
        expect(await card.locator(`a:has-text("${APPLIED_DIGEST}")`).count(),
          "the sha256 is quoted, never clicked").toBe(0);

        // ---- SURFACE 2: THE NODE CARD - NOT REACHABLE FROM A LANE, measured, not skipped ----
        // A seeded lane exposes NO run goal at all: project-scoped `/runs/read` answers
        // `{"goals":[],"outcome":"RUNS","totals":{...,"nodes":0}}` even after a real landing, and
        // a goal-scoped read answers RUNS_READ_GOAL_UNKNOWN because the seeded goal has no
        // source-document binding. Measured at 19:09Z, and asserted below rather than assumed.
        //
        // So there is no node card to look inside. An absence arm run against a board with zero
        // node cards is a ZERO-CASE SWEEP - it would report green while proving nothing - so this
        // spec asserts the read's own answer and stops. The node card's four renderings (one
        // identifier, two identifiers, declared-none, and the member absent) are asserted against
        // the real `BoardScreen` in `board-screen.test.tsx`.
        //
        // Even a lane that DID expose a run goal would render no line: a declaration rides an
        // AUTHORED source (`scheduler-node-planning-authority.ts:141`) and both authority-body
        // writers on disk state NONE deliberately, because minting `[]` would move
        // `graphContentHash` for every shipped journey.
        const runs = await lanePost(lane, "/runs/read", {});
        expect(runs.status, JSON.stringify(runs.body)).toBe(200);
        expect(runs.body["outcome"], JSON.stringify(runs.body)).toBe("RUNS");
        // THE PREMISE ITSELF IS PINNED, so it cannot go stale in silence. If a lane ever DOES
        // expose a run goal, this reds and whoever changed it has to write the real DOM arm here
        // rather than inheriting a zero-case sweep that passes for the wrong reason.
        expect((runs.body["goals"] as readonly unknown[]).length,
          "a seeded lane exposes no run goal, which is WHY there is no node card to look inside")
          .toBe(0);
        expect(JSON.stringify(runs.body), "no lane node declares a migration")
          .not.toContain(FIRST_MIGRATION);
        // The board agrees with the read: no detail body, and therefore no Migrations label. Both
        // zeros are asserted TOGETHER so the second is never read as evidence on its own.
        expect(await page.locator("[data-testid^='cr.kanban.detail.']").count()).toBe(0);
        expect(await page.locator("[data-testid^='cr.kanban.migrations.']").count()).toBe(0);

        // ---- SURFACE 3: THE PROJECT-WIDE FEED ----
        // The verdict at the READ boundary first: this is the fact the browser renders from, and
        // it is what makes APPLIED, REFUSED and REVERTED three different things in the feed.
        const activity = await lanePost(lane, "/activity/read", {});
        const entries = (activity.body["entries"] ?? []) as { commandKind?: string; verdict?: string }[];
        const receipts = entries.filter((entry) => entry.commandKind === MIGRATION_RECEIPT_COMMAND_KIND);
        expect(receipts.length, `no migration receipt in ${JSON.stringify(activity.body)}`).toBe(2);
        expect(receipts.map((entry) => entry.verdict).sort()).toEqual(["APPLIED", "REFUSED"]);

        // NOW IN THE SHIPPED BROWSER. Health mounts the project-wide activity list; a goal-scoped
        // feed cannot carry a receipt that has no goalRef, and nothing here attaches one.
        await page.getByTestId("cr.nav.health").click();
        await expect(page.getByTestId("cr.activity.root")).toBeVisible({ timeout: CARD_MS });
        await expect(page.getByTestId("cr.activity.list")).toContainText(
          "recorded the migration", { timeout: CARD_MS });
        const feed = (await page.getByTestId("cr.activity.root").textContent()) ?? "";
        expect(feed, "no connection string in the ledger either").not.toContain("postgres://");
        expect(feed).not.toContain("DATABASE_URL");
        expect(feed, "and no backup path").not.toContain(buildContext);
      });
      expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
    } finally {
      // RESTORED, not deleted-to-undefined: an assigned `undefined` is still an own key on
      // `process.env` on some platforms, and a later spec reading it would see a set variable.
      if (priorBuildContext === undefined) delete process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY];
      else process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY] = priorBuildContext;
      rmSync(buildContext, { recursive: true, force: true });
      expect(existsSync(buildContext), "the spec deletes the temp root it created").toBe(false);
      await assertStopped(started);
    }
  });

test("migration journey: teardown also runs when the body throws", async () => {
  let started: DaemonLane | undefined;
  wrapperPids.length = 0;
  const failure = new Error("E2E_MIGRATION_SENTINEL");
  try {
    await expect(withDaemonBackedControlRoom({ liveCredentials: "ATTACHED", seed: "NONE",
      fakeDocker: "SUCCESS" }, async (lane) => {
      started = lane; throw failure;
    })).rejects.toBe(failure);
  } finally { await assertStopped(started); }
});
