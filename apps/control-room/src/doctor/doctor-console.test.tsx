import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PresentedFact } from "../nodes/node-authority.js";
import { DoctorConsole } from "./doctor-console.js";
import type {
  DoctorCheckPresentation,
  DoctorConsoleProps,
  DoctorOfflineReport,
} from "./doctor-console.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const obs = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const ver = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });
const unk = (value: string): PresentedFact => ({ truthClass: "UNKNOWN", value });

/**
 * The eleven health areas the design names for doctor (line 1080 plus the backup
 * generation of 16.5), hand-written so the assertion cannot agree with the module.
 */
const HEALTH_AREAS = [
  "engine", "schema", "integrity", "projection", "artifact", "outbox", "adapter",
  "calibration", "export", "reconciliation", "backup",
] as const;

function check(
  area: (typeof HEALTH_AREAS)[number],
  outcome: string | null,
  affected: readonly PresentedFact[],
): DoctorCheckPresentation {
  return {
    affected,
    area: ver(area),
    checkId: `moe.doctor.${area}`,
    evidence: obs(`${area} evidence bundle`),
    outcome,
    severity: ver(`${area} severity`),
  };
}

/**
 * One check per named area, with all three outcomes present. Order is the supplied
 * order and the module must not re-rank it.
 */
const CHECKS: readonly DoctorCheckPresentation[] = [
  check("engine", "HEALTHY", [ver("sqlite-3.53.4")]),
  check("schema", "HEALTHY", [ver("schema-v3")]),
  check("integrity", "DEGRADED", [ver("record-0197"), ver("record-0198")]),
  check("projection", "HEALTHY", []),
  check("artifact", "UNKNOWN_TRUTH", [unk("artifact-881")]),
  check("adapter", "DEGRADED", [obs("adapter-claude-1")]),
  check("outbox", "HEALTHY", [ver("outbox-4819")]),
  check("calibration", "UNKNOWN_TRUTH", [unk("calibration-run-3")]),
  check("export", "HEALTHY", [ver("export-gen-7")]),
  check("reconciliation", "DEGRADED", [unk("record-0197")]),
  check("backup", "UNKNOWN_TRUTH", [unk("backup-gen-4")]),
];

const OFFLINE_AS_OF = "2026-08-09T06:12:00.000Z";

/** §8.7 verbatim, hand-written; the module may not reword a single character. */
const OFFLINE_BANNER = "Daemon not running. Doctor opened the database read-only after "
  + "verifying no process holds it. This report reflects disk state as of "
  + `${OFFLINE_AS_OF}. Commands are unavailable in this mode.`;

const OFFLINE_SUGGESTIONS = [
  "recovery.inspect_external",
  "reconciliation.decide on record-0197",
] as const;

const OFFLINE_REPORT: DoctorOfflineReport = {
  asOf: ver(OFFLINE_AS_OF),
  lockProof: ver("exclusive OS lock acquired; no process holds the database"),
  mode: "OFFLINE_READ_ONLY",
  suggestedOperations: OFFLINE_SUGGESTIONS,
};

function renderConsole(overrides: Partial<DoctorConsoleProps> = {}): HTMLElement {
  const result = render(
    <DoctorConsole
      checks={CHECKS}
      overall={ver("HEALTHY")}
      overallOutcome="HEALTHY"
      {...overrides}
    />,
  );
  return result.container;
}

function checkRow(checkId: string): HTMLElement {
  return screen.getByTestId(`cr.health.check.${checkId}`);
}

function renderedCheckIds(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-check-row]")].map(
    (row) => row.dataset["checkRow"] ?? "",
  );
}

function outcomeOf(testId: string): { data: string; glyph: string; text: string } {
  const node = screen.getByTestId(testId);
  return {
    data: node.dataset["health"] ?? "",
    glyph: within(node).getByTestId("cr.health.glyph").textContent ?? "",
    text: within(node).getByTestId("cr.health.outcometext").textContent ?? "",
  };
}

function valueOf(factId: string): string {
  return within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value")
    .textContent ?? "";
}

describe("the doctor corpus covers every named health area exactly once", () => {
  it("hand-writes one non-empty check per design-named area", () => {
    expect(HEALTH_AREAS).toHaveLength(11);
    expect(CHECKS.length).toBe(HEALTH_AREAS.length);
    expect(CHECKS.map((entry) => entry.checkId).sort()).toEqual(
      [...HEALTH_AREAS].map((area) => `moe.doctor.${area}`).sort(),
    );
  });

  it("hand-writes at least one case of each of the three outcomes", () => {
    for (const outcome of ["HEALTHY", "DEGRADED", "UNKNOWN_TRUTH"]) {
      expect(CHECKS.filter((entry) => entry.outcome === outcome).length)
        .toBeGreaterThan(0);
    }
  });
});

describe("doctor console renders supplied checks without ranking or rolling them up", () => {
  it("renders every supplied check in the supplied order under its stable id", () => {
    const container = renderConsole();
    expect(renderedCheckIds(container)).toEqual(CHECKS.map((entry) => entry.checkId));
    expect(renderedCheckIds(container)).toHaveLength(11);
  });

  it("keeps HEALTHY, DEGRADED, and UNKNOWN_TRUTH distinct in text, glyph, and data", () => {
    renderConsole();
    const healthy = outcomeOf("cr.health.outcome.moe.doctor.engine");
    const degraded = outcomeOf("cr.health.outcome.moe.doctor.integrity");
    const unknownTruth = outcomeOf("cr.health.outcome.moe.doctor.artifact");
    expect(healthy).toEqual({ data: "HEALTHY", glyph: "▣", text: "HEALTHY" });
    expect(degraded).toEqual({ data: "DEGRADED", glyph: "▲", text: "DEGRADED" });
    expect(unknownTruth).toEqual({ data: "UNKNOWN_TRUTH", glyph: "◇", text: "UNKNOWN_TRUTH" });
    expect(new Set([healthy.glyph, degraded.glyph, unknownTruth.glyph]).size).toBe(3);
  });

  it("keeps the supplied overall outcome even while checks below it are worse", () => {
    renderConsole();
    expect(outcomeOf("cr.health.outcome.overall")).toEqual({
      data: "HEALTHY", glyph: "▣", text: "HEALTHY",
    });
    expect(valueOf("health.overall")).toBe("HEALTHY");
  });

  it("renders a supplied DEGRADED overall even while every check reads HEALTHY", () => {
    renderConsole({
      checks: [check("engine", "HEALTHY", [ver("sqlite-3.53.4")])],
      overall: ver("DEGRADED"),
      overallOutcome: "DEGRADED",
    });
    expect(outcomeOf("cr.health.outcome.overall").data).toBe("DEGRADED");
  });

  it("renders an absent outcome as UNKNOWN, which is not the UNKNOWN_TRUTH verdict", () => {
    renderConsole({ overall: null, overallOutcome: null });
    const shown = outcomeOf("cr.health.outcome.overall");
    expect(shown).toEqual({ data: "UNKNOWN", glyph: "◇", text: "UNKNOWN" });
    expect(shown.data).not.toBe("UNKNOWN_TRUTH");
    expect(valueOf("health.overall")).toBe("UNKNOWN");
  });

  it("renders an outcome token the daemon contract does not define as UNKNOWN", () => {
    renderConsole({ overallOutcome: "MOSTLY_FINE" });
    expect(outcomeOf("cr.health.outcome.overall").text).toBe("UNKNOWN");
  });
});

describe("doctor console keeps every check claim addressable and truth-classed", () => {
  it("renders severity and evidence for each check under check-qualified fact ids", () => {
    renderConsole();
    expect(valueOf("health.check.moe.doctor.integrity.severity"))
      .toBe("integrity severity");
    expect(valueOf("health.check.moe.doctor.integrity.evidence"))
      .toBe("integrity evidence bundle");
    expect(valueOf("health.check.moe.doctor.integrity.area")).toBe("integrity");
  });

  it("renders every affected record id in the supplied order", () => {
    renderConsole();
    const row = checkRow("moe.doctor.integrity");
    const affected = [...row.querySelectorAll<HTMLElement>("[data-affected-record]")]
      .map((node) => node.dataset["affectedRecord"]);
    expect(affected).toEqual(["record-0197", "record-0198"]);
    expect(valueOf("health.check.moe.doctor.integrity.affected.0")).toBe("record-0197");
    expect(valueOf("health.check.moe.doctor.integrity.affected.1")).toBe("record-0198");
  });

  it("renders an empty affected list as UNKNOWN rather than a confident none", () => {
    renderConsole();
    const shown = valueOf("health.check.moe.doctor.projection.affected");
    expect(shown).toBe("UNKNOWN");
    expect(shown).not.toBe("none");
  });

  it("renders a blank supplied value as UNKNOWN beside the unknown chip", () => {
    renderConsole({
      checks: [{ ...check("engine", "HEALTHY", []), evidence: ver("   ") }],
    });
    expect(valueOf("health.check.moe.doctor.engine.evidence")).toBe("UNKNOWN");
    const row = checkRow("moe.doctor.engine");
    const fact = within(row).getByTestId("cr.fact.health.check.moe.doctor.engine.evidence");
    expect(within(fact).getByTestId("cr.shortlabel").textContent).toBe("UNK");
  });

  it("gives every fact wrapper exactly one truth chip", () => {
    const container = renderConsole({ offlineReport: OFFLINE_REPORT });
    const facts = container.querySelectorAll("[data-testid^='cr.fact.']");
    const chips = container.querySelectorAll("[data-testid^='cr.chip.']");
    expect(facts.length).toBeGreaterThan(20);
    expect(chips.length).toBe(facts.length);
    for (const fact of facts) {
      expect(fact.querySelectorAll("[data-testid^='cr.chip.']")).toHaveLength(1);
    }
  });

  it("reports a unique check-qualified fact id for every provenance request", async () => {
    const seen: string[] = [];
    const container = renderConsole({ onProvenance: (factId) => seen.push(factId) });
    const chips = [...container.querySelectorAll<HTMLButtonElement>(
      "[data-testid^='cr.chip.']",
    )];
    for (const chip of chips) await userEvent.click(chip);
    expect(seen.length).toBe(chips.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("health.check.moe.doctor.integrity.severity");
    expect(seen.filter((factId) => factId.startsWith("health.check.")).length)
      .toBeGreaterThan(10);
  });
});

describe("doctor console keyboard walks the supplied checks", () => {
  it("moves focus with j/k, clamps at the ends, and opens the focused check", async () => {
    const focused: string[] = [];
    const opened: string[] = [];
    renderConsole({
      checks: CHECKS.slice(0, 3),
      onFocusCheck: (checkId) => focused.push(checkId),
      onOpenCheck: (checkId) => opened.push(checkId),
    });
    screen.getByTestId("cr.health.checks").focus();
    await userEvent.keyboard("k");
    expect(document.activeElement).toBe(checkRow("moe.doctor.engine"));
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(checkRow("moe.doctor.schema"));
    await userEvent.keyboard("jj");
    expect(document.activeElement).toBe(checkRow("moe.doctor.integrity"));
    await userEvent.keyboard("{Enter}");
    expect(focused).toEqual([
      "moe.doctor.engine", "moe.doctor.schema", "moe.doctor.integrity",
      "moe.doctor.integrity",
    ]);
    expect(opened).toEqual(["moe.doctor.integrity"]);
  });
});

describe("doctor console stays honest while loading and degraded", () => {
  it("renders skeletons and no check rows while loading", () => {
    const container = renderConsole({ loading: true });
    expect(screen.getAllByTestId("cr.health.skeleton")).toHaveLength(3);
    expect(renderedCheckIds(container)).toEqual([]);
    expect(screen.queryByTestId("cr.health.checks")).toBeNull();
  });

  it("names the as-of cursor when the view is degraded", () => {
    renderConsole({ degraded: true, freshnessLabel: "applied #4801" });
    const asOf = screen.getByTestId("cr.health.asof");
    expect(asOf.getAttribute("role")).toBe("status");
    expect(asOf.textContent).toBe("Showing last-known health as of applied #4801");
  });

  it("says UNKNOWN rather than inventing a cursor when degraded with no label", () => {
    renderConsole({ degraded: true });
    expect(screen.getByTestId("cr.health.asof").textContent)
      .toBe("Showing last-known health as of UNKNOWN");
  });

  it("renders no as-of line when the view is not degraded", () => {
    renderConsole();
    expect(screen.queryByTestId("cr.health.asof")).toBeNull();
  });
});

describe("offline doctor mode reports and never acts", () => {
  it("renders the §8.7 banner verbatim with the supplied report time", () => {
    renderConsole({ offlineReport: OFFLINE_REPORT });
    expect(screen.getByTestId("cr.health.doctor.banner").textContent).toBe(OFFLINE_BANNER);
    expect(valueOf("health.doctor.asof")).toBe(OFFLINE_AS_OF);
    expect(valueOf("health.doctor.lockproof"))
      .toBe("exclusive OS lock acquired; no process holds the database");
  });

  it("says UNKNOWN in the banner rather than inventing a report time", () => {
    renderConsole({ offlineReport: { ...OFFLINE_REPORT, asOf: null } });
    expect(screen.getByTestId("cr.health.doctor.banner").textContent).toBe(
      "Daemon not running. Doctor opened the database read-only after verifying no "
      + "process holds it. This report reflects disk state as of UNKNOWN. Commands are "
      + "unavailable in this mode.",
    );
  });

  it("renders suggested operations as text, never as a control", () => {
    const container = renderConsole({ offlineReport: OFFLINE_REPORT });
    const shown = [...container.querySelectorAll<HTMLElement>(
      "[data-testid^='cr.health.doctor.suggestion.']",
    )];
    expect(shown.map((node) => node.textContent)).toEqual([...OFFLINE_SUGGESTIONS]);
    for (const node of shown) {
      expect(node.tagName).toBe("LI");
      expect(node.querySelector("button")).toBeNull();
    }
  });

  it("mounts zero cr.action.* elements and zero enabled buttons other than chips", () => {
    const container = renderConsole({ offlineReport: OFFLINE_REPORT });
    expect(container.querySelectorAll("[data-testid^='cr.action.']")).toHaveLength(0);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.dataset["testid"] ?? button.getAttribute("data-testid") ?? "")
        .toMatch(/^cr\.chip\./u);
    }
  });

  it("renders no offline banner for a report that is not OFFLINE_READ_ONLY", () => {
    renderConsole({ offlineReport: { ...OFFLINE_REPORT, mode: "LIVE" } });
    expect(screen.queryByTestId("cr.health.doctor.banner")).toBeNull();
    expect(screen.queryByTestId("cr.health.doctor")).toBeNull();
  });

  it("renders no doctor panel at all when no offline report was supplied", () => {
    renderConsole();
    expect(screen.queryByTestId("cr.health.doctor")).toBeNull();
  });
});
