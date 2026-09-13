import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { withStaticControlRoom } from "./harness.js";
import { productWorkspacePorts } from "./product-workspace-ports.js";

/** Browser interaction evidence over explicit examples; no live command acceptance is claimed. */
async function fitsShell(page: Page): Promise<void> {
  for (const selector of ["html", ".cr2-shell", ".cr2-navrail", ".cr2-contextbar", ".cr2-main", ".cr-product-workspace"]) {
    const element = page.locator(selector);
    if (await element.count() === 0) continue;
    const dimensions = await element.evaluate((node) => ({ width: node.clientWidth, content: node.scrollWidth }));
    expect(dimensions.content, `${selector} must not overflow horizontally`).toBeLessThanOrEqual(dimensions.width + 1);
  }
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
}

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }]) {
  test(`product workspace examples preserve meaning and navigation at ${viewport.name} width`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const requests: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => { if (request.method() !== "GET") requests.push(request.method() + " " + new URL(request.url()).pathname); });
    page.on("pageerror", (error) => errors.push(error.message));
    const result = await withStaticControlRoom(productWorkspacePorts(), async (baseUrl) => {
      await page.goto(`${baseUrl}?fixtures=1`);
      await expect(page.getByRole("heading", { name: "Your products" })).toBeVisible();
      await capture(page, info, "products-home");
      await fitsShell(page);
      const technicalTools = page.getByRole("button", { name: "Technical tools", exact: true });
      await technicalTools.click();
      await expect(technicalTools).toHaveAttribute("aria-expanded", "true");
      await fitsShell(page);
      await technicalTools.click();
      await expect(technicalTools).toHaveAttribute("aria-expanded", "false");

      await page.getByRole("button", { name: "Open product Bicycle shop appointments", exact: true }).click();
      const workspace = page.getByTestId("cr.product.workspace");
      await expect(workspace).toBeVisible();
      await expect(page.getByRole("heading", { name: "Appointment product requirements" })).toBeVisible();
      await expect(page.getByText(/Example product\. These states/u)).toBeVisible();
      expect(new URL(page.url()).searchParams.get("product")).toBe("goal-j1");
      await capture(page, info, "product-source");
      await fitsShell(page);
      const viewing = workspace.getByLabel("Viewed product artifact");
      await viewing.selectOption("example:design");
      await expect(workspace.getByRole("heading", { name: "Screens and journeys" })).toBeVisible();
      await expect(workspace.getByRole("img")).toHaveCount(0);
      await capture(page, info, "product-design");
      await fitsShell(page);
      await viewing.selectOption("example:source");

      const requirements = workspace.getByRole("button", { name: "Requirements", exact: true });
      await requirements.click();
      const inspector = workspace.getByRole("complementary", { name: "Requirements", exact: true });
      await expect(inspector).toBeFocused();
      await inspector.getByRole("button", { name: /Appointment dates stay on the chosen day/u }).click();
      await expect(inspector.getByRole("heading", { name: "The request date is unchanged near midnight" })).toBeVisible();
      await capture(page, info, "product-requirements");
      await fitsShell(page);
      await page.keyboard.press("Escape");
      await expect(inspector).toHaveCount(0);
      await expect(requirements).toBeFocused();

      await page.getByRole("button", { name: "Failed check", exact: true }).click();
      await expect(workspace.getByText("1 of 2 criterion checks passed for this candidate")).toBeVisible();
      await page.getByRole("button", { name: "Corrected candidate", exact: true }).click();
      await expect(workspace.getByText("2 of 2 criterion checks passed for this candidate")).toBeVisible();
      await capture(page, info, "product-corrected");
      await viewing.selectOption("example:build:failed");
      await expect(workspace.getByText("1 of 2 criterion checks passed for this candidate")).toBeVisible();
      expect(new URL(page.url()).searchParams.get("artifact")).toBe("example:build:failed");
      await page.goBack();
      await expect(viewing).toHaveValue("example:build:corrected");
      await page.reload();
      await expect(workspace).toBeVisible();
      await expect(viewing).toHaveValue("example:build:corrected");
      await expect(workspace.getByText("2 of 2 criterion checks passed for this candidate")).toBeVisible();

      await page.getByRole("button", { name: "Scope change", exact: true }).click();
      await expect(workspace.getByRole("button", { name: /Customers can pay online/u })).toBeVisible();
      await expect(workspace.getByText("A released version is available")).toBeVisible();
      await viewing.selectOption("example:release");
      await expect(workspace.getByRole("button", { name: /Customers can pay online/u })).toHaveCount(0);
      await workspace.getByRole("button", { name: "Product", exact: true }).click();
      await expect(workspace.getByText("Released source", { exact: true })).toBeVisible();
      await viewing.selectOption("example:preview");
      await expect(workspace.getByRole("heading", { name: "This version cannot be read right now" })).toBeVisible();
      await expect(workspace.getByRole("img")).toHaveCount(0);
      await fitsShell(page);
      const backToProducts = page.getByTestId("cr.shell.contextbar").getByRole("button", { name: "Products", exact: true });
      await backToProducts.focus();
      await expect(backToProducts).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Your products" })).toBeVisible();
      await page.goBack();
      await expect(workspace).toBeVisible();
      await expect(viewing).toHaveValue("example:preview");
      await expect(page.getByTestId("cr.shell.context.title")).toHaveText("Bicycle shop appointments");
      await page.getByTestId("cr.nav.goals").click();
      await expect(page.getByRole("heading", { name: "Your products" })).toBeVisible();
      expect(new URL(page.url()).searchParams.has("product")).toBe(false);
      expect(requests).toEqual([]);
      expect(errors).toEqual([]);
      return "fixture-interactions-verified";
    });
    expect(result).toEqual({ ok: true, value: "fixture-interactions-verified" });
  });
}
