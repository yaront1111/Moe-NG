import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { lanePids, survivingPids, withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";
async function pair(page: Page, lane: DaemonLane): Promise<void> {
  const label = page.getByLabel("Pairing confirmation label");
  await expect(label).toBeVisible({ timeout: 30000 });
  const value = (await label.textContent())?.trim() ?? "";
  expect(value).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u);
  expect(lane.approvePairing).not.toBeNull(); lane.approvePairing?.(value);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && await label.count() !== 0) {
    await page.getByRole("button", { name: "I entered this label" }).click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
  await expect(label).toHaveCount(0);
}
/** Route/render proof over the real daemon. The demo's workspace is not a Git repository and has no bound Product Contract. */
test("paired UI displays daemon recovery and criterion evidence without inventing a verified result", async ({ page }, testInfo) => {
  const result = await withDaemonBackedControlRoom({ liveCredentials: "ATTACHED", operatorChannel: true, seed: "SHIPPED" }, async (lane) => {
    const reads = new Map<string, number>();
    page.on("response", (response) => { const path = new URL(response.url()).pathname;
      if (path === "/repository/recovery/read" || path === "/criteria/read") reads.set(path, response.status()); });
    await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded" }); await pair(page, lane);
    await page.getByTestId("cr.nav.health").click({ timeout: 10000 });
    const recovery = page.getByTestId("cr.health.recovery");
    await expect(recovery).toContainText("REPOSITORY_IDENTITY_UNKNOWN", { timeout: 30000 });
    await expect(recovery.getByRole("button", { name: "Release unused reservation" })).toHaveCount(0);
    expect(reads.get("/repository/recovery/read")).toBe(200);
    await page.screenshot({ path: testInfo.outputPath("repository-recovery.png"), fullPage: true });
    await page.getByTestId("cr.nav.goals").click({ timeout: 10000 });
    await page.getByRole("button", { name: /^Open the board for /u }).first().click({ timeout: 30000 });
    const criteria = page.getByTestId("cr.criteria.card");
    await expect(criteria).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("cr.criteria.read-refusal")).toContainText("CRITERION_EVIDENCE", { timeout: 30000 });
    expect(reads.get("/criteria/read")).toBe(200);
    await expect(criteria.getByRole("button", { name: "Verify approved criteria" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("criterion-evidence.png"), fullPage: true });
    return lanePids(lane);
  });
  expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
  if (result.ok) expect(await survivingPids(result.value)).toEqual([]);
});
