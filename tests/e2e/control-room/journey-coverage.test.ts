import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ABSENT_PRODUCTION_IDS,
  DECLARED_SCENARIO_COUNT,
  LATENCY_RECORD,
  LOADING_RECORD,
  SCENARIO_MATRIX,
  UNCOMPOSED_SURFACES,
  coveredScenarios,
  unknownScenarios,
} from "./journey-coverage.js";
import {
  DECLARED_INVARIANT_COUNT,
  DOD2_INVARIANTS,
  coveredInvariants,
  unknownInvariants,
} from "./journey-invariants.js";

/**
 * Node-lane guards for the scenario ledger. Named `*.test.ts`, not `*.spec.ts`, so it
 * runs in the fast `pnpm test:e2e` lane and never launches a browser — the ledger's
 * arithmetic should fail in milliseconds, not behind a bundle build.
 *
 * WHAT THIS FILE IS FOR. A ledger that records seventeen UNKNOWNs is only honest while
 * its entries are true. Two kinds of rot are guarded here:
 *   1. SHRINKAGE — a case deleted, a status flipped, a missing input blanked.
 *   2. STALENESS — a gap silently closing. The day someone ships `cr.graph.ghost` or
 *      mounts `RunsSurface`, these tests go RED and demand the matrix be updated,
 *      instead of the UNKNOWN quietly outliving the gap it described.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..", "..");

/**
 * A hop-counted root breaks silently if this file ever moves, and every scan below
 * would then read an empty tree and pass. Anchor it on something only the real root
 * has, and fail closed rather than scanning nothing.
 */
function repoRoot(): string {
  const manifest = join(REPO_ROOT, "package.json");
  if (!existsSync(manifest) || !existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))) {
    throw new Error(`JOURNEY_COVERAGE_ROOT_UNRESOLVED: ${REPO_ROOT} is not the repository root`);
  }
  return REPO_ROOT;
}

/** Every production source under apps/ and packages/; tests and specs excluded. */
function productionSources(): readonly string[] {
  const root = repoRoot();
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(path);
      } else if (/\.tsx?$/u.test(entry.name) && !/\.(test|spec)\.tsx?$/u.test(entry.name)) {
        found.push(path);
      }
    }
  };
  for (const area of ["apps", "packages"]) {
    const base = join(root, area);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base, { withFileTypes: true })) {
      const src = join(base, pkg.name, "src");
      if (pkg.isDirectory() && existsSync(src)) walk(src);
    }
  }
  return found;
}

const SOURCES = productionSources();
const relative = (path: string): string => path.slice(repoRoot().length + 1).split(sep).join("/");

describe("the scenario ledger's own arithmetic", () => {
  /**
   * The exact twenty, hand-transcribed from spec section 12's table in spec order.
   * A count assertion alone would pass if a case were swapped for a duplicate; this
   * whole-list compare is what makes a substitution fail.
   */
  it("records exactly the twenty scenarios spec section 12 declares", () => {
    expect(SCENARIO_MATRIX.map((scenario) => scenario.id)).toEqual([
      "CR-J1-001", "CR-J1-002", "CR-J2-001", "CR-J2-002", "CR-J2-003",
      "CR-J3-001", "CR-J3-002", "CR-J3-003", "CR-J4-001", "CR-J4-002",
      "CR-J5-001", "CR-J5-002", "CR-S9-001", "CR-S10-001", "CR-S11-001",
      "CR-A11Y-001", "CR-A11Y-002", "CR-CMD-001", "CR-LAG-001", "CR-DOC-001",
    ]);
    expect(SCENARIO_MATRIX).toHaveLength(DECLARED_SCENARIO_COUNT);
    expect(DECLARED_SCENARIO_COUNT).toBe(20);
  });

  it("splits every case into exactly one of COVERED or UNKNOWN", () => {
    const covered = coveredScenarios();
    const unknown = unknownScenarios();
    expect(covered.length + unknown.length).toBe(DECLARED_SCENARIO_COUNT);
    // A ledger where everything is UNKNOWN is a list, not a gate.
    expect(covered.length).toBeGreaterThan(0);
    expect(new Set([...covered, ...unknown].map((scenario) => scenario.id)).size)
      .toBe(DECLARED_SCENARIO_COUNT);
  });

  it("gives every UNKNOWN a non-empty missing input and a named owner", () => {
    const unknown = unknownScenarios();
    expect(unknown.length).toBeGreaterThan(0);
    for (const scenario of unknown) {
      expect(scenario.missingInput.trim(), `${scenario.id} missingInput`).not.toBe("");
      expect(scenario.owner.trim(), `${scenario.id} owner`).not.toBe("");
      // An UNKNOWN that does not say what is missing is indistinguishable from a
      // silent pass, so a one-word placeholder is refused too.
      expect(scenario.missingInput.length, `${scenario.id} missingInput`).toBeGreaterThan(20);
    }
  });

  it("gives every COVERED case a bar and production files that resolve on disk", () => {
    const covered = coveredScenarios();
    expect(covered.length).toBeGreaterThan(0);
    for (const scenario of covered) {
      expect(scenario.bar.trim(), `${scenario.id} bar`).not.toBe("");
      expect(scenario.productionFiles.length, `${scenario.id} files`).toBeGreaterThan(0);
      for (const file of scenario.productionFiles) {
        expect(existsSync(join(repoRoot(), file)), `${scenario.id} -> ${file}`).toBe(true);
      }
    }
  });

  /**
   * The latency half of the inherited obligation. It stays UNKNOWN because no
   * reference machine is named anywhere; pinning the status here is what stops it
   * being flipped to a silent pass without someone noticing.
   */
  it("keeps latency an UNKNOWN naming the undefined reference machine", () => {
    expect(LATENCY_RECORD.status).toBe("UNKNOWN");
    expect(LATENCY_RECORD.cause).toBe("REFERENCE_MACHINE_UNDEFINED");
    expect(LATENCY_RECORD.missingInput.trim()).not.toBe("");
    expect(LATENCY_RECORD.owner).toContain("HUMAN DECISION");
  });

  /**
   * The loading half, and the reason this task was reopened. It stays UNKNOWN because
   * no served entry point composes a pending state — the components exist, so this is
   * NOT the absent-surface case and a file check would pass for every one of them.
   * Pinning the status is what stops it being flipped to a silent pass; pinning the
   * CAUSE is what stops it being quietly downgraded to "surface absent", which would
   * point the next reader at the wrong owner.
   */
  it("keeps loading an UNKNOWN naming the uncomposed pending state", () => {
    expect(LOADING_RECORD.status).toBe("UNKNOWN");
    expect(LOADING_RECORD.cause).toBe("SURFACE_NOT_COMPOSED");
    expect(LOADING_RECORD.missingInput.trim()).not.toBe("");
    expect(LOADING_RECORD.owner.trim()).not.toBe("");
    // The record is only useful if it says which ids are stranded, so a later reader
    // can check them rather than re-deriving the finding.
    for (const id of ["cr.board.skeleton", "cr.goals.loading", "cr.health.loading"]) {
      expect(LOADING_RECORD.missingInput, `missingInput names ${id}`).toContain(id);
    }
  });
});

describe("the ledger's UNKNOWNs still describe real gaps", () => {
  /**
   * Every scan below is worthless if it walked an empty tree, and an empty tree is
   * exactly what a moved file or a renamed directory produces. Pin the corpus first.
   */
  it("scanned a real production corpus", () => {
    expect(SOURCES.length).toBeGreaterThan(400);
    expect(SOURCES.some((path) => relative(path) === "apps/control-room/src/kernel.tsx")).toBe(true);
  });

  it.each([...ABSENT_PRODUCTION_IDS])("%s still resolves to zero production files", (id) => {
    const carriers = SOURCES
      .filter((path) => readFileSync(path, "utf8").includes(id))
      .map(relative);
    expect(carriers).toEqual([]);
  });

  /**
   * The subtler half, and the one a file-existence check cannot catch: these
   * components EXIST but nothing mounts them, so a browser can never reach them.
   * Asserted as an import-specifier match rather than a text match, so a comment
   * naming the module does not read as a composition.
   */
  it.each([...UNCOMPOSED_SURFACES])(
    "$file exists but is composed by nothing ($scenario)",
    ({ file, importedBySpecifier }) => {
      expect(existsSync(join(repoRoot(), file)), `${file} should exist`).toBe(true);
      const specifier = new RegExp(`from\\s+["'][^"']*${importedBySpecifier}[^"']*["']`, "u");
      const importers = SOURCES
        .filter((path) => relative(path) !== file && specifier.test(readFileSync(path, "utf8")))
        .map(relative);
      expect(importers).toEqual([]);
    },
  );

  /**
   * CR-S10-001's own reason, which is different again: the banner IS mounted, but the
   * served preview supplies no breaker fact and the component fails closed on an
   * absent one. The day the preview passes a breaker, this goes red.
   */
  it("the served preview still supplies no circuit-breaker fact", () => {
    const preview = join(repoRoot(), "apps/control-room/src/preview/control-room-preview.tsx");
    expect(existsSync(preview)).toBe(true);
    expect(readFileSync(preview, "utf8")).not.toMatch(/\bbreaker=/u);
  });

  /**
   * The loading gap's rot guard, and it covers BOTH served entry points because
   * main.tsx branches: `?live=1` renders LiveControlRoom, everything else renders
   * ControlRoomScaffold -> ControlRoomPreview. Guarding only the preview would leave
   * the invariant able to become reachable down the live path while the ledger still
   * called it UNKNOWN — the exact rot this file exists to prevent.
   *
   * The day either path passes a loading prop, this goes RED and demands the record
   * be re-measured rather than letting the UNKNOWN outlive its gap.
   */
  it.each([
    ["apps/control-room/src/preview/control-room-preview.tsx", "the fixture path"],
    ["apps/control-room/src/live/live-app.tsx", "the ?live=1 path"],
    ["apps/control-room/src/live/live-board.tsx", "the live board it mounts"],
  ])("%s still composes no pending state (%s)", (file) => {
    const path = join(repoRoot(), file);
    // Fail closed on a rename: a guard reading a file that no longer exists would
    // otherwise assert over an empty string and pass while proving nothing.
    expect(existsSync(path), `${file} should exist`).toBe(true);
    expect(readFileSync(path, "utf8")).not.toMatch(/\bloading=/u);
  });
});

/**
 * DoD 2's OWN LIST, which nothing in this repository enumerated until now. The first
 * pass of this gate asserted five of the seven invariants, recorded latency, and said
 * nothing about loading — and no test noticed, because there was no list for an
 * invariant to be missing from. These assertions are that list.
 */
describe("the DoD 2 invariant ledger", () => {
  const SPEC = readFileSync(join(HERE, "journeys.spec.ts"), "utf8");

  it("records exactly the seven invariants DoD 2 names, in its order", () => {
    expect(DOD2_INVARIANTS.map((invariant) => invariant.id)).toEqual([
      "TRUTH", "PROVENANCE", "KEYBOARD", "NARROW_WINDOW", "LOADING", "DEGRADED", "LATENCY",
    ]);
    expect(DOD2_INVARIANTS).toHaveLength(DECLARED_INVARIANT_COUNT);
    expect(DECLARED_INVARIANT_COUNT).toBe(7);
  });

  it("splits every invariant into exactly one of COVERED or UNKNOWN", () => {
    const covered = coveredInvariants();
    const unknown = unknownInvariants();
    expect(covered.length + unknown.length).toBe(DECLARED_INVARIANT_COUNT);
    // A ledger where every invariant is UNKNOWN is a list, not a gate.
    expect(covered.length).toBeGreaterThan(0);
    expect(unknown.map((invariant) => invariant.id)).toEqual(["LOADING", "LATENCY"]);
  });

  it("gives every UNKNOWN invariant a non-empty missing input and a named owner", () => {
    const unknown = unknownInvariants();
    expect(unknown.length).toBeGreaterThan(0);
    for (const invariant of unknown) {
      expect(invariant.missingInput.trim(), `${invariant.id} missingInput`).not.toBe("");
      expect(invariant.owner.trim(), `${invariant.id} owner`).not.toBe("");
      expect(invariant.cause.trim(), `${invariant.id} cause`).not.toBe("");
      expect(invariant.missingInput.length, `${invariant.id} missingInput`).toBeGreaterThan(20);
    }
  });

  /**
   * THE LOAD-BEARING ASSERTION of this block. A COVERED invariant claims a browser
   * proves it; this checks the named test actually exists in the file that would run
   * it. Delete the keyboard test and the ledger goes RED instead of continuing to
   * claim the invariant holds — which is precisely what did NOT happen for loading.
   */
  it("resolves every COVERED invariant to real tests in journeys.spec.ts", () => {
    // Non-vacuity first: a spec file that failed to read, or whose declaration style
    // changed, would make every `includes` below pass over nothing.
    expect((SPEC.match(/^test\(/gmu) ?? []).length).toBeGreaterThan(0);
    const covered = coveredInvariants();
    expect(covered.length).toBeGreaterThan(0);
    for (const invariant of covered) {
      expect(invariant.bar.trim(), `${invariant.id} bar`).not.toBe("");
      expect(invariant.provenBy.length, `${invariant.id} provenBy`).toBeGreaterThan(0);
      for (const title of invariant.provenBy) {
        expect(SPEC.includes(`test("${title}"`), `${invariant.id} -> ${title}`).toBe(true);
      }
    }
  });
});
