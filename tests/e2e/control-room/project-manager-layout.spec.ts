import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { withStaticControlRoom } from "./harness.js";
import { buildBundle, createStaticControlRoomPorts } from "./static-ports.js";

/** Real production entry and CSS, explicit HTTP response fixtures. These tests
 * certify layout only: no manager process, catalog, pairing approval or project
 * operation is involved. The private static server binds an ephemeral port. */
const SCHEMA = "moe-project-manager/1";
const FIRST_TITLE = "Customer appointments and follow-up reminders across multiple locations";
const PROJECTS = Array.from({ length: 8 }, (_, index) => ({
  instanceId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  lifecycle: index === 0 ? "RUNNING" : "STOPPED",
  projectId: `layout-project-${index + 1}`,
  root: `C:\\work\\${"long-project-folder-name-".repeat(4)}${index + 1}`,
  title: index === 0 ? FIRST_TITLE : `Layout project ${index + 1}`,
}));

test.beforeAll(async () => {
  expect(await buildBundle(), "build the real production bundle before any layout observation").toBe(true);
});

async function withManager(page: Page, mode: "PAIRING" | "READY" | "UNAVAILABLE",
  body: (failRefresh: () => void) => Promise<void>): Promise<void> {
  const ready = mode === "READY";
  const errors: string[] = [], unexpected: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const result = await withStaticControlRoom({
    ...createStaticControlRoomPorts(), buildBundle: async () => true,
  }, async (baseUrl) => {
    // The production manager selector uses this hostname. Every request to this
    // exact test origin is intercepted; assets come from our own static server.
    const origin = new URL(baseUrl);
    origin.hostname = "127.0.0.2";
    let refuseRefresh = false;
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin.origin) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort(); return;
      }
      if (url.pathname === "/manager/bootstrap" && request.method() === "GET") {
        await route.fulfill({ json: { authenticated: ready, csrfToken: "layout-fixture-csrf", schemaVersion: SCHEMA } });
      } else if (!ready && url.pathname === "/manager/session/pair/request" && request.method() === "POST") {
        await route.fulfill(mode === "UNAVAILABLE"
          ? { status: 403, json: { code: "OPERATOR_CHANNEL_UNAVAILABLE", layer: "PROJECT_MANAGER_HTTP", ok: false } }
          : { json: { confirmationLabel: "1234-5678-abcd", ok: true, requestId: "a".repeat(64) } });
      } else if (ready && url.pathname === "/manager/projects" && request.method() === "GET") {
        await route.fulfill(refuseRefresh ? { status: 503, json: { unavailable: true } }
          : { json: { projects: PROJECTS, schemaVersion: SCHEMA } });
      } else if (url.pathname.startsWith("/manager/") || request.method() !== "GET") {
        unexpected.push(`${request.method()} ${url.pathname}`);
        await route.abort();
      } else {
        await route.fulfill({ response: await route.fetch({ url: new URL(url.pathname + url.search, baseUrl).href }) });
      }
    });
    await page.goto(origin.href);
    await expect(page.getByTestId("cr.manager.root")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await body(() => { refuseRefresh = true; });
    expect(unexpected, "layout tests must not dispatch manager operations or contact other origins").toEqual([]);
    expect(errors).toEqual([]);
    return "manager-layout-observed";
  });
  expect(result).toEqual({ ok: true, value: "manager-layout-observed" });
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
}

async function headerAndWidth(page: Page): Promise<void> {
  const mark = await page.locator(".cr2-brand-mark").boundingBox();
  expect.soft(mark?.y, "the manager brand belongs in the top header").toBeLessThan(64);
  await expect.soft(page.getByRole("banner")).toBeVisible();
  await expect.soft(page.locator(".cr2-brand-name")).toBeInViewport({ ratio: 1 });
  await expect.soft(page.locator(".cr2-brand-version")).toBeVisible();
  const columns = await page.getByTestId("cr.manager.root").evaluate((node) =>
    getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/u));
  expect.soft(columns, "the manager must not reserve the workspace's empty sidebar column").toHaveLength(1);
  for (const selector of ["html", ".cr2-manager-root", "main", ".cr2-project-row", ".cr2-pairing-card"]) {
    for (const element of await page.locator(selector).all()) {
      const dimensions = await element.evaluate((node) => ({ width: node.clientWidth, content: node.scrollWidth }));
      expect.soft(dimensions.content, `${selector} must wrap within its available width`).toBeLessThanOrEqual(dimensions.width + 1);
    }
  }
}

async function recordButtonFont(page: Page, info: TestInfo): Promise<void> {
  const computed = await page.locator(".cr2-pairing-card button").evaluate((node) => {
    const style = getComputedStyle(node);
    return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight };
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const document = await cdp.send("DOM.getDocument");
    const button = await cdp.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: ".cr2-pairing-card button" });
    const rendered = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: button.nodeId });
    const path = info.outputPath("pairing-button-font.json");
    await writeFile(path, JSON.stringify({ computed, rendered }, null, 2));
    await info.attach("pairing-button-font.json", { path, contentType: "application/json" });
  } finally { await cdp.detach(); }
}

async function wheelTo(page: Page, target: Locator): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("explicit viewport required");
  await page.mouse.move(viewport.width / 2, viewport.height - 80);
  const box = await target.boundingBox();
  if (box === null) throw new Error("scroll target is not rendered");
  await page.mouse.wheel(0, Math.max(0, box.y - viewport.height / 2));
  await expect.soft(target, "the user must reach the complete control by scrolling").toBeInViewport({ ratio: 1 });
}

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }]) {
  test(`manager pairing keeps its header and full content width at ${viewport.name} size`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await withManager(page, "PAIRING", async () => {
      await expect(page.getByRole("heading", { name: "Pair this browser with Moe Projects" })).toBeVisible();
      await capture(page, info, "pairing");
      await recordButtonFont(page, info);
      await headerAndWidth(page);
      const card = await page.locator(".cr2-pairing-card").boundingBox();
      expect.soft(Math.abs((card?.x ?? 0) + (card?.width ?? 0) / 2 - viewport.width / 2),
        "pairing must be centered on the page, with no reserved sidebar").toBeLessThanOrEqual(2);
    });
  });

  test(`manager READY keeps a long ledger and refresh error reachable at ${viewport.name} size`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await withManager(page, "READY", async (failRefresh) => {
      await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
      await expect(page.getByTestId("cr.projects.list").getByRole("listitem")).toHaveCount(8);
      const initialMain = await page.getByRole("main").boundingBox();
      await capture(page, info, "ready-top");
      await expect.soft(page.getByRole("heading", { name: FIRST_TITLE, exact: true }),
        "existing projects must appear before the add-project form and within the first screen").toBeInViewport({ ratio: 1 });
      if (viewport.name === "phone") {
        expect.soft(await page.locator(".cr2-project-home-tools > p").evaluate((node) => getComputedStyle(node).textAlign),
          "the phone introduction must align with the content below it").toBe("left");
        const add = await page.getByRole("link", { name: "Add project", exact: true }).boundingBox();
        const refresh = await page.getByRole("button", { name: "Refresh", exact: true }).boundingBox();
        expect.soft(add?.y, "the two short project actions should share a row on phone").toBe(refresh?.y);
      }
      await headerAndWidth(page);
      failRefresh();
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("Moe Projects did not send the project list.");
      await expect.soft(alert).toBeInViewport({ ratio: 1 });
      const main = await page.getByRole("main").boundingBox(), error = await alert.boundingBox();
      expect.soft(main?.width, "a refresh error must not squeeze the retained project list into another column")
        .toBe(initialMain?.width);
      expect.soft(main?.y, "the refresh error must precede the retained ledger, not occupy a grid column")
        .toBeGreaterThanOrEqual((error?.y ?? 0) + (error?.height ?? 0));
      await capture(page, info, "ready-refresh-error");
      await wheelTo(page, page.getByRole("button", { name: "Start Layout project 8", exact: true }));
      await capture(page, info, "ready-last-project");
      const addProject = page.getByRole("link", { name: "Add project", exact: true });
      await addProject.focus();
      await expect(addProject).toBeFocused();
      await page.keyboard.press("Enter");
      const intake = page.getByRole("form", { name: "Add a project", exact: true });
      await expect(intake).toBeFocused();
      await expect(intake.getByRole("heading")).toBeInViewport({ ratio: 1 });
      await capture(page, info, "ready-add-project");
      if (viewport.name === "desktop") {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const transition = await addProject.evaluate((node) => ({
          duration: getComputedStyle(node).transitionDuration,
          property: getComputedStyle(node).transitionProperty,
        }));
        expect(transition.property, "the add-project link must disable its transitions for reduced motion").toBe("none");
        // The shared shell's !important reduced-motion rule caps every duration at 1ms.
        expect(Number.parseFloat(transition.duration)).toBeLessThanOrEqual(0.001);
      }
      expect(await page.getByRole("main").count(), "the manager must keep one main landmark").toBe(1);
    });
  });
}

test("manager pairing confirmation is reachable by scrolling on short phones", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await withManager(page, "PAIRING", async () => {
    const button = page.getByRole("button", { name: "I entered this label", exact: true });
    await expect(button).toBeVisible();
    await capture(page, info, "short-phone-before-scroll");
    await wheelTo(page, button);
    await capture(page, info, "short-phone-after-scroll");
    await page.setViewportSize({ width: 320, height: 600 });
    await wheelTo(page, button);
    await capture(page, info, "narrow-phone-after-scroll");
    const label = page.getByLabel("Pairing confirmation label");
    const width = await label.evaluate((node) => ({ available: node.clientWidth, content: node.scrollWidth }));
    expect(width.content, "the complete pairing label must wrap at 320px").toBeLessThanOrEqual(width.available + 1);
  });
});

test("manager without an operator channel shows its exact refusal and reload recovery", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await withManager(page, "UNAVAILABLE", async () => {
    await expect(page.getByRole("heading", { name: "No projects loaded" })).toBeVisible();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Moe Projects cannot receive a pairing label.");
    await expect(alert).toContainText("Restart Moe Projects in a terminal, then reload this page.");
    await alert.getByText("Details", { exact: true }).click();
    await expect(alert.getByText("OPERATOR_CHANNEL_UNAVAILABLE @ PROJECT_MANAGER_HTTP", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload this page", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByLabel("Pairing confirmation label")).toHaveCount(0);
    await expect(page.getByTestId("cr.projects.list")).toHaveCount(0);
    await headerAndWidth(page);
    await capture(page, info, "operator-channel-unavailable");
  });
});
