import { describe, expect, it } from "vitest";

import {
  buildDoctorVersionReport,
  comparePin,
  compareRangePin,
  DOCTOR_VERSION_ERROR_CODES,
  DOCTOR_VERSION_LAYERS,
  DOCTOR_VERSION_REPORT_VERSION,
  known,
  packageManagerVersion,
  PIN_VERDICTS,
  unknown,
  VERSION_PIN_KINDS,
} from "./doctor-version-contract.js";
import type { ComponentEntry, DoctorVersionReportInput, ObservedValue } from "./doctor-version-contract.js";

/**
 * Every list below is HAND-TRANSCRIBED. Deriving one from the export it checks
 * asserts only that an array equals itself, and a seventh code would appear on
 * both sides and stay green — the exact vacuity epic rail 6 names.
 */
const EXPECTED_LAYERS = ["DOCTOR_VERSION", "DOCTOR_VERSION_HOST"];
const EXPECTED_VERDICTS = ["SATISFIED", "MISMATCHED", "UNKNOWN"];
const EXPECTED_PINS = ["NODE_RUNTIME", "PNPM_TOOL", "ENGINES_NODE", "ENGINES_PNPM"];
const EXPECTED_CODES = [
  "DOCTOR_VERSION_REPORT_ABSENT",
  "DOCTOR_RUNTIME_VERSION_UNREADABLE",
  "DOCTOR_TOOL_VERSION_UNREADABLE",
  "DOCTOR_DECLARED_PIN_UNREADABLE",
  "DOCTOR_COMPONENT_INVENTORY_EMPTY",
  "DOCTOR_PIN_RANGE_UNSUPPORTED",
];

const HOST_UNREADABLE = unknown("DOCTOR_RUNTIME_VERSION_UNREADABLE", "DOCTOR_VERSION_HOST");

function input(overrides: Partial<DoctorVersionReportInput> = {}): DoctorVersionReportInput {
  return {
    observed: {
      node: known("v24.16.0"),
      pnpm: known("11.0.8"),
      platform: known("win32"),
      arch: known("x64"),
    },
    declared: {
      nodeVersionFile: known("24.16.0\n"),
      packageManager: known("pnpm@11.0.8"),
      enginesNode: known(">=24.16.0 <25"),
      enginesPnpm: known("11.0.8"),
    },
    components: [{ name: "@moe/daemon", version: known("0.0.0") }],
    componentInventory: known("1"),
    ...overrides,
  };
}

describe("the doctor version vocabulary is closed and frozen", () => {
  it.each([
    ["layers", DOCTOR_VERSION_LAYERS, EXPECTED_LAYERS],
    ["verdicts", PIN_VERDICTS, EXPECTED_VERDICTS],
    ["pin kinds", VERSION_PIN_KINDS, EXPECTED_PINS],
    ["error codes", DOCTOR_VERSION_ERROR_CODES, EXPECTED_CODES],
  ])("declares exactly the %s it can emit, and freezes them", (_label, actual, expected) => {
    expect([...actual]).toEqual(expected);
    expect(Object.isFrozen(actual)).toBe(true);
  });

  it("pins the report schema version literal", () => {
    expect(DOCTOR_VERSION_REPORT_VERSION).toBe("moe-doctor-version-report/1");
  });
});

describe("comparePin normalises the two shapes the pins actually arrive in", () => {
  // Measured on this repo: `process.version` is "v24.16.0" and `.node-version`
  // is "24.16.0\n". Without both normalisations a correctly pinned host reads
  // MISMATCHED, so these two cases are the ones that keep DoD 2 honest.
  it("treats a v-prefixed observation and a newline-terminated pin as satisfied", () => {
    expect(comparePin("NODE_RUNTIME", known("24.16.0\n"), known("v24.16.0")).verdict).toBe(
      "SATISFIED",
    );
  });

  it("absorbs a Windows CRLF on the declared pin", () => {
    expect(comparePin("NODE_RUNTIME", known("24.16.0\r\n"), known("v24.16.0")).verdict).toBe(
      "SATISFIED",
    );
  });

  it("reports a real disagreement as MISMATCHED with both sides still separate", () => {
    const verdict = comparePin("NODE_RUNTIME", known("24.15.0"), known("v24.16.0"));
    expect(verdict.verdict).toBe("MISMATCHED");
    // DoD 2: a consumer that cannot see both cannot tell a satisfied pin from an
    // unread one, so the two fields must survive the comparison unmerged.
    expect(verdict.declared).toEqual({ known: true, value: "24.15.0" });
    expect(verdict.observed).toEqual({ known: true, value: "v24.16.0" });
  });
});

describe("an unknown side never gains authority", () => {
  it("yields UNKNOWN when the observation is unreadable, carrying the host layer", () => {
    const verdict = comparePin("NODE_RUNTIME", known("24.16.0"), HOST_UNREADABLE);
    expect(verdict.verdict).toBe("UNKNOWN");
    expect(verdict.observed).toEqual({
      known: false,
      code: "DOCTOR_RUNTIME_VERSION_UNREADABLE",
      layer: "DOCTOR_VERSION_HOST",
    });
  });

  it("yields UNKNOWN when the declared pin is unreadable", () => {
    const declared = unknown("DOCTOR_DECLARED_PIN_UNREADABLE", "DOCTOR_VERSION_HOST");
    const verdict = comparePin("NODE_RUNTIME", declared, known("v24.16.0"));
    expect(verdict.verdict).toBe("UNKNOWN");
    expect(verdict.declared).toEqual(declared);
  });

  /**
   * Found by the step-7 adversarial probe, not by a test. Every reader in this
   * module's Node half refuses a blank before it becomes a value, but
   * `buildDoctorVersionReport` and `comparePin` are exported — so a caller could
   * hand in two blanks and receive SATISFIED for a pin nobody read. Task rail 4
   * says an unreadable value never renders as a satisfied pin; a blank is one.
   */
  it.each([
    ["", ""],
    ["", "1.2.3"],
    ["1.2.3", "   "],
  ])("refuses to satisfy a pin from blank values (%j vs %j)", (declared, observed) => {
    expect(comparePin("NODE_RUNTIME", known(declared), known(observed)).verdict).toBe("UNKNOWN");
  });

  it("never returns SATISFIED or MISMATCHED for any unknown combination", () => {
    const sides: readonly (readonly [ObservedValue, ObservedValue])[] = [
      [known("24.16.0"), HOST_UNREADABLE],
      [HOST_UNREADABLE, known("v24.16.0")],
      [HOST_UNREADABLE, HOST_UNREADABLE],
    ];
    // Assert the sweep generated cases before asserting anything about them.
    expect(sides).toHaveLength(3);
    for (const [declared, observed] of sides) {
      expect(comparePin("NODE_RUNTIME", declared, observed).verdict).toBe("UNKNOWN");
      expect(compareRangePin("ENGINES_NODE", declared, observed).verdict).toBe("UNKNOWN");
    }
  });
});

describe("the range pin is checked as a range, never by string equality", () => {
  it.each([
    ["v24.16.0", "SATISFIED"],
    ["v24.20.5", "SATISFIED"],
    ["v24.15.9", "MISMATCHED"],
    ["v25.0.0", "MISMATCHED"],
  ])("classifies %s against >=24.16.0 <25 as %s", (observed, expected) => {
    expect(compareRangePin("ENGINES_NODE", known(">=24.16.0 <25"), known(observed)).verdict).toBe(
      expected,
    );
  });

  /**
   * The comparator's own refusal, and the only thing that proves the two layers
   * are distinguishable: the host read this string perfectly well, and it is
   * THIS layer that cannot interpret it.
   */
  it("refuses an unsupported range under DOCTOR_VERSION rather than guessing", () => {
    const verdict = compareRangePin("ENGINES_NODE", known("^24"), known("v24.16.0"));
    expect(verdict.verdict).toBe("UNKNOWN");
    expect(verdict.declared).toEqual({
      known: false,
      code: "DOCTOR_PIN_RANGE_UNSUPPORTED",
      layer: "DOCTOR_VERSION",
    });
    expect(verdict.observed).toEqual({ known: true, value: "v24.16.0" });
  });
});

describe("packageManagerVersion separates the tool name from its version", () => {
  it("extracts the version half of a packageManager declaration", () => {
    expect(packageManagerVersion(known("pnpm@11.0.8"))).toEqual({ known: true, value: "11.0.8" });
  });

  it.each([["pnpm"], ["pnpm@"], ["@11.0.8"]])(
    "refuses %s as an unreadable declared pin under DOCTOR_VERSION",
    (raw) => {
      expect(packageManagerVersion(known(raw))).toEqual({
        known: false,
        code: "DOCTOR_DECLARED_PIN_UNREADABLE",
        layer: "DOCTOR_VERSION",
      });
    },
  );
});

describe("buildDoctorVersionReport composes a frozen, self-consistent report", () => {
  it("derives componentCount from the array so a report cannot overstate its sweep", () => {
    const components: readonly ComponentEntry[] = [
      { name: "@moe/daemon", version: known("0.0.0") },
      { name: "@moe/core", version: known("0.0.0") },
    ];
    const report = buildDoctorVersionReport(input({ components, componentInventory: known("2") }));
    expect(report.componentCount).toBe(2);
    expect(report.componentCount).toBe(report.components.length);
    expect(report.components.map((entry) => entry.name)).toEqual(["@moe/daemon", "@moe/core"]);
  });

  it("emits exactly one verdict per declared pin kind", () => {
    const report = buildDoctorVersionReport(input());
    expect(report.pins).toHaveLength(VERSION_PIN_KINDS.length);
    expect(report.pins.length).toBeGreaterThan(0);
    expect(report.pins.map((pin) => pin.pin)).toEqual(EXPECTED_PINS);
  });

  it("satisfies every pin when the host matches the repo's declarations", () => {
    const report = buildDoctorVersionReport(input());
    expect(report.pins.map((pin) => pin.verdict)).toEqual([
      "SATISFIED",
      "SATISFIED",
      "SATISFIED",
      "SATISFIED",
    ]);
  });

  it("keeps declared and observed as separate groups on the report", () => {
    const report = buildDoctorVersionReport(input());
    expect(report.declared.packageManager).toEqual({ known: true, value: "pnpm@11.0.8" });
    expect(report.observed.node).toEqual({ known: true, value: "v24.16.0" });
    expect(report.reportVersion).toBe(DOCTOR_VERSION_REPORT_VERSION);
  });

  it("carries an unreadable inventory in the report instead of an unexplained empty array", () => {
    const report = buildDoctorVersionReport(
      input({
        components: [],
        componentInventory: unknown("DOCTOR_COMPONENT_INVENTORY_EMPTY", "DOCTOR_VERSION_HOST"),
      }),
    );
    expect(report.componentCount).toBe(0);
    expect(report.componentInventory).toEqual({
      known: false,
      code: "DOCTOR_COMPONENT_INVENTORY_EMPTY",
      layer: "DOCTOR_VERSION_HOST",
    });
  });

  /**
   * Built from RAW literals rather than the known()/unknown() factories on
   * purpose. A report that only freezes when its caller already froze the parts
   * is not a frozen report, and the factories would hide that.
   */
  it("freezes the nested values, not merely the top level", () => {
    const raw = { known: true as const, value: "v24.16.0" };
    const report = buildDoctorVersionReport(
      input({
        observed: { node: raw, pnpm: raw, platform: raw, arch: raw },
        components: [{ name: "@moe/daemon", version: { known: true as const, value: "0.0.0" } }],
      }),
    );
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.observed)).toBe(true);
    expect(Object.isFrozen(report.observed.node)).toBe(true);
    expect(Object.isFrozen(report.declared.nodeVersionFile)).toBe(true);
    expect(Object.isFrozen(report.pins)).toBe(true);
    expect(Object.isFrozen(report.pins[0])).toBe(true);
    expect(Object.isFrozen(report.components)).toBe(true);
    expect(Object.isFrozen(report.components[0])).toBe(true);
    expect(Object.isFrozen(report.components[0]?.version)).toBe(true);
    expect(Object.isFrozen(report.componentInventory)).toBe(true);
  });
});
