import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { lanePids, survivingPids, withDaemonBackedControlRoom } from "./daemon-ports.js";
import { askDaemon, isRecord, pairBrowser } from "./live-proof-arms.js";

/**
 * The shipped contextual controls, from an empty store to a source-bound product.
 * The retired nine-click dev path authored plan bodies in the browser. Its daemon
 * finalize/approval invariants remain in bootstrap-finalize-journey.test.ts. Here
 * a browser activates, creates exact source bytes, and cannot approve unsealed work.
 */
const CHAIN = ["project.register", "project.bind_repository", "provider.probe", "policy.install",
  "policy.validate", "project.activate"] as const;
const TITLE = "Browser-created appointment product";
const PRD = "# Appointment product\n\nCustomers request a repair appointment. Preserve the chosen local date.\n";
const DIGEST = createHash("sha256").update(PRD).digest("hex");
const FILE = "appointments-prd.md";
interface Witness { readonly kind: string; readonly target: string; readonly version: number }
const offerKey = ({ kind, target, version }: Witness): string => `${kind}@${target}:v${version}`;
function witness(value: unknown): Witness | null {
  if (!isRecord(value) || typeof value["commandKind"] !== "string"
    || typeof value["targetAggregateId"] !== "string" || typeof value["expectedVersion"] !== "number") return null;
  return { kind: value["commandKind"], target: value["targetAggregateId"], version: value["expectedVersion"] };
}
async function fillDraft(page: Page): Promise<void> {
  await page.getByTestId("cr.goals.newgoal.title").fill(TITLE);
  await page.getByTestId("cr.goals.newgoal.outcome").fill("Customers can request a repair appointment without losing their chosen local date.");
  await page.getByText("Success criteria and constraints", { exact: true }).click();
  await page.getByTestId("cr.goals.newgoal.criteria").fill("The requested calendar date is preserved.");
  await page.getByTestId("cr.goals.newgoal.prd.input").setInputFiles({ buffer: Buffer.from(PRD), mimeType: "text/markdown", name: FILE });
  await expect(page.getByTestId("cr.goals.newgoal.prd.status")).toContainText(DIGEST);
}

test("an operator activates an empty project, creates exact source and cannot approve an unsealed product", async ({ page }, info) => {
  test.setTimeout(300_000);
  const posts: (Witness | null)[] = [];
  const offered = new Set<string>();
  const readings: Promise<void>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/command") return;
    try { posts.push(witness(JSON.parse(request.postData() ?? "null"))); } catch { posts.push(null); }
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== "/affordances/read") return;
    readings.push(response.json().then((body: unknown) => {
      const offers = isRecord(body) ? body["nextAllowedCommands"] : null;
      if (Array.isArray(offers)) for (const entry of offers) {
        const parsed = witness(entry); if (parsed !== null) offered.add(offerKey(parsed));
      }
    }, () => undefined));
  });
  const result = await withDaemonBackedControlRoom({ approval: "HUMAN", liveCredentials: "ABSENT",
    operatorChannel: true, seed: "NONE" }, async (lane) => {
    expect(lane.seedPid, "no server-side bootstrap seed ran").toBeNull();
    await page.goto(lane.baseUrl);
    await pairBrowser(page, lane);
    const initial = await askDaemon(lane, "/goals/read", {});
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ outcome: "GOALS", goals: [] });
    const newProduct = page.getByTestId("cr.goals.new");
    await expect(newProduct).toBeEnabled();
    await newProduct.click();
    await fillDraft(page);
    await page.getByTestId("cr.goals.newgoal.create").click();
    await expect(page.getByTestId("cr.goals.newgoal.report")).toContainText("goal.create_with_source is blocked until");
    expect(posts, "the prerequisite refusal must not dispatch a create").toEqual([]);
    await expect(page.getByTestId("cr.goals.newgoal.title")).toHaveValue(TITLE);
    await page.getByTestId("cr.goals.newgoal.cancel").click();

    await page.getByText("Project setup", { exact: true }).click();
    await expect(page.getByTestId("cr.activate.root")).toBeVisible();
    await page.getByTestId("cr.activate.button").click();
    for (const kind of CHAIN) {
      const row = page.getByTestId(`cr.activate.step.${kind}`);
      await expect(row).toHaveAttribute("data-ok", "true", { timeout: 120_000 });
      await expect(row, "accepted on this click, not already committed").toContainText("accepted");
    }
    expect(posts.map((post) => post?.kind)).toEqual(CHAIN);
    expect(posts[0]).toEqual({ kind: "project.register", target: lane.projectId, version: 0 });
    const activated = await askDaemon(lane, "/affordances/read", {});
    const steps = isRecord(activated.body) ? activated.body["steps"] : null;
    for (const kind of CHAIN) expect(Array.isArray(steps)
      && steps.some((step) => isRecord(step) && step["kind"] === kind && step["status"] === "COMMITTED"), kind).toBe(true);

    await newProduct.click();
    await fillDraft(page);
    await page.getByTestId("cr.goals.newgoal.create").click();
    await expect(page.getByTestId("cr.goals.newgoal.report")).toHaveText(`Goal created: ${TITLE}`);
    const catalog = await askDaemon(lane, "/goals/read", {});
    expect(catalog.status).toBe(200);
    const goals = isRecord(catalog.body) ? catalog.body["goals"] : null;
    expect(Array.isArray(goals) && goals.length).toBe(1);
    const goal = Array.isArray(goals) ? goals[0] : null;
    if (!isRecord(goal) || typeof goal["goalId"] !== "string" || typeof goal["planningRunRef"] !== "string") throw new Error("created goal/run binding absent");
    expect(goal).toMatchObject({ brief: { title: TITLE }, binding: { contentSha256: DIGEST, byteLength: Buffer.byteLength(PRD) } });
    expect(goal["goalId"]).not.toBe("goal-live-1");
    expect(goal["planningRunRef"]).not.toBe("run-live-1");
    const source = await askDaemon(lane, "/goals/source/read", { goalRef: goal["goalId"] });
    expect(source.status).toBe(200);
    expect(source.body).toMatchObject({ outcome: "GOAL_SOURCE", text: PRD, contentSha256: DIGEST, displayPath: FILE });
    await page.getByTestId(`cr.goals.card.${goal["goalId"]}.open`).click();
    const workspace = page.getByTestId("cr.product.workspace");
    await expect(workspace.getByRole("heading", { name: FILE })).toBeVisible();
    await expect(workspace.locator(".cr-product-source pre")).toHaveText(PRD);
    await page.screenshot({ path: info.outputPath("created-product-source.png"), animations: "disabled" });
    await workspace.getByRole("button", { name: "Production record", exact: true }).click();
    await expect(page.getByTestId("cr.approve.button")).toBeDisabled();
    await expect(page.getByTestId("cr.approve.reason")).toContainText("APPROVAL_AFFORDANCE_ABSENT");
    await expect(page.getByTestId("cr.approve.reason")).toContainText("CONTROL_ROOM_PLAN_APPROVAL");
    await workspace.getByRole("button", { name: "Technical detail", exact: true }).click();
    await expect(page.getByTestId("cr.board.subject")).toHaveAttribute("data-goal", goal["goalId"]);
    const finalSurface = await askDaemon(lane, "/affordances/read", {});
    expect(finalSurface.body).toMatchObject({ planningGoalRefs: { [goal["planningRunRef"]]: goal["goalId"] } });
    const finalOffers = isRecord(finalSurface.body) ? finalSurface.body["nextAllowedCommands"] : null;
    expect(Array.isArray(finalOffers)).toBe(true);
    expect(Array.isArray(finalOffers) && finalOffers.some((offer) => isRecord(offer)
      && offer["commandKind"] === "approval.decide_intent" && offer["targetAggregateId"] === goal["planningRunRef"])).toBe(false);
    await Promise.all(readings);
    expect(posts.map((post) => post?.kind)).toEqual([...CHAIN, "goal.create_with_source"]);
    expect(posts.at(-1)?.target).toBe(goal["goalId"]);
    for (const post of posts) {
      expect(post, "each command must parse to its own identity").not.toBeNull();
      if (post !== null) expect(offered.has(offerKey(post)), "each command spends a daemon-observed kind/target/version").toBe(true);
    }
    return { pids: lanePids(lane), goalId: goal["goalId"], runId: goal["planningRunRef"] };
  });
  expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
  if (result.ok) {
    expect(await survivingPids(result.value.pids), "teardown must leave no orphans").toEqual([]);
    info.annotations.push({ type: "product-chain", description: `six activation commits, exact source ${DIGEST}, bound ${result.value.goalId}/${result.value.runId}, approval withheld` });
  }
});
