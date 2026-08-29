import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { withStaticControlRoom } from "./harness.js";
import { coveredScenarios } from "./journey-coverage.js";
import { createStaticControlRoomPorts } from "./static-ports.js";

/**
 * Production-static browser evidence for Cordum v2. The harness performs a real
 * production build, so development-only `v1` and `fixtures` selectors must not
 * revive the retired preview shell. With no daemon attached, these journeys make
 * only fail-closed presentation claims; live authority is covered by the daemon
 * journeys in this directory.
 */

const DEVELOPMENT_SELECTOR_MUTATION = "?v1=1&fixtures=1";
const EXERCISED_SCENARIOS = ["CR-J1-002", "CR-A11Y-001"] as const;

interface ChipRecord {
  readonly border: string | null;
  readonly glyph: string;
  readonly shortLabel: string;
  readonly truthClass: string;
}

interface ButtonRecord {
  readonly disabled: boolean;
  readonly testId: string;
}

async function journey(
  body: (page: Page, baseUrl: string) => Promise<void>,
  page: Page,
  search = DEVELOPMENT_SELECTOR_MUTATION,
): Promise<void> {
  const outcome = await withStaticControlRoom(createStaticControlRoomPorts(), async (baseUrl) => {
    await page.goto(`${baseUrl}${search}`);
    await expect(page.getByTestId("cr2.shell.root")).toHaveCount(1);
    await body(page, baseUrl);
    return "journey-complete";
  });
  expect(outcome).toEqual({ ok: true, value: "journey-complete" });
}

const visibleButtons = async (page: Page): Promise<readonly ButtonRecord[]> =>
  await page.locator("button[data-testid]").evaluateAll((nodes) => nodes.flatMap((node) => {
    if (!(node instanceof HTMLButtonElement)) return [];
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return [];
    return [{ disabled: node.disabled, testId: node.dataset["testid"] ?? "" }];
  }));

test("production selectors cannot revive the legacy fixture shell", async ({ page }) => {
  await journey(async (driven) => {
    await expect(driven.getByTestId("cr.shell.root")).toHaveCount(0);
    await expect(driven.getByTestId("cr.banner.fixture")).toHaveCount(0);
    await expect(driven.getByTestId("cr.config.notice")).toHaveCount(0);
    await expect(driven.getByTestId("cr.project.boundary")).toBeVisible();
    await expect(driven.getByTestId("cr.goals.home")).toBeVisible();
    await expect(driven.getByText(/LIVE_BOOTSTRAP_UNAVAILABLE/iu).first()).toBeVisible();
    expect(await driven.content()).not.toContain("DEVELOPMENT_ONLY/NOT_CONFIRMATORY");
  }, page);
});

test("CR-J1-002: production v2 never mounts a graph canvas", async ({ page }) => {
  await journey(async (driven) => {
    await expect(driven.getByTestId("cr.shell.navrail")).toBeVisible();
    await expect(driven.getByTestId("cr.nav.goals")).toHaveAttribute("aria-current", "page");
    await expect(driven.locator("[data-testid^='cr.graph.']")).toHaveCount(0);
    await expect(driven.getByRole("button", { name: /Approvals.*not available yet/iu }))
      .toBeDisabled();
  }, page);
});

test("CR-A11Y-001: five truth classes stay distinct without colour", async ({ page }) => {
  await journey(async (driven) => {
    const chips = await driven.locator("[data-testid^='cr.legend.'] [data-truth-class]")
      .evaluateAll((nodes): readonly ChipRecord[] => nodes.map((node) => ({
        border: node.getAttribute("data-border"),
        glyph: node.querySelector("[data-testid='cr.glyph']")?.textContent ?? "",
        shortLabel: node.querySelector("[data-testid='cr.shortlabel']")?.textContent ?? "",
        truthClass: node.getAttribute("data-truth-class") ?? "",
      })));
    expect(chips).toHaveLength(5);
    expect(chips.map(({ truthClass }) => truthClass).sort()).toEqual([
      "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "OBSERVED", "UNKNOWN",
    ]);
    const signatures = chips.map(({ border, glyph, shortLabel }) =>
      `${glyph}|${shortLabel}|${border ?? ""}`);
    expect(new Set(signatures).size).toBe(chips.length);
    expect(chips.find(({ truthClass }) => truthClass === "UNKNOWN")?.border).toBe("dotted");
    expect(chips.every(({ glyph, shortLabel }) => glyph !== "" && shortLabel !== "")).toBe(true);
  }, page);
});

test("the disconnected banner never coexists with an enabled mutation", async ({ page }) => {
  await journey(async (driven) => {
    await expect(driven.getByTestId("cr.banner.disconnected")).toBeVisible();
    const mutations = driven.locator("button[data-testid='cr.goals.new'], button[data-testid^='cr.action.']");
    expect(await mutations.count()).toBeGreaterThan(0);
    for (const mutation of await mutations.all()) await expect(mutation).toBeDisabled();
  }, page);
});

test("the narrow layout keeps action parity with the wide one", async ({ page }) => {
  await journey(async (driven) => {
    await driven.setViewportSize({ height: 900, width: 1280 });
    const wide = [...await visibleButtons(driven)]
      .sort((a, b) => a.testId.localeCompare(b.testId));
    expect(wide.length).toBeGreaterThan(0);
    await driven.setViewportSize({ height: 900, width: 900 });
    const narrow = [...await visibleButtons(driven)]
      .sort((a, b) => a.testId.localeCompare(b.testId));
    expect(narrow).toEqual(wide);
  }, page);
});

test("project switching rejects authority-bearing URLs and opens only a plain origin", async ({ page }) => {
  await journey(async (driven, baseUrl) => {
    const plainOrigin = new URL(baseUrl).origin;
    await driven.getByText("Open another project").click();
    const input = driven.getByLabel("Another project's origin");
    await input.fill(`${baseUrl}/#pair=forbidden`);
    await driven.getByRole("button", { name: "Open isolated project" }).click();
    await expect(driven.getByRole("alert")).toContainText("PROJECT_PAIRING_LINK_INVALID");
    expect(await input.inputValue()).toBe("");

    await input.fill(plainOrigin);
    const popupPromise = driven.waitForEvent("popup", { timeout: 10_000 });
    await driven.getByRole("button", { name: "Open isolated project" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    expect(new URL(popup.url()).origin).toBe(plainOrigin);
    expect(new URL(popup.url()).hash).toBe("");
    expect(new URL(popup.url()).search).toBe("");
    await expect(driven.getByTestId("cr2.shell.root")).toHaveCount(1);
    await popup.close();
  }, page, "");
});

test("the ledger's COVERED set is exactly what this file drives", () => {
  const ledger = coveredScenarios().map((scenario) => scenario.id).sort();
  expect(ledger).toEqual([...EXERCISED_SCENARIOS].sort());
  expect(ledger.length).toBeGreaterThan(0);
});
