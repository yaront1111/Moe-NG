import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { withStaticControlRoom } from "./harness.js";
import { buildBundle, createStaticControlRoomPorts } from "./static-ports.js";

// Real production entry, navigation and browser sessionStorage with explicit HTTP
// fixtures. Actual server approval and deadline behavior is covered separately by
// tests/integration/project-manager-pairing-recovery.test.ts.
const SCHEMA = "moe-project-manager/1";
const HEADER = "x-moe-manager-session-credential";
const CREDENTIAL = "browser-fixture-manager-session";
interface Journey {
  readonly bootstrapCredentials: (string | undefined)[];
  readonly claims: string[];
  readonly pairRequests: string[];
  expire(): void;
  restart(): void;
  adjacentOrigin(): string;
}
test.beforeAll(async () => {
  expect(await buildBundle()).toBe(true);
});

async function withManager(page: Page, body: (journey: Journey) => Promise<void>): Promise<void> {
  const errors: string[] = [], unexpected: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const result = await withStaticControlRoom({
    ...createStaticControlRoomPorts(), buildBundle: async () => true,
  }, async (baseUrl) => {
    const origin = new URL(baseUrl);
    origin.hostname = "127.0.0.2";
    const adjacent = new URL(origin);
    adjacent.port = String(Number(origin.port) === 65_535 ? 65_534 : Number(origin.port) + 1);
    let expired = false, restarted = false;
    const bootstrapCredentials: (string | undefined)[] = [], claims: string[] = [], pairRequests: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin.origin && url.origin !== adjacent.origin) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort(); return;
      }
      const credential = request.headers()[HEADER];
      const authenticated = url.origin === origin.origin && !restarted && credential === CREDENTIAL;
      if (url.pathname === "/manager/bootstrap" && request.method() === "GET") {
        bootstrapCredentials.push(credential);
        await route.fulfill({ json: { authenticated, csrfToken: "browser-fixture-csrf", schemaVersion: SCHEMA } });
      } else if (url.pathname === "/manager/session/pair/request" && request.method() === "POST") {
        pairRequests.push(url.origin);
        await route.fulfill({ json: {
          confirmationLabel: pairRequests.length === 1 ? "1234-5678-abcd" : "abcd-9876-5432",
          ok: true, requestId: "a".repeat(64),
        } });
      } else if (url.pathname === "/manager/session/pair/claim" && request.method() === "POST") {
        claims.push(url.origin);
        await route.fulfill(expired
          ? { status: 410, json: { code: "PAIRING_REQUEST_EXPIRED", layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false } }
          : { json: { code: "PROJECT_MANAGER_PAIRED", layer: "PROJECT_MANAGER_HTTP", ok: true, sessionCredential: CREDENTIAL } });
      } else if (url.pathname === "/manager/projects" && request.method() === "GET" && authenticated) {
        await route.fulfill({ json: { projects: [], schemaVersion: SCHEMA } });
      } else if (url.pathname.startsWith("/manager/") || request.method() !== "GET") {
        unexpected.push(`${request.method()} ${url.pathname}`);
        await route.abort();
      } else {
        await route.fulfill({ response: await route.fetch({ url: new URL(url.pathname + url.search, baseUrl).href }) });
      }
    });
    await page.goto(origin.href);
    await expect(page.getByRole("heading", { name: "Pair this browser with Moe Projects" })).toBeVisible();
    await body({
      bootstrapCredentials, claims, pairRequests,
      expire: () => { expired = true; }, restart: () => { restarted = true; },
      adjacentOrigin: () => adjacent.href,
    });
    // A final reload can paint the heading before font requests finish. Drain
    // those routes while the static listener is still alive, then close the page
    // so the manager's refresh timer cannot race teardown.
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
    return "pairing-observed";
  });
  expect(result).toEqual({ ok: true, value: "pairing-observed" });
}

async function finishPairing(page: Page): Promise<void> {
  await page.getByRole("button", { name: "I entered this label", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(CREDENTIAL);
  expect(page.url()).not.toContain(CREDENTIAL);
}

test("completed pairing survives reload and a restarted manager asks for fresh approval", async ({ page }) => {
  await withManager(page, async (journey) => {
    await finishPairing(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    expect(journey.pairRequests).toHaveLength(1);
    expect(journey.claims).toHaveLength(1);
    expect(journey.bootstrapCredentials).toEqual([undefined, CREDENTIAL]);
    journey.restart();
    await page.reload();
    await expect(page.getByLabel("Pairing confirmation label")).toHaveText("abcd-9876-5432");
    expect(journey.pairRequests).toHaveLength(2);
    // The rejected credential has been erased, so another reload presents none.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Pair this browser with Moe Projects" })).toBeVisible();
    expect(journey.bootstrapCredentials).toEqual([undefined, CREDENTIAL, CREDENTIAL, undefined]);
    expect(journey.claims).toHaveLength(1);
  });
});

test("completed pairing does not travel to an adjacent port", async ({ page }) => {
  await withManager(page, async (journey) => {
    await finishPairing(page);
    await page.goto(journey.adjacentOrigin());
    await expect(page.getByRole("heading", { name: "Pair this browser with Moe Projects" })).toBeVisible();
    expect(journey.bootstrapCredentials).toEqual([undefined, undefined]);
    expect(journey.claims).toHaveLength(1);
  });
});

test("expired approval displays its cause and reload obtains a fresh label", async ({ page }) => {
  await withManager(page, async (journey) => {
    journey.expire();
    await page.getByRole("button", { name: "I entered this label", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No projects loaded" })).toBeVisible();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("expired");
    await alert.getByText("Details", { exact: true }).click();
    await expect(alert.getByText("PAIRING_REQUEST_EXPIRED @ CONTROL_ROOM_PAIRING_APPROVAL", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Reload this page", exact: true }).click();
    await expect(page.getByLabel("Pairing confirmation label")).toHaveText("abcd-9876-5432");
    expect(journey.bootstrapCredentials).toEqual([undefined, undefined]);
    expect(journey.claims).toHaveLength(1);
    expect(journey.pairRequests).toHaveLength(2);
  });
});

test("unavailable browser storage allows pairing without promising reload persistence", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("storage unavailable"); } });
  });
  await withManager(page, async (journey) => {
    await finishPairing(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Pair this browser with Moe Projects" })).toBeVisible();
    expect(journey.bootstrapCredentials).toEqual([undefined, undefined]);
    expect(journey.claims).toHaveLength(1);
  });
});
