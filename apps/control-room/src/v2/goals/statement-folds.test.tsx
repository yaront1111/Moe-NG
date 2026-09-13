import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CHUNK_SIZE, FLAT_LIMIT, FoldedRoster, familyOf, foldGroups } from "./statement-folds.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

interface Item { readonly id: string; readonly statement: string }

const idOf = (item: Item): string => item.id;
const FAMILIES = ["AI", "CON", "DATA", "OPS", "SEC", "UX"] as const;

/** Six families of `perFamily` rows: `REQ-AI-001` ... */
function familyItems(perFamily: number): Item[] {
  return FAMILIES.flatMap((family) => Array.from({ length: perFamily }, (_, index) => ({
    id: `REQ-${family}-${String(index + 1).padStart(3, "0")}`,
    statement: `Requirement ${family} ${String(index + 1)}`,
  })));
}

/** `count` identifiers with no shared prefix: every one is its own family. */
function soloItems(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `solo${String(index + 1).padStart(3, "0")}`, statement: `Statement ${String(index + 1)}`,
  }));
}

function roster(items: readonly Item[]): void {
  render(
    <FoldedRoster
      idOf={idOf}
      items={items}
      row={(item) => <li data-testid={`row.${item.id}`}>{item.statement}</li>}
      testIdPrefix="roster"
    />,
  );
}

describe("familyOf", () => {
  it("is everything before the last dash segment, or the whole identifier without one", () => {
    expect(familyOf("REQ-AI-001")).toBe("REQ-AI");
    expect(familyOf("crit-sso-1")).toBe("crit-sso");
    expect(familyOf("req-1")).toBe("req");
    expect(familyOf("solo")).toBe("solo");
    expect(familyOf("-lead")).toBe("-lead");
  });
});

describe("foldGroups", () => {
  it("renders flat up to FLAT_LIMIT rows, whatever their families", () => {
    expect(foldGroups(soloItems(FLAT_LIMIT), idOf)).toBeNull();
    expect(foldGroups(familyItems(3).slice(0, FLAT_LIMIT), idOf)).toBeNull();
    expect(foldGroups(soloItems(FLAT_LIMIT + 1), idOf)).not.toBeNull();
  });

  it("groups by identifier family in first-appearance order, rows in revision order", () => {
    const items = familyItems(4);
    const groups = foldGroups(items, idOf);
    expect(groups?.map((group) => [group.key, group.label, group.items.length]))
      .toEqual(FAMILIES.map((family) => [`REQ-${family}`, `REQ-${family}`, 4]));
    expect(groups?.[1]?.items.map(idOf))
      .toEqual(["REQ-CON-001", "REQ-CON-002", "REQ-CON-003", "REQ-CON-004"]);
  });

  it("falls back to positional chunks when every family holds one row", () => {
    // 278 toggles for 278 statements would be worse than flat; chunks bound both the
    // first paint and the click count.
    const groups = foldGroups(soloItems(CHUNK_SIZE * 2 + 3), idOf);
    expect(groups?.map((group) => [group.key, group.label, group.items.length])).toEqual([
      ["solo001", "solo001 … solo025", CHUNK_SIZE],
      ["solo026", "solo026 … solo050", CHUNK_SIZE],
      ["solo051", "solo051 … solo053", 3],
    ]);
  });

  it("splits one family larger than CHUNK_SIZE into runs, so no click mounts more than a run", () => {
    const items = Array.from({ length: CHUNK_SIZE + 5 }, (_, index) => ({
      id: `REQ-${String(index + 1).padStart(3, "0")}`, statement: "",
    }));
    const groups = foldGroups(items, idOf);
    expect(groups?.map((group) => [group.key, group.label, group.items.length])).toEqual([
      ["REQ-001", "REQ-001 … REQ-025", CHUNK_SIZE],
      ["REQ-026", "REQ-026 … REQ-030", 5],
    ]);
    // A family within the run size keeps its name.
    expect(foldGroups(familyItems(CHUNK_SIZE), idOf)?.map((group) => group.label))
      .toEqual(FAMILIES.map((family) => `REQ-${family}`));
  });
});

describe("FoldedRoster", () => {
  it("mounts no row of 300 until a group opens, and one group's rows only", async () => {
    const user = userEvent.setup();
    roster(familyItems(50));
    expect(screen.queryAllByTestId(/^row\./u)).toHaveLength(0);
    const toggles = screen.getAllByTestId(/^roster\.group\./u);
    expect(toggles).toHaveLength(FAMILIES.length * 2);
    for (const toggle of toggles) expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await user.click(screen.getByTestId("roster.group.REQ-CON-001"));
    const shown = screen.getAllByTestId(/^row\./u);
    expect(shown).toHaveLength(CHUNK_SIZE);
    expect(shown.every((row) => row.getAttribute("data-testid")?.startsWith("row.REQ-CON-")))
      .toBe(true);
    await user.click(screen.getByTestId("roster.group.REQ-CON-001"));
    expect(screen.queryAllByTestId(/^row\./u)).toHaveLength(0);
  });

  it("opens and closes every group from one control", async () => {
    const user = userEvent.setup();
    roster(familyItems(5));
    const all = screen.getByTestId("roster.openall");
    expect(all.textContent).toBe("Open all");
    await user.click(all);
    expect(screen.getAllByTestId(/^row\./u)).toHaveLength(30);
    expect(all.textContent).toBe("Close all");
    for (const toggle of screen.getAllByTestId(/^roster\.group\./u)) {
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    }
    await user.click(all);
    expect(screen.queryAllByTestId(/^row\./u)).toHaveLength(0);
    expect(all.textContent).toBe("Open all");
  });

  it("renders a small roster flat: rows readable without a click, no toggle, no open-all", () => {
    roster(familyItems(1));
    expect(screen.getAllByTestId(/^row\./u)).toHaveLength(FAMILIES.length);
    expect(screen.getByTestId("row.REQ-UX-001").textContent).toBe("Requirement UX 1");
    expect(screen.queryAllByTestId(/^roster\.group\./u)).toHaveLength(0);
    expect(screen.queryByTestId("roster.openall")).toBeNull();
  });
});
