import { expect, test } from "@playwright/test";

import { withStaticControlRoom } from "./harness.js";
import { createStaticControlRoomPorts } from "./static-ports.js";

/**
 * ONE smoke journey: the built bundle is served, a real browser loads it, and
 * the committed `cr.shell.root` element is there. That is the whole scope.
 *
 * WHAT THIS DOES NOT PROVE. The served application renders COMMITTED FIXTURES
 * through ControlRoomScaffold; no daemon is attached and no transport exists in
 * this repository. This asserts no J1-J6 acceptance criterion, no truth-class or
 * provenance behaviour, no contrast, no layout and no timing — those belong to
 * task-667b1085. A smoke check wearing a journey's name would retire an
 * obligation it never discharged, so neither the file nor the test claims one.
 */
test("serving the built control-room bundle mounts its shell root element", async ({ page }) => {
  const outcome = await withStaticControlRoom(createStaticControlRoomPorts(), async (baseUrl) => {
    await page.goto(baseUrl);
    const shellRoot = page.getByTestId("cr.shell.root");
    // Asserts the element was FOUND, and retries while the module script runs.
    // A page that failed to mount throws nothing, so "no error" proves nothing.
    await expect(shellRoot).toHaveCount(1);
    return await shellRoot.count();
  });

  // Pins the harness outcome too: a run that never reached the body, or that
  // refused with a reason code, must not read as a pass.
  expect(outcome).toEqual({ ok: true, value: 1 });
});
