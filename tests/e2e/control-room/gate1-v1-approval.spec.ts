import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.js";
import { killTree, spawnNode, survivingPids } from "./daemon-children.js";
import {
  LANE_CREDENTIAL, LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot, seedEnv,
} from "./daemon-ports.js";
import { readGoalCatalogOverHttp } from "./prd-boundary-readers.js";

/**
 * GATE 1 (approve the Product Contract) END TO END on the plane the daemon
 * states. Review 4's R4-2: the browser card was bound to the `/2` read, which
 * refuses CUTOVER_V2_NOT_ACTIVE on every real installation, while agents propose
 * revisions on the `/1` plane. Nothing a human did in the browser could reach a
 * pending contract. This lane proves the whole path with the real daemon, the
 * real bundle and a real Chromium:
 *
 *   1. the operator creates a goal from a PRD in the browser (the goal binds the
 *      PRD's sha, which is what a revision must cite);
 *   2. a planner proposes a `/1` revision through the daemon's OWN offer for that
 *      goal (`product_contract.propose_revision` on the affordance surface), with
 *      the lane's operator credential - exactly how an agent reaches it;
 *   3. the browser opens the goal and the Gate 1 card renders THAT revision from
 *      `/product-contract/pending/read`, the route the stated plane selects;
 *   4. the human approves from the card; the daemon's V1 gate commits it and the
 *      same read answers NONE, so the card retires itself.
 *
 * Every identity is the daemon's: the proposal dispatches the minted offer, the
 * approval presents the minted affordance and subject digest the read answered.
 */

const DAEMON_READY_MS = 60_000;
const SEED_MS = 90_000;
const BUILD_MS = 180_000;
const ORIGIN_LINE = /listening on (http:\/\/127\.0\.0\.1:\d+)/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;

const PRD_NAME = "gate1-prd.md";
const PRD_TEXT = "# Sign-in\n\nUsers sign in with an email and a password.\n";
const PRD_SHA256 = createHash("sha256").update(PRD_TEXT, "utf8").digest("hex");
const GOAL_TITLE = "Gate 1 lane goal";
const GOAL_OUTCOME = "A human approves the proposed Product Contract from the browser.";
const REQUIREMENT = "Users can sign in with an email and a password.";
const CRITERION = "A registered user with the right password lands on the home screen.";

/** Resolves the child's exit code, or null once `ms` is spent. */
const awaitExit = (child: ChildProcess, ms: number): Promise<number | null> =>
  new Promise((done) => {
    const timer = setTimeout(() => { done(null); }, ms);
    child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });

interface DaemonAnswer {
  readonly body: unknown;
  readonly status: number;
  readonly text: string;
}

/** A planner-side POST: the lane's operator credential, every header the listener fences on. */
async function askDaemon(origin: string, path: string, body: unknown): Promise<DaemonAnswer> {
  const response = await fetch(`${origin}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin,
      "x-moe-csrf": LANE_CSRF_TOKEN,
      "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
      "x-moe-session-credential": LANE_CREDENTIAL,
    },
    method: "POST",
  });
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* raw text stays in `text` */ }
  return { body: parsed, status: response.status, text };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

test("R4-2: Gate 1 reads and approves a /1 revision on the plane the daemon states", async ({ page }) => {
  test.setTimeout(300_000);
  const root = repoRoot();
  expect(root, "repo root (package.json + pnpm-workspace.yaml)").not.toBeNull();
  if (root === null) return;

  const dist = join(root, "apps", "control-room", "dist");
  const scratch = createLaneScratch();
  const children: ChildProcess[] = [];
  const pids: number[] = [];
  try {
    // 1. Build the bundle the daemon hosts, with no baked live credential.
    const build = spawnNode(
      [join(root, "apps", "control-room", "node_modules", "vite", "bin", "vite.js"), "build"],
      join(root, "apps", "control-room"),
      { ...process.env, VITE_MOE_LIVE_CREDENTIAL: undefined, VITE_MOE_LIVE_CSRF: undefined },
    );
    children.push(build.child);
    expect(await awaitExit(build.child, BUILD_MS), `vite build:\n${build.transcript().slice(-800)}`)
      .toBe(0);
    expect(existsSync(join(dist, "index.html")), "the build must emit index.html").toBe(true);

    // 2. Daemon on an ephemeral port, hosting the bundle, operator pipe on stdin.
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

    // 3. Seed the project so the home screen has a catalog to add to.
    const seed = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "orchestrator", "demo-seed-main.ts"),
    ], root, seedEnv(scratch, origin, "SPEED"));
    children.push(seed.child);
    expect(await awaitExit(seed.child, SEED_MS), `demo seed:\n${seed.transcript().slice(-1000)}`)
      .toBe(0);

    // 4. Pair through the real runtime handshake. The bootstrap this browser reads
    //    states the plane; on this daemon that is V1, and nothing below sets it.
    const runtimeFailure = new Promise<never>((_resolve, reject) => {
      page.on("pageerror", (error: Error) => {
        reject(new Error(`E2E_CONTROL_ROOM_RUNTIME_ERROR: ${error.message}`));
      });
    });
    const labelOutput = page.getByLabel("Pairing confirmation label");
    await Promise.race([
      page.goto(`${origin}/`, { waitUntil: "domcontentloaded" })
        .then(async () => { await expect(labelOutput).toBeVisible({ timeout: 20_000 }); }),
      runtimeFailure,
    ]);
    const confirmationLabel = (await labelOutput.textContent())?.trim() ?? "";
    expect(confirmationLabel).toMatch(CONFIRMATION_LABEL);
    expect(daemon.child.stdin, "the explicit operator pipe must exist").not.toBeNull();
    daemon.child.stdin?.write(`${confirmationLabel}\n`);
    await page.getByRole("button", { name: "I entered this label" }).click();
    await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: 60_000 });

    // 5. The operator creates a goal from a PRD. The goal binds the PRD's sha; a
    //    revision must cite exactly that digest, so the proposal below is bound to
    //    what the browser actually submitted, not to a fixture.
    await page.getByTestId("cr.goals.new").click();
    await expect(page.getByTestId("cr.goals.newgoal.form")).toBeVisible();
    await page.getByTestId("cr.goals.newgoal.title").fill(GOAL_TITLE);
    await page.getByTestId("cr.goals.newgoal.outcome").fill(GOAL_OUTCOME);
    await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
      buffer: Buffer.from(PRD_TEXT, "utf8"), mimeType: "text/markdown", name: PRD_NAME,
    });
    await expect(page.getByTestId("cr.goals.newgoal.prd.status"))
      .toHaveText(`Read in this browser - sha256 ${PRD_SHA256}`);
    await page.getByTestId("cr.goals.newgoal.create").click();

    let goalId: string | null = null;
    await expect.poll(async () => {
      const catalog = await readGoalCatalogOverHttp(origin, root, LANE_CREDENTIAL, LANE_CSRF_TOKEN);
      if (!("goals" in catalog)) return null;
      const entry = catalog.goals.find((row) => row.binding?.contentSha256 === PRD_SHA256);
      goalId = entry?.goalId ?? null;
      return goalId;
    }, { message: "the created goal must appear in the daemon's catalog bound to the PRD sha", timeout: 30_000 })
      .not.toBeNull();
    if (goalId === null) return;
    const createdGoalId: string = goalId;

    // 6. A planner proposes a /1 revision through the daemon's OWN offer. The offer
    //    is read off the affordance surface, never spelled here, and dispatched on
    //    `/command`: the plane the daemon serves today.
    const surface = await askDaemon(origin, "/affordances/read", {});
    expect(surface.status, `affordance surface:\n${surface.text.slice(0, 600)}`).toBe(200);
    const offers = isRecord(surface.body) && Array.isArray(surface.body["nextAllowedCommands"])
      ? surface.body["nextAllowedCommands"] as readonly unknown[] : [];
    const offer = offers.find((row) => isRecord(row)
      && row["commandKind"] === "product_contract.propose_revision"
      && row["targetAggregateId"] === createdGoalId);
    expect(offer, `no propose_revision offer for ${createdGoalId} among ${
      offers.map((row) => isRecord(row) ? `${String(row["commandKind"])}@${String(row["targetAggregateId"])}` : "?").join(", ")
    }`).toBeDefined();
    if (!isRecord(offer)) return;
    const draft = {
      authorRef: "planner-e2e",
      contractId: "contract-gate1-lane",
      criteria: [{
        criterionId: "crit-1", requirementId: "req-1", statement: CRITERION,
        supersedesCriterionId: null,
      }],
      lineage: null,
      requirements: [{ requirementId: "req-1", statement: REQUIREMENT, supersedesRequirementId: null }],
      retiredCriterionIds: [],
      retiredRequirementIds: [],
      revisionId: "rev-1",
      sourceDocumentDigests: [PRD_SHA256],
    };
    const proposed = await askDaemon(origin, "/command", {
      commandId: offer["commandId"],
      commandKind: "product_contract.propose_revision",
      correlationId: "e2e-gate1-propose",
      expectedVersion: offer["expectedVersion"],
      payload: { draft, goalRef: createdGoalId },
      requestDigest: "a".repeat(64),
      schemaVersion: "moe-runtime-command/1",
      sessionCredential: LANE_CREDENTIAL,
      targetAggregateId: offer["targetAggregateId"],
    });
    expect(proposed.status, `propose_revision:\n${proposed.text.slice(0, 800)}`).toBe(200);
    expect(isRecord(proposed.body) && proposed.body["ok"] !== false,
      `propose_revision refused:\n${proposed.text.slice(0, 800)}`).toBe(true);

    // The daemon's /1 read now holds the pending revision with a minted approval.
    const pendingBefore = await askDaemon(origin, "/product-contract/pending/read", { goalRef: createdGoalId });
    expect(pendingBefore.status, pendingBefore.text.slice(0, 400)).toBe(200);
    expect(isRecord(pendingBefore.body) ? pendingBefore.body["outcome"] : null,
      `pending read before approval:\n${pendingBefore.text.slice(0, 600)}`).toBe("PENDING");

    // 7. The browser opens the goal: the card renders THAT revision from the /1 route.
    await page.getByTestId(`cr.goals.card.${createdGoalId}.open`).click();
    const card = page.getByTestId("cr.gate1.card");
    await expect(card, "the Gate 1 card must render for the source-bound goal").toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("cr.gate1.requirement.req-1")).toContainText(REQUIREMENT);
    await expect(page.getByTestId("cr.gate1.criterion.crit-1")).toContainText(CRITERION);
    const approve = page.getByTestId("cr.gate1.approve");
    await expect(approve, "the daemon minted an approval, so Approve is offered").toBeEnabled();

    // 8. The human approves from the card. The daemon's V1 gate judges the minted
    //    identity and the durable HUMAN principal this session paired as; an
    //    accepted approval re-reads the same route, which now answers NONE.
    await approve.click();
    const settled = page.getByTestId("cr.gate1.approved").or(page.getByTestId("cr.gate1.dispatchrefusal"));
    await expect(settled).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("cr.gate1.dispatchrefusal"),
      `the approval was refused: ${await settled.textContent()}`).toHaveCount(0);
    await expect(page.getByTestId("cr.gate1.approved")).toBeVisible();

    const pendingAfter = await askDaemon(origin, "/product-contract/pending/read", { goalRef: createdGoalId });
    expect(isRecord(pendingAfter.body) ? pendingAfter.body["outcome"] : null,
      `pending read after approval:\n${pendingAfter.text.slice(0, 600)}`).toBe("NONE");
  } finally {
    for (const child of [...children].reverse()) await killTree(child);
    try {
      rmSync(scratch.root, { force: true, recursive: true });
    } catch {
      // A scratch dir that outlives its run is a few hundred KB in TEMP, never a fail.
    }
  }
  expect(await survivingPids(pids), "the lane must leave no orphan daemon").toEqual([]);
});
