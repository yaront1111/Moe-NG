import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { SESSION_TTL_MS } from "../../../apps/daemon/src/identity/session-authority-contracts.js";
import { killTree, spawnNode, survivingChildren } from "./daemon-children.js";
import { createLaneScratch, daemonEnv, LANE_CSRF_TOKEN, repoRoot } from "./daemon-ports.js";
import { buildBundle } from "./static-ports.js";

const PAIR_REQUEST = "/session/pair/request";
const CLAIM = "/session/pair/claim";
const OPEN = "/session/pair/open";
const VALIDATE = "/session/validate";

test.beforeAll(async () => {
  test.setTimeout(270_000);
  expect(await buildBundle()).toBe(true);
});

// Real production entry, browser WebCrypto, private fixture operator pipe,
// production store composition and HTTP listener. No route or auth response is
// mocked. The isolated clock advances keyed expiry without expiring the bearer.
test("project pairing survives reload and an expired signed session requires fresh approval", async ({ page }) => {
  const root = repoRoot();
  expect(root).not.toBeNull();
  if (root === null) return;
  const scratch = createLaneScratch();
  const clockPath = join(scratch.root, "pairing-clock-offset.txt");
  writeFileSync(clockPath, "0", "utf8");
  const daemon = spawnNode([
    "--experimental-transform-types", join(root, "apps/daemon/src/daemon-main.ts"),
    `--dependencies=${join(root, "tests/e2e/control-room/project-pairing-clock-dependencies.ts")}`,
    `--asset-root=${join(root, "apps/control-room/dist")}`,
    "--port=0", `--csrf-token=${LANE_CSRF_TOKEN}`, "--operator-stdin",
  ], root, daemonEnv(scratch, "HUMAN"));
  const requests: string[] = [], pageErrors: string[] = [];
  page.on("request", (request) => { requests.push(new URL(request.url()).pathname); });
  page.on("pageerror", (error) => { pageErrors.push(error.name); });
  const count = (path: string): number => requests.filter((item) => item === path).length;
  try {
    const origin = await daemon.waitFor(/listening on (http:\/\/127\.0\.0\.1:\d+)/u, 90_000);
    expect(origin, "isolated daemon must announce its own listener").not.toBeNull();
    if (origin === null) return;
    await page.goto(origin);
    const label = page.getByLabel("Pairing confirmation label");
    await expect(label).toBeVisible();
    const firstLabel = (await label.textContent())?.trim() ?? "";
    expect(firstLabel).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u);
    expect(count(PAIR_REQUEST)).toBe(1);
    expect(count(CLAIM)).toBe(0);
    expect(count(OPEN)).toBe(0);

    // This pipe belongs only to the daemon spawned above, never a user's process.
    expect(daemon.child.stdin?.write(`${firstLabel}\n`)).toBeDefined();
    expect(await daemon.waitFor(/Paired\. (APPROVED)@CONTROL_ROOM_PAIRING_APPROVAL/u, 20_000)).toBe("APPROVED");
    const opened = page.waitForResponse((response) => new URL(response.url()).pathname === OPEN);
    await page.getByRole("button", { name: "I entered this label", exact: true }).click();
    expect((await opened).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Your products", exact: true })).toBeVisible();
    expect(count(CLAIM)).toBe(1);
    expect(count(OPEN)).toBe(1);

    const validated = page.waitForResponse((response) => new URL(response.url()).pathname === VALIDATE);
    await page.reload();
    const validation = await validated;
    expect(validation.status()).toBe(200);
    expect(await validation.json()).toEqual({ ok: true, projectId: scratch.projectId });
    await expect(page.getByRole("heading", { name: "Your products", exact: true })).toBeVisible();
    await expect(label).toHaveCount(0);
    expect(count(PAIR_REQUEST)).toBe(1);
    expect(count(CLAIM)).toBe(1);
    expect(count(OPEN)).toBe(1);

    // The bearer lasts 12 hours. This exact refusal therefore proves the server
    // checked the expired durable signed-open record after authenticating it.
    writeFileSync(clockPath, String(SESSION_TTL_MS + 60_000), "utf8");
    const refused = page.waitForResponse((response) => new URL(response.url()).pathname === VALIDATE);
    await page.reload();
    const refusal = await refused;
    expect(refusal.status()).toBe(401);
    expect(await refusal.json()).toEqual({
      ok: false, code: "PAIRING_SESSION_INVALID", layer: "CONTROL_ROOM_PAIRING_SESSION",
    });
    await expect(label).toBeVisible();
    expect((await label.textContent())?.trim()).not.toBe(firstLabel);
    await expect(page.getByRole("heading", { name: "Your products", exact: true })).toHaveCount(0);
    expect(count(PAIR_REQUEST)).toBe(2);
    expect(count(CLAIM)).toBe(1);
    expect(count(OPEN)).toBe(1);
    expect(requests.filter((path) => path === "/command" || path === "/v2/command")).toEqual([]);

    // The invalid candidate was cleared: another reload asks for pairing without
    // repeatedly presenting the expired session or minting authority by itself.
    await page.reload();
    await expect(label).toBeVisible();
    expect(count(VALIDATE)).toBe(2);
    expect(count(PAIR_REQUEST)).toBe(3);
    expect(count(CLAIM)).toBe(1);
    expect(count(OPEN)).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await page.close();
    await killTree(daemon.child);
    expect(await survivingChildren([daemon.child])).toEqual([]);
    const target = resolve(scratch.root);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^moe-e2e-daemon-[a-zA-Z0-9]+$/u);
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
