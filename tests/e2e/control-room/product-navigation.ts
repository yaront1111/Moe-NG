import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Open the shipped disclosure before following a technical destination. */
export async function openTechnicalDestination(page: Page, destination: "health" | "resources"): Promise<void> {
  const toggle = page.getByRole("button", { name: "Technical tools", exact: true });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.getByTestId(`cr.nav.${destination}`).click();
}

/** Follow the visible product record tabs; retained hidden panels are never selectors. */
export async function openProductRecord(
  page: Page, record: "Definition" | "Build plan" | "Checks" | "Delivery" | "Technical detail",
): Promise<void> {
  const workspace = page.getByTestId("cr.product.workspace");
  const toggle = workspace.getByRole("button", { name: "Production record", exact: true });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const inspector = workspace.getByRole("complementary", { name: "Production record", exact: true });
  await inspector.getByRole("button", { name: record, exact: true }).click();
}

/** An already selected definition has one review instance, on its product canvas. */
export async function openProductDefinition(page: Page): Promise<void> {
  await openProductRecord(page, "Definition");
  const review = page.getByRole("button", { name: "Review definition", exact: true });
  if (await review.isVisible()) await review.click();
}
