/**
 * Mechanical guard for the permanent 250-physical-line ceiling on planning sources.
 *
 * The ceiling applies to production, tests, fixtures, drivers, and support files equally, so
 * this sweep has no allowlist, no basename or suffix exception, and no exemption for itself —
 * this file is swept by its own rule, and a test asserts that it appears in the swept set.
 *
 * A failure here is normally NOT a defect in this file. It names the planning source that
 * outgrew the ceiling; the fix belongs in that file, never in an exception added here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Exactly 250: a 250-line file passes and a 251-line file fails. */
const MAX_PHYSICAL_LINES = 250;
/** Vacuity floor. An empty or mis-resolved readdir must fail rather than pass with no work. */
const MINIMUM_SWEPT_FILES = 15;
const TYPESCRIPT_SOURCE = /\.ts$/u;
const LINE_TERMINATOR = /\r\n|\r|\n/u;
const BYTE_ORDER_MARK = "\uFEFF";

const selfPath = fileURLToPath(import.meta.url);
/** Resolved from the module URL, never process.cwd() — vitest runs rooted at the repository. */
const planningDirectory = dirname(selfPath);
const selfName = basename(selfPath);

interface SweptSource {
  readonly file: string;
  readonly lines: number;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Physical lines, counted identically for LF, CRLF, and lone-CR inputs. A trailing terminator
 * ends the last line rather than starting a phantom empty one, and a leading BOM is not a line.
 */
function countPhysicalLines(text: string): number {
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  if (body.length === 0) {
    return 0;
  }
  const segments = body.split(LINE_TERMINATOR);
  return segments[segments.length - 1] === "" ? segments.length - 1 : segments.length;
}

/** Throws on a missing directory, so a wrong path can never look like a clean sweep. */
function sweepTypeScriptSources(directory: string): readonly SweptSource[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && TYPESCRIPT_SOURCE.test(entry.name))
    .map((entry) => ({
      file: entry.name,
      lines: countPhysicalLines(readFileSync(join(directory, entry.name), "utf8")),
    }))
    .sort((left, right) => compareNames(left.file, right.file));
}

const syntheticLines = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`);
const joinedWith = (count: number, terminator: string, trailing: boolean): string =>
  syntheticLines(count).join(terminator) + (trailing ? terminator : "");

describe("planning physical-line counter", () => {
  it("counts LF, CRLF, and lone-CR terminators identically", () => {
    for (const count of [1, 250, 251]) {
      const lf = countPhysicalLines(joinedWith(count, "\n", false));
      expect(lf).toBe(count);
      expect(countPhysicalLines(joinedWith(count, "\r\n", false))).toBe(lf);
      expect(countPhysicalLines(joinedWith(count, "\r", false))).toBe(lf);
    }
  });

  it("does not add a phantom line for a trailing terminator", () => {
    for (const terminator of ["\n", "\r\n", "\r"]) {
      expect(countPhysicalLines(joinedWith(250, terminator, true))).toBe(250);
      expect(countPhysicalLines(joinedWith(250, terminator, false))).toBe(250);
    }
  });

  it("ignores a leading byte order mark and reports an empty file as zero lines", () => {
    expect(countPhysicalLines(`${BYTE_ORDER_MARK}${joinedWith(3, "\n", true)}`)).toBe(3);
    expect(countPhysicalLines("")).toBe(0);
    expect(countPhysicalLines(BYTE_ORDER_MARK)).toBe(0);
  });

  it("puts the ceiling between 250 and 251 for every terminator", () => {
    for (const terminator of ["\n", "\r\n", "\r"]) {
      for (const trailing of [true, false]) {
        expect(countPhysicalLines(joinedWith(250, terminator, trailing)))
          .toBeLessThanOrEqual(MAX_PHYSICAL_LINES);
        expect(countPhysicalLines(joinedWith(251, terminator, trailing)))
          .toBeGreaterThan(MAX_PHYSICAL_LINES);
      }
    }
  });
});

describe("planning source size guard", () => {
  it("sweeps every TypeScript file in the directory, with no allowlist", () => {
    const swept = sweepTypeScriptSources(planningDirectory);
    const onDisk = readdirSync(planningDirectory)
      .filter((name) => TYPESCRIPT_SOURCE.test(name))
      .sort(compareNames);
    expect(swept.map((entry) => entry.file)).toStrictEqual(onDisk);
  });

  it("refuses to pass vacuously on an empty or mis-resolved directory", () => {
    expect(sweepTypeScriptSources(planningDirectory).length)
      .toBeGreaterThanOrEqual(MINIMUM_SWEPT_FILES);
    expect(() => sweepTypeScriptSources(join(planningDirectory, "no-such-directory"))).toThrow();
  });

  it("sweeps itself, so the guard is subject to its own ceiling", () => {
    const swept = sweepTypeScriptSources(planningDirectory);
    expect(swept.map((entry) => entry.file)).toContain(selfName);
  });

  it("detects and sorts offenders rather than reporting an empty list unconditionally", () => {
    const swept = sweepTypeScriptSources(planningDirectory);
    const strict = swept.filter((entry) => entry.lines > 100);
    expect(strict.length).toBeGreaterThan(0);
    expect(strict.map((entry) => entry.file))
      .toStrictEqual([...strict.map((entry) => entry.file)].sort(compareNames));
  });

  it("keeps every planning source at or under the ceiling", () => {
    const offenders = sweepTypeScriptSources(planningDirectory)
      .filter((entry) => entry.lines > MAX_PHYSICAL_LINES);
    expect(offenders).toStrictEqual([]);
  });
});
