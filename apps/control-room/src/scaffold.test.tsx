import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildNextAllowedCommands } from "@moe/contracts";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CONTROL_ROOM_FIXTURES, CONTROL_ROOM_FIXTURE_KIND, buildControlRoomFixtures,
} from "./fixtures.js";
import {
  ControlRoomScaffold, Fact, TRUTH_ABSENT_PROVENANCE, TRUTH_INVALID_PROVENANCE, TruthChip,
  presentTruthClass,
} from "./kernel.js";
// ./main.js is imported dynamically only: it mounts on evaluation and refuses when
// the document has no mount point, so a static import would run at collection time.

const ALL_TRUTH_CLASSES = [
  "OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN",
] as const;
const SURFACE_IDS = ["goals", "board", "node", "approval", "evidence", "doctor"] as const;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const readOwnSource = (fileName: string): string =>
  readFileSync(fileURLToPath(new URL(fileName, import.meta.url)), "utf8");

describe("control-room scaffold mounts", () => {
  it("mounts through the production entry point, not just its exported helper", async () => {
    const container = document.createElement("div");
    container.id = "root";
    document.body.append(container);
    vi.resetModules();
    await act(async () => void (await import("./main.js")));
    expect(within(container).getByTestId("cr.shell.root")).toBeTruthy();
    const main = await import("./main.js");
    expect(main.CONTROL_ROOM_ROOT_ELEMENT_ID).toBe("root");
    container.remove();
  });

  it("refuses with a stable code when the document supplies no mount point", async () => {
    expect(document.getElementById("root")).toBeNull();
    vi.resetModules();
    await expect(import("./main.js")).rejects.toThrow("CONTROL_ROOM_ROOT_MISSING");
  });

  it("renders one labelled surface per fixture surface", () => {
    render(<ControlRoomScaffold />);
    for (const surface of CONTROL_ROOM_FIXTURES.surfaces) {
      expect(screen.getByTestId(`cr.surface.${surface.surfaceId}`)).toBeTruthy();
    }
    expect(CONTROL_ROOM_FIXTURES.surfaces.map((surface) => surface.surfaceId))
      .toEqual([...SURFACE_IDS]);
  });
});

describe("truth facts are triple encoded", () => {
  it.each(ALL_TRUTH_CLASSES)("encodes %s as text, icon, and colour", (truthClass) => {
    render(<TruthChip truthClass={truthClass} />);
    const chip = screen.getByTestId(`cr.chip.${truthClass.toLowerCase()}`);
    const presentation = presentTruthClass(truthClass);
    expect(presentation.origin).toBe("PRESENT");
    expect(chip.getAttribute("data-truth-class")).toBe(truthClass);
    expect(within(chip).getByTestId("cr.shortlabel").textContent)
      .toBe(presentation.descriptor.shortLabel);
    expect(within(chip).getByTestId("cr.glyph").textContent).toBe(presentation.descriptor.glyph);
    expect(chip.getAttribute("data-tone")).toBe(presentation.descriptor.semanticTone);
    expect(chip.getAttribute("aria-label")).toContain(presentation.descriptor.meaning);
  });

  it("survives forced monochrome: glyph and label alone separate all five", () => {
    const shown = ALL_TRUTH_CLASSES.map((c) => presentTruthClass(c).descriptor);
    expect(new Set(shown.map((d) => d.glyph)).size).toBe(ALL_TRUTH_CLASSES.length);
    expect(new Set(shown.map((d) => d.shortLabel)).size).toBe(ALL_TRUTH_CLASSES.length);
    // UNKNOWN is the one dashed border, the last channel left in monochrome.
    expect(shown.map((d) => d.borderStyle))
      .toEqual(["solid", "solid", "solid", "solid", "dashed"]);
  });

  it("gives every chip a keyboard-reachable 24px provenance affordance", async () => {
    const seen: string[] = [];
    const user = userEvent.setup();
    render(<TruthChip truthClass="OBSERVED" onProvenance={(p) => seen.push(p.origin)} />);
    const chip = screen.getByTestId("cr.chip.observed");
    expect([chip.tagName, chip.style.minWidth, chip.style.minHeight])
      .toEqual(["BUTTON", "24px", "24px"]);
    expect(chip.getAttribute("aria-label")).toContain("press Enter for provenance.");
    // The aria-label promises Enter, so press Enter — a synthetic click would pass
    // even if the chip were reachable by pointer only.
    await user.tab();
    expect(document.activeElement).toBe(chip);
    await user.keyboard("{Enter}");
    expect(seen).toEqual(["PRESENT"]);
  });
});

describe("absent and malformed truth classes stay honest", () => {
  it("maps an absent class to UNKNOWN with the missing-class provenance note", () => {
    for (const absent of [undefined, null]) {
      const { descriptor, origin, provenanceNote } = presentTruthClass(absent);
      expect([origin, descriptor.truthClass, provenanceNote])
        .toEqual(["ABSENT", "UNKNOWN", TRUTH_ABSENT_PROVENANCE]);
    }
    render(<TruthChip />);
    const chip = screen.getByTestId("cr.chip.unknown");
    expect(chip.getAttribute("data-origin")).toBe("ABSENT");
    expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_ABSENT_PROVENANCE);
    expect(chip.getAttribute("aria-label")).toContain(TRUTH_ABSENT_PROVENANCE);
  });

  it("reserves TRUTH_CLASS_INVALID for a present but unsupported class", () => {
    const hostile: readonly unknown[] = [
      { truthClass: "DAEMON_VERIFIED" }, "daemon_verified", "DAEMON_VERIFIED ", "", 0, false,
      ["HUMAN_APPROVED"],
    ];
    for (const value of hostile) {
      const { descriptor, origin, provenanceNote } = presentTruthClass(value);
      expect([origin, descriptor.truthClass, provenanceNote])
        .toEqual(["INVALID", "UNKNOWN", TRUTH_INVALID_PROVENANCE]);
    }
    expect(TRUTH_INVALID_PROVENANCE).toContain("TRUTH_CLASS_INVALID");
    expect(TRUTH_ABSENT_PROVENANCE).not.toBe(TRUTH_INVALID_PROVENANCE);
  });

  it("never defaults an unreadable class upward", () => {
    for (const value of [undefined, {}, "OBSERVED_"]) {
      expect(presentTruthClass(value).descriptor.semanticTone).toBe("high-contrast magenta");
    }
  });
});

describe("every fact wrapper carries a chip descendant", () => {
  it("nests a chip inside the wrapper it renders", () => {
    const { container } = render(
      <Fact factId="goal.title" label="Goal" value="Ship J1" truthClass="OBSERVED" />,
    );
    const wrapper = screen.getByTestId("cr.fact.goal.title");
    expect(within(wrapper).getByTestId("cr.chip.observed")).toBeTruthy();
    // The prefix must name wrappers only, or the audit below counts label and
    // value spans as facts and passes without ever inspecting a real claim.
    expect(container.querySelectorAll("[data-testid^='cr.fact.']").length).toBe(1);
  });

  it("holds the invariant across the whole scaffold", () => {
    const { container } = render(<ControlRoomScaffold />);
    const wrappers = container.querySelectorAll("[data-testid^='cr.fact.']");
    expect(wrappers.length)
      .toBe(CONTROL_ROOM_FIXTURES.surfaces.reduce((n, s) => n + s.facts.length, 0));
    expect(wrappers.length).toBeGreaterThanOrEqual(6);
    // Both prefixes must count elements exactly: one chip per fact, no more.
    expect(container.querySelectorAll("[data-testid^='cr.chip.']").length).toBe(wrappers.length);
    for (const wrapper of wrappers) {
      expect(wrapper.querySelector("[data-testid^='cr.chip.']")).not.toBeNull();
    }
  });
});

describe("fixtures are deterministic and carry no authority", () => {
  it("builds byte-identical fixtures twice", () => {
    expect(JSON.stringify(buildControlRoomFixtures()))
      .toBe(JSON.stringify(buildControlRoomFixtures()));
    expect(buildControlRoomFixtures()).toEqual(CONTROL_ROOM_FIXTURES);
    expect(Object.isFrozen(CONTROL_ROOM_FIXTURES)).toBe(true);
    expect(CONTROL_ROOM_FIXTURE_KIND).toBe("DEVELOPMENT_ONLY/NOT_CONFIRMATORY");
  });

  it("derives mutation enablement from daemon-supplied affordances only", () => {
    const byState = new Map(CONTROL_ROOM_FIXTURES.affordances.map((s) => [s.connection, s]));
    expect([...byState.keys()]).toEqual(["CONNECTED", "LAGGING", "DISCONNECTED", "HISTORICAL"]);
    for (const snap of CONTROL_ROOM_FIXTURES.affordances) {
      const live = snap.connection !== "DISCONNECTED" && !snap.requiresAffordanceRefresh;
      expect(snap.mutationsEnabled).toBe(live && snap.nextAllowedCommands.length > 0);
    }
    expect(byState.get("CONNECTED")?.mutationsEnabled).toBe(true);
    expect(byState.get("LAGGING")?.mutationsEnabled).toBe(true);
    expect(byState.get("LAGGING")?.statusLabel).not.toBe("");
    expect(byState.get("DISCONNECTED")?.mutationsEnabled).toBe(false);
    expect(byState.get("DISCONNECTED")?.nextAllowedCommands).toEqual([]);
    expect(byState.get("HISTORICAL")?.mutationsEnabled).toBe(false);
    expect(byState.get("HISTORICAL")?.requiresAffordanceRefresh).toBe(true);
  });

  it("rejects any affordance the daemon parser would not have produced", () => {
    const connected = CONTROL_ROOM_FIXTURES.affordances.find((s) => s.connection === "CONNECTED");
    const source = { aggregate: "NODE_RUN", state: "WORK_REVIEW" };
    const parsed = buildNextAllowedCommands(source, connected?.nextAllowedCommands);
    // A malformed or duplicated entry collapses the parser's whole result to the
    // frozen empty set, so a length floor keeps empty-equals-empty from passing.
    expect(parsed.length).toBe(3);
    expect(parsed).toEqual(connected?.nextAllowedCommands);
  });

  it("keeps a full provenance record on every fact", () => {
    for (const surface of CONTROL_ROOM_FIXTURES.surfaces) {
      for (const { provenance } of surface.facts) {
        expect(provenance.eventId).not.toBe("");
        expect(provenance.eventSequence).toBeGreaterThan(0);
        expect(provenance.actor).not.toBe("");
        expect(provenance.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[0-2]\d:[0-5]\d:[0-5]\d\.\d{3}Z$/u);
        expect(Number.isFinite(Date.parse(provenance.timestamp))).toBe(true);
        expect(["receipt", "decision", "report", "finding"]).toContain(provenance.linkKind);
      }
    }
  });
});

describe("shell source tripwires", () => {
  const modules = ["./fixtures.ts", "./kernel.tsx", "./main.tsx"] as const;
  const schedulerPackage = `sched${"uler"}`;
  const schedulerInternal =
    new RegExp(`(?:@moe/${schedulerPackage}/|${schedulerPackage}[\\\\/]src[\\\\/])`, "u");
  const heldOutImport = /(?:from|import|require)\s*\(?\s*["'][^"']*foundation[\\/][^"']*["']/u;
  const nondeterminism = /Date\.now|Math\.random|new Date\(\)/u;

  it.each(modules)("keeps %s clear of forbidden literals", (fileName) => {
    const source = readOwnSource(fileName);
    expect(source).not.toBe("");
    expect(schedulerInternal.test(source)).toBe(false);
    expect(heldOutImport.test(source)).toBe(false);
    expect(nondeterminism.test(source)).toBe(false);
  });

  it("loads the whole shell module graph without any Node-only API", async () => {
    // A bundler stubs node:util out for the browser, so anything this app touches at
    // module load must survive `types` being absent. Masking the module catches that;
    // a build cannot, because a bundle that throws on load still exits `vite build` 0.
    vi.doMock("node:util", () => ({ default: {}, types: undefined }));
    vi.resetModules();
    try {
      const fixtures = await import("./fixtures.js");
      const kernel = await import("./kernel.js");
      expect(fixtures.CONTROL_ROOM_FIXTURES.surfaces.length).toBe(SURFACE_IDS.length);
      expect(kernel.presentTruthClass("OBSERVED").origin).toBe("PRESENT");
    } finally {
      vi.doUnmock("node:util");
      vi.resetModules();
    }
  });

  it("proves the tripwire patterns actually bite", () => {
    expect(schedulerInternal.test(`import x from "@moe/${schedulerPackage}/internal";`)).toBe(true);
    expect(schedulerInternal.test(`see packages/${schedulerPackage}/src/thing.ts`)).toBe(true);
    expect(heldOutImport.test('import { J1 } from "@moe/testkit/foundation/model.js";')).toBe(true);
    expect(nondeterminism.test("const t = Date.now();")).toBe(true);
  });
});
