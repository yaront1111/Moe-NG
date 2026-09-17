import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it } from "vitest";

import { CONTROL_ROOM_KEYBOARD_MAP } from "../../a11y/keyboard-map.js";
import { CordumShell } from "./cordum-shell.js";

/**
 * The v2 help overlay is the only renderer of `CONTROL_ROOM_KEYBOARD_MAP` left in the
 * application, so it is the one place the map can be pinned against what a person sees.
 * `cordum-shell.test.tsx` only opens and closes the overlay; this file reads its rows.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

it("shows the exact command map, one row per binding, with its keys and a label", async () => {
  const user = userEvent.setup();
  render(<CordumShell title="Goals"><p /></CordumShell>);
  await user.keyboard("?");

  const help = screen.getByTestId("cr.shell.help");
  const rows = [...help.querySelectorAll(".cr2-help-row")];
  // A map that shrank to nothing would pass an equality over zero rows.
  expect(CONTROL_ROOM_KEYBOARD_MAP.length).toBeGreaterThan(0);
  expect(rows).toHaveLength(CONTROL_ROOM_KEYBOARD_MAP.length);
  for (const binding of CONTROL_ROOM_KEYBOARD_MAP) {
    const keys = binding.sequence.join(" ");
    const row = rows.find((candidate) =>
      candidate.querySelector("kbd.cr2-help-keys")?.textContent === keys);
    expect(row, `no help row shows the keys "${keys}" for ${binding.action}`).toBeDefined();
    expect(row?.querySelector("span")?.textContent?.trim()).not.toBe("");
  }
});
