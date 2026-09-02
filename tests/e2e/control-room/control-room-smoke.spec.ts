import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { withStaticControlRoom } from "./harness.js";
import { createStaticControlRoomPorts } from "./static-ports.js";

const PRODUCTION_ASSETS_DIR = fileURLToPath(
  new URL("../../../apps/control-room/dist/assets/", import.meta.url),
);

/**
 * TWO production fences: built JavaScript excludes the retired root selector,
 * then a real browser loads the served bundle and finds `cr2.shell.root`.
 *
 * WHAT THIS DOES NOT PROVE. No daemon is attached, so this certifies only that
 * the production Cordum shell mounts and reports that absence honestly.
 * This asserts no J1-J6 acceptance criterion, no truth-class or provenance
 * behaviour, no contrast, no layout and no timing — those belong to
 * task-667b1085. A smoke check wearing a journey's name would retire an
 * obligation it never discharged, so neither the file nor the test claims one.
 *
 * Development-only `v1` and `fixtures` selectors are deliberately supplied as a
 * mutation: a production build must ignore them rather than mounting demo data.
 */
test("production artifacts exclude the legacy shell selector", async () => {
  const outcome = await withStaticControlRoom(createStaticControlRoomPorts(), async () => {
    const assets = (await readdir(PRODUCTION_ASSETS_DIR))
      .filter((name) => name.endsWith(".js"))
      .sort();
    expect(assets.length).toBeGreaterThan(0);
    const bytes = await Promise.all(
      assets.map((name) => readFile(join(PRODUCTION_ASSETS_DIR, name), "utf8")),
    );
    expect(assets.filter((_, index) => bytes[index]?.includes("cr.shell.root"))).toEqual([]);
    return "legacy-selector-absent" as const;
  });

  expect(outcome).toEqual({ ok: true, value: "legacy-selector-absent" });
});

test("serving the built control-room bundle mounts its shell root element", async ({ page }) => {
  const outcome = await withStaticControlRoom(createStaticControlRoomPorts(), async (baseUrl) => {
    await page.goto(`${baseUrl}?v1=1&fixtures=1`);
    const shellRoot = page.getByTestId("cr2.shell.root");
    // Asserts the element was FOUND, and retries while the module script runs.
    // A page that failed to mount throws nothing, so "no error" proves nothing.
    await expect(shellRoot).toHaveCount(1);
    await expect(page.getByTestId("cr.shell.root")).toHaveCount(0);
    await expect(page.getByTestId("cr.banner.fixture")).toHaveCount(0);
    await expect(page.getByTestId("cr.project.boundary")).toHaveCount(1);
    return await shellRoot.count();
  });

  // Pins the harness outcome too: a run that never reached the body, or that
  // refused with a reason code, must not read as a pass.
  expect(outcome).toEqual({ ok: true, value: 1 });
});
