import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { lanePids, survivingPids, withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";
import { askDaemon, isRecord, pairBrowser } from "./live-proof-arms.js";

/** Real seeded source, runtime pairing and contextual technical proof; no legacy UI selector. */
async function assertDaemonProduct(page: Page, lane: DaemonLane): Promise<void> {
  // The retired selector is a mutation: it must still enter the current pairing flow.
  await page.goto(`${lane.baseUrl}?v1=1`);
  await pairBrowser(page, lane);
  const catalog = await askDaemon(lane, "/goals/read", {});
  expect(catalog.status).toBe(200);
  expect(isRecord(catalog.body) && catalog.body["outcome"]).toBe("GOALS");
  const goals = isRecord(catalog.body) ? catalog.body["goals"] : null;
  expect(Array.isArray(goals) && goals.length).toBe(1);
  const goal = Array.isArray(goals) ? goals[0] : null;
  if (!isRecord(goal) || typeof goal["goalId"] !== "string" || typeof goal["planningRunRef"] !== "string") {
    throw new Error("daemon catalog did not carry the seeded goal and run");
  }
  await page.getByTestId(`cr.goals.card.${goal["goalId"]}.open`).click();
  const workspace = page.getByTestId("cr.product.workspace");
  await expect(workspace).toBeVisible();
  await workspace.getByRole("button", { name: "Production record", exact: true }).click();
  await workspace.getByRole("button", { name: "Technical detail", exact: true }).click();
  const card = page.locator(`[data-card-id="node.deliver@${lane.nodeRef}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("cr.board.column.ready").locator(`[data-card-id="node.deliver@${lane.nodeRef}"]`)).toHaveCount(1);
  await expect(page.getByTestId("cr.board.subject")).toHaveAttribute("data-goal", goal["goalId"]);
  await expect(card).toContainText(lane.nodeRef);

  const surface = await askDaemon(lane, "/affordances/read", {});
  expect(surface.status).toBe(200);
  const steps = isRecord(surface.body) ? surface.body["steps"] : null;
  const matching = Array.isArray(steps) ? steps.filter((step) => isRecord(step) && step["aggregateId"] === lane.nodeRef) : [];
  expect(matching).toHaveLength(1);
  const seeded = matching[0];
  expect(seeded).toMatchObject({ aggregateId: lane.nodeRef, kind: "node.deliver", status: "READY" });
  await card.getByRole("button", { name: /Inspect the receipt/u }).click();
  const proof = page.getByTestId("cr.shell.inspector");
  await expect(proof).toBeVisible();
  await expect(proof.locator('[data-truth-class="OBSERVED"]')).toHaveCount(1);
  for (const [key, value] of [["SOURCE", "POST /affordances/read"], ["TARGET", lane.nodeRef],
    ["STATUS", "READY"], ["VERSION", String(isRecord(seeded) ? seeded["version"] : "absent")]] as const) {
    const row = proof.locator(".cr2-proof-row").filter({ has: page.getByText(key, { exact: true }) });
    await expect(row.locator(".cr2-proof-row-v")).toHaveText(value);
  }
  await expect(page.getByTestId("cr.shell.root")).toHaveCount(0);
  await expect(page.getByText(/Example product\. These states/u)).toHaveCount(0);
}

test("the product's technical record shows the daemon's own seeded node and observed proof", async ({ page }, info) => {
  const live = await withDaemonBackedControlRoom({ liveCredentials: "ABSENT", operatorChannel: true }, async (lane) => {
    expect(lane.daemonPid).toBeGreaterThan(0);
    expect(lane.daemonPid).not.toBe(lane.serverPid);
    expect(await survivingPids([lane.daemonPid])).toEqual([lane.daemonPid]);
    await assertDaemonProduct(page, lane);
    // The marker's absence above is nonvacuous: the same development app can show examples.
    await page.goto(`${lane.baseUrl}?v1=1&fixtures=1`);
    await page.getByRole("button", { name: "Open product Bicycle shop appointments", exact: true }).click();
    await expect(page.getByText(/Example product\. These states/u)).toBeVisible();
    await expect(page.locator(`[data-card-id="node.deliver@${lane.nodeRef}"]`)).toHaveCount(0);
    info.annotations.push({ type: "daemon-lane", description: `seeded ${lane.nodeRef}; paired runtime session; no environment credential` });
    return lanePids(lane);
  });
  expect(live.ok ? "ok" : `${live.code}: ${live.detail}`).toBe("ok");
  if (live.ok) expect(await survivingPids(live.value), "teardown must leave no orphans").toEqual([]);

  // Credentials in environment variables cannot bypass a missing operator channel.
  const refused = await withDaemonBackedControlRoom({ liveCredentials: "ATTACHED" }, async (lane) => {
    await page.goto(`${lane.baseUrl}?v1=1`);
    await expect(page.getByRole("region", { name: "Pairing unavailable" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Moe was started without a terminal it can listen on/u)).toBeVisible();
    await expect(page.getByTestId("cr.product.workspace")).toHaveCount(0);
    await expect(page.getByLabel("Pairing confirmation label")).toHaveCount(0);
    await expect(page.getByText(/Example product\. These states/u)).toHaveCount(0);
    return lanePids(lane);
  });
  expect(refused.ok ? "ok" : `${refused.code}: ${refused.detail}`).toBe("ok");
  if (refused.ok) expect(await survivingPids(refused.value)).toEqual([]);
});
