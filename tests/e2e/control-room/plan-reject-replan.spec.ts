import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.js";
import { killTree, spawnNode, survivingPids } from "./daemon-children.js";
import {
  LANE_CREDENTIAL, LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot, seedEnv,
} from "./daemon-ports.js";
import { readGoalCatalogOverHttp } from "./prd-boundary-readers.js";

/**
 * SENDING A PLAN BACK, END TO END, against a REAL daemon hosting the REAL bundle.
 *
 * WHAT THIS PROVES that no unit test can. The reject is a WRITE the daemon must
 * accept from a paired browser, and the re-plan that follows moves the approval offer
 * onto a run the browser was never told about at open time. Everything between those
 * two facts - the payload the generated builder composes, the daemon's acceptance, the
 * successor the compiler mints, and the gate re-binding to it - is only exercised
 * together here.
 *
 *   1. build the bundle, start the daemon hosting it, seed the project, pair by handshake;
 *   2. the operator creates a goal from a PRD in the browser;
 *   3. a planner proposes a /1 revision through the daemon's OWN offer, and the operator
 *      approves Gate 1 from the card;
 *   4. a SCRIPTED SEAT compiles the plan (`planning.submit_decomposition`), exactly as an
 *      agent seat would, so the run reaches PLAN_REVIEW un-approved and the daemon offers
 *      `approval.decide_intent` for it;
 *   5. THE OPERATOR REJECTS IT IN THE BROWSER, with a reason typed into the gate;
 *   6. the scripted seat RESUBMITS - and the daemon routes that submission to the
 *      SUCCESSOR run it minted from the rejection, not back to the rejected one;
 *   7. the gate re-binds to the SUCCESSOR and the operator's approve dispatches against it.
 *      DISCLOSED: that approve is NOT committed - it reaches a project-policy precondition
 *      (APPROVAL_INTENT_POLICY_REF_UNAVAILABLE) unrelated to sending a plan back, because a
 *      policy slice cannot be reused for a second approval in one seeded project. The code
 *      is asserted rather than the outcome, and the dead-run fence is asserted ABSENT, which
 *      is what proves the binding moved. See the comment at the assertion.
 *   7. THE OPERATOR APPROVES THE SUCCESSOR IN THE BROWSER, and the run id that reaches
 *      the daemon is asserted to be the successor.
 *
 * NOTHING IS STUBBED. Every offer is read off `/affordances/read` and dispatched
 * verbatim; no approval identity is composed here, because the daemon mints the
 * human-review witness from the authenticated principal.
 */

const DAEMON_READY_MS = 60_000;
const SEED_MS = 90_000;
const BUILD_MS = 180_000;
const ORIGIN_LINE = /listening on (http:\/\/127\.0\.0\.1:\d+)/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;

const PRD_NAME = "reject-prd.md";
const PRD_TEXT = "# Recover the store\n\nThe store must recover from a fresh genesis.\n";
const PRD_SHA256 = createHash("sha256").update(PRD_TEXT, "utf8").digest("hex");
const GOAL_TITLE = "Plan reject lane goal";
const GOAL_OUTCOME = "A human sends the compiled plan back and approves its successor.";
const REQUIREMENT = "The store recovers from a fresh genesis.";
const CRITERION = "A cold start over an empty directory answers READY.";
const REJECT_REASON = "One slice is not enough; split the recovery from the read path.";

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

/** A seat-side POST: the lane's operator credential, every header the listener fences on. */
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

/**
 * The plan lives inside the goal page's `<details>` fold, which cordum-app opens BY ITSELF
 * only while the daemon is offering a decision. In the sent-back state it is deliberately
 * closed, so the journey opens it the way a person would - by clicking the summary - rather
 * than reloading, which would drop the in-app route and the pairing with it.
 */
async function openPlanFold(page: Page): Promise<void> {
  const fold = page.getByTestId("cr.goal.planfold");
  await expect(fold).toBeAttached({ timeout: 60_000 });
  if (await fold.evaluate((node) => (node as HTMLDetailsElement).open)) return;
  // Direct child only: the refusal notes inside the fold are themselves `<details>`.
  await fold.locator("> summary").click();
  await expect(page.getByTestId("cr.approve.screen")).toBeVisible({ timeout: 30_000 });
}

/** Every offer the surface states, as `commandKind@target`, for a legible failure message. */
function offerPairs(offers: readonly unknown[]): string {
  return offers.map((row) => isRecord(row)
    ? `${String(row["commandKind"])}@${String(row["targetAggregateId"])}` : "?").join(", ");
}

async function surfaceOffers(origin: string): Promise<readonly unknown[]> {
  const surface = await askDaemon(origin, "/affordances/read", {});
  expect(surface.status, `affordance surface:\n${surface.text.slice(0, 600)}`).toBe(200);
  return isRecord(surface.body) && Array.isArray(surface.body["nextAllowedCommands"])
    ? surface.body["nextAllowedCommands"] as readonly unknown[] : [];
}

async function offerOf(
  origin: string, commandKind: string, target: string,
): Promise<Readonly<Record<string, unknown>>> {
  const offers = await surfaceOffers(origin);
  const offer = offers.find((row) => isRecord(row)
    && row["commandKind"] === commandKind && row["targetAggregateId"] === target);
  expect(offer, `no ${commandKind} offer for ${target} among ${offerPairs(offers)}`).toBeDefined();
  if (!isRecord(offer)) throw new Error(`unreachable: ${commandKind}@${target}`);
  return offer;
}

/** The run the daemon currently binds to this goal, read off `planningGoalRefs` by inversion. */
async function currentRunOverHttp(origin: string, goalId: string): Promise<string | null> {
  const surface = await askDaemon(origin, "/affordances/read", {});
  const refs = isRecord(surface.body) ? surface.body["planningGoalRefs"] : null;
  if (!isRecord(refs)) return null;
  const bound = Object.keys(refs).filter((runId) => refs[runId] === goalId);
  return bound.length === 1 ? bound[0] ?? null : null;
}

const NODE_SCOPES = Object.freeze({
  capability: "capability-implement",
  readScopes: ["services/api/src"],
  resources: ["resource-a"],
  verificationRecipeRefs: ["recipe-a"],
  writeScopes: ["services/api/src/node"],
});

/**
 * The scripted seat's compile, dispatched through the daemon's own offer. The successor
 * carries a DIFFERENT node key so the second submission cannot be mistaken for a replay
 * of the first.
 */
async function compile(
  origin: string, goalId: string, gateRef: Readonly<Record<string, unknown>>,
  nodeKey: string, correlationId: string,
): Promise<DaemonAnswer> {
  const offer = await offerOf(origin, "planning.submit_decomposition", goalId);
  return askDaemon(origin, "/command", {
    commandId: offer["commandId"],
    commandKind: "planning.submit_decomposition",
    correlationId,
    expectedVersion: offer["expectedVersion"],
    payload: {
      gateRef,
      goalRef: goalId,
      structure: {
        completionNodeKey: nodeKey,
        nodes: [{
          ...NODE_SCOPES, criterionIds: ["crit-1"], dependsOn: [], nodeKey,
          objective: `Land the ${nodeKey} slice.`,
        }],
      },
    },
    requestDigest: "b".repeat(64),
    schemaVersion: "moe-runtime-command/1",
    sessionCredential: LANE_CREDENTIAL,
    targetAggregateId: offer["targetAggregateId"],
  });
}

test("the operator sends a plan back in the browser and the gate follows the successor the daemon compiles", async ({ page }) => {
  test.setTimeout(420_000);
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

    // 4. Pair through the real runtime handshake: no baked secret, no URL authority.
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    const labelOutput = page.getByLabel("Pairing confirmation label");
    await expect(labelOutput).toBeVisible({ timeout: 20_000 });
    const confirmationLabel = (await labelOutput.textContent())?.trim() ?? "";
    expect(confirmationLabel).toMatch(CONFIRMATION_LABEL);
    expect(daemon.child.stdin, "the explicit operator pipe must exist").not.toBeNull();
    daemon.child.stdin?.write(`${confirmationLabel}\n`);
    await page.getByRole("button", { name: "I entered this label" }).click();
    await expect(page.getByTestId("cr.goals.home")).toBeVisible({ timeout: 60_000 });

    // 5. The operator creates a goal from a PRD; the goal binds the PRD's sha.
    await page.getByTestId("cr.goals.new").click();
    await expect(page.getByTestId("cr.goals.newgoal.form")).toBeVisible();
    await page.getByTestId("cr.goals.newgoal.title").fill(GOAL_TITLE);
    await page.getByTestId("cr.goals.newgoal.outcome").fill(GOAL_OUTCOME);
    await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({
      buffer: Buffer.from(PRD_TEXT, "utf8"), mimeType: "text/markdown", name: PRD_NAME,
    });
    await page.getByTestId("cr.goals.newgoal.create").click();

    let found: string | null = null;
    await expect.poll(async () => {
      const catalog = await readGoalCatalogOverHttp(origin, root, LANE_CREDENTIAL, LANE_CSRF_TOKEN);
      if (!("goals" in catalog)) return null;
      found = catalog.goals.find((row) => row.binding?.contentSha256 === PRD_SHA256)?.goalId ?? null;
      return found;
    }, { message: "the created goal must appear in the daemon's catalog", timeout: 30_000 })
      .not.toBeNull();
    if (found === null) return;
    const goalId: string = found;

    // 6. A planner proposes a /1 revision through the daemon's OWN offer.
    const proposeOffer = await offerOf(origin, "product_contract.propose_revision", goalId);
    const draft = {
      authorRef: "planner-e2e",
      contractId: "contract-reject-lane",
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
      commandId: proposeOffer["commandId"],
      commandKind: "product_contract.propose_revision",
      correlationId: "e2e-reject-propose",
      expectedVersion: proposeOffer["expectedVersion"],
      payload: { draft, goalRef: goalId },
      requestDigest: "a".repeat(64),
      schemaVersion: "moe-runtime-command/1",
      sessionCredential: LANE_CREDENTIAL,
      targetAggregateId: proposeOffer["targetAggregateId"],
    });
    expect(proposed.status, `propose_revision:\n${proposed.text.slice(0, 800)}`).toBe(200);

    // The gate ref the DAEMON derived, captured while the revision is still PENDING - the
    // same read answers NONE once approved, so it has to be taken now. Never recomputed
    // locally: a locally hashed digest would drift from the daemon's canonical bytes and
    // the compile would refuse for a reason that has nothing to do with this journey.
    const pending = await askDaemon(origin, "/product-contract/pending/read", { goalRef: goalId });
    expect(isRecord(pending.body) ? pending.body["outcome"] : null,
      `pending read:\n${pending.text.slice(0, 600)}`).toBe("PENDING");
    const heldRef = isRecord(pending.body) ? pending.body["ref"] : null;
    expect(isRecord(heldRef), `the pending read must state its ref:\n${pending.text.slice(0, 600)}`)
      .toBe(true);
    if (!isRecord(heldRef)) return;
    const compileGateRef: Readonly<Record<string, unknown>> = heldRef;

    // 7. The operator approves Gate 1 from the card, so the compiler has a gate to cite.
    await page.getByTestId(`cr.goals.card.${goalId}.open`).click();
    const card = page.getByTestId("cr.gate1.card");
    await expect(card, "the Gate 1 card must render for the source-bound goal")
      .toBeVisible({ timeout: 30_000 });
    await page.getByTestId("cr.gate1.approve").click();
    await expect(page.getByTestId("cr.gate1.approved")).toBeVisible({ timeout: 30_000 });

    // The DAEMON's confirmation that the gate really committed, not the card's word for it:
    // the pending read retires to NONE. Without this, a
    // PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT from the compile below would be ambiguous
    // between a bad gate ref and a gate that never landed.
    await expect.poll(async () => {
      const after = await askDaemon(origin, "/product-contract/pending/read", { goalRef: goalId });
      return isRecord(after.body) ? after.body["outcome"] : null;
    }, { message: "Gate 1 must commit before the compiler can cite it", timeout: 30_000 })
      .toBe("NONE");

    // 8. A SCRIPTED SEAT compiles the plan against the APPROVED gate. The run reaches
    //    PLAN_REVIEW un-approved, so the daemon offers `approval.decide_intent` for it -
    //    the grant the gate spends.
    const firstCompile = await compile(origin, goalId, compileGateRef, "node-one", "e2e-reject-compile-1");
    expect(firstCompile.status, `first compile:\n${firstCompile.text.slice(0, 900)}`).toBe(200);
    expect(isRecord(firstCompile.body) && firstCompile.body["ok"] !== false,
      `first compile refused:\n${firstCompile.text.slice(0, 900)}`).toBe(true);

    const rejectedRunId = await currentRunOverHttp(origin, goalId);
    expect(rejectedRunId, "the compiled run must be bound to the goal").not.toBeNull();
    if (rejectedRunId === null) return;
    // CONTROL, before the reject: the daemon really is offering this run for approval.
    // Without it, "no decide_intent after the reject" could be green on a run that was
    // never offered at all.
    await offerOf(origin, "approval.decide_intent", rejectedRunId);

    // 9. THE OPERATOR SENDS THE PLAN BACK, in the browser, with a reason. NO RELOAD: the
    //    board polls the surface every 2s, so the grant arrives in the page the operator is
    //    already on - which is also the only way to keep the paired session.
    await openPlanFold(page);
    const rejectButton = page.getByTestId("cr.approve.reject");
    await expect(rejectButton).toBeVisible({ timeout: 60_000 });
    // The browser's OWN fence, before any round trip: no reason typed, nothing to send.
    await expect(rejectButton).toBeDisabled();
    await page.getByTestId("cr.approve.reason.input").fill(REJECT_REASON);
    await expect(rejectButton).toBeEnabled();
    await rejectButton.click();

    // The DAEMON accepted it: the rejected run is bound to nothing and a SUCCESSOR is.
    let successorRunId: string | null = null;
    await expect.poll(async () => {
      const current = await currentRunOverHttp(origin, goalId);
      successorRunId = current === rejectedRunId ? null : current;
      return successorRunId;
    }, { message: "the reject must move the goal onto a successor run", timeout: 60_000 })
      .not.toBeNull();
    if (successorRunId === null) return;
    // Captured before any narrowing: the poll assigns inside a closure, so TypeScript's
    // control flow cannot see the write and would otherwise narrow this to `never`.
    const successor: string = successorRunId;
    expect(successor).not.toBe(rejectedRunId);
    // The rejected run is offered under NO kind: set-equality, because the defect here is
    // an offer that should have DISAPPEARED and `not.toContain` cannot see it.
    const afterReject = await surfaceOffers(origin);
    expect(afterReject.filter((row) => isRecord(row) && row["targetAggregateId"] === rejectedRunId)
      .map((row) => isRecord(row) ? String(row["commandKind"]) : "?")).toEqual([]);

    // The gate follows the successor: it says so, and offers no decision yet. The fold
    // closes itself once the grant is gone, so it is reopened the way a person would.
    await openPlanFold(page);
    await expect(page.getByTestId("cr.approve.sent-back"))
      .toHaveText("Plan sent back - waiting for a new plan", { timeout: 60_000 });
    await expect(page.getByTestId("cr.approve.button")).toHaveCount(0);

    // 10. The scripted seat RESUBMITS. The daemon routes it to the SUCCESSOR.
    const secondCompile = await compile(origin, goalId, compileGateRef, "node-two", "e2e-reject-compile-2");
    expect(secondCompile.status, `second compile:\n${secondCompile.text.slice(0, 900)}`).toBe(200);
    expect(await currentRunOverHttp(origin, goalId)).toBe(successor);
    await offerOf(origin, "approval.decide_intent", successor);

    // 11. THE OPERATOR APPROVES THE SUCCESSOR in the browser, in the same session.
    await openPlanFold(page);
    const approveButton = page.getByTestId("cr.approve.button");
    await expect(approveButton).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByTestId("cr.approve.sent-back")).toHaveCount(0);
    await approveButton.click();
    const settled = page.getByTestId("cr.approve.applied")
      .or(page.getByTestId("cr.approve.dispatch-refusal"));
    await expect(settled).toBeVisible({ timeout: 60_000 });

    /**
     * THE ASSERTION THIS JOURNEY EXISTS FOR, and it is a REASON CODE rather than an outcome.
     *
     * The approve dispatched on the successor reaches a PROJECT-POLICY precondition that has
     * nothing to do with sending a plan back: `deriveApplicablePolicyRef`
     * (approval-policy-ref.ts:85) needs a `PolicyEvaluated` whose slice was not already
     * spent, and `policyWasReused` (:104) refuses a reuse - so a SECOND approval inside one
     * seeded project needs a fresh `policy.install` + `policy.validate` pair with a
     * node-bound subject. The daemon therefore answers
     * APPROVAL_INTENT_POLICY_REF_UNAVAILABLE @ DAEMON_APPROVAL_INTENT. That is disclosed, not
     * papered over: the run is NOT approved at the end of this journey.
     *
     * WHY THE CODE IS THE PROOF ANYWAY. Had the gate still been bound to the run the
     * operator rejected, this dispatch would have been refused by a DIFFERENT authority
     * FIRST - `APPROVAL_RUN_NOT_REVIEWABLE @ APPROVAL_RUN_BINDING`
     * (approval-run-binding.ts:151 via approval-intent.ts:252), the daemon's fence on a dead
     * run. Reaching the POLICY fact at all means the run binding was ACCEPTED, which is
     * exactly the thing this row owns. Both codes are asserted - the one that must appear and
     * the one that must not - because "it was refused" alone would be satisfied by the very
     * bug this journey is here to catch.
     */
    const refusalText = (await page.getByTestId("cr.approve.dispatch-refusal").textContent()) ?? "";
    expect(refusalText, "the run binding must be ACCEPTED, so the dead-run fence must not answer")
      .not.toContain("APPROVAL_RUN_NOT_REVIEWABLE");
    expect(refusalText, "the run binding must be ACCEPTED, so the dead-run fence must not answer")
      .not.toContain("APPROVAL_RUN_BINDING");
    expect(refusalText).toContain("APPROVAL_INTENT_POLICY_REF_UNAVAILABLE");

    // And the daemon's own decision log: the REJECT the operator made in this browser is
    // COMMITTED against the run they were reading, and nothing was ever committed against
    // the successor. Set-equality over every committed intent for this goal.
    await expect.poll(async () => {
      const activity = await askDaemon(origin, "/activity/read", { goalRef: goalId });
      const entries = isRecord(activity.body) && Array.isArray(activity.body["entries"])
        ? activity.body["entries"] as readonly unknown[] : [];
      return entries.filter((row) => isRecord(row)
        && row["commandKind"] === "approval.decide_intent"
        && row["disposition"] === "COMMITTED")
        .map((row) => isRecord(row) ? `${String(row["verdict"])}@${String(row["targetAggregateId"])}` : "?")
        .sort();
    }, { message: "the browser's REJECT must be the one committed intent on this goal", timeout: 60_000 })
      .toEqual([`REJECT@${rejectedRunId}`]);
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
