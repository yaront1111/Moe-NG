import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";

import { CONTROL_ROOM_KEYBOARD_MAP } from "../a11y/keyboard-map.js";
import { CONTROL_ROOM_NAV_ITEMS } from "./nav-rail.js";
import { HelpOverlay } from "./shell-chrome.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

it("shows the exact command map without dropping the complete navigation index", () => {
  render(<HelpOverlay onClose={() => undefined} open />);

  const help = screen.getByTestId("cr.shell.help");
  const rows = within(help).getAllByTestId(/^cr\.shell\.help\.binding\./u);
  expect(rows).toHaveLength(CONTROL_ROOM_KEYBOARD_MAP.length);
  for (const binding of CONTROL_ROOM_KEYBOARD_MAP) {
    const row = within(help).getByTestId(`cr.shell.help.binding.${binding.action}`);
    expect(within(row).getByTestId("cr.shell.help.keys").textContent)
      .toBe(binding.sequence.join(" "));
    expect(within(row).getByTestId("cr.shell.help.description").textContent)
      .not.toBe("");
  }
  expect(within(help).getByTestId("cr.shell.help.binding.search").textContent)
    .toContain("when present");
  expect(within(help).getByTestId("cr.shell.help.binding.graph").textContent)
    .toContain("goal views");
  expect(within(help).getByTestId("cr.shell.help.binding.approvals").textContent)
    .toContain("when navigation is available");
  for (const label of CONTROL_ROOM_NAV_ITEMS) expect(within(help).getByText(label)).toBeDefined();
});

it("stacks the command map at phone width", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles/responsive.css"), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 639px)"));
  expect(phone).toMatch(/\.cr-shell-help-grid\s*\{[^}]*grid-template-columns:\s*1fr;/su);
});
