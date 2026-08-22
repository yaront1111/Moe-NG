import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isTestArtifact } from "../../../tools/packaging/pack-inventory.js";
import { findWorkspacePackages, walkFiles } from "../../../tools/packaging/pack-staging.js";

/**
 * The artifact's test-artifact rules, judged against the REAL workspace tree
 * rather than a fixture. A prune list validated by cases the list already catches
 * detaches from the tree it is supposed to police: v0.1 shipped 25 of this repo's
 * own test artifacts past a gate whose single case passed.
 */


const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Deliberately BROADER than the production rules, and written from a different
 * angle: any path component that reads as test vocabulary. Its job is to find the
 * shapes a hand-written suffix list forgot, so it is not derived from that list —
 * a matcher validated by cases the matcher already catches proves nothing.
 */
const TEST_VOCABULARY = /(^|[/._-])(tests?|specs?|mocks?|fixtures?|harness)([/._-]|$)/iu;

/**
 * Cargo's build output: gitignored, never staged by `pnpm deploy`, and full of
 * `test-integration-*` fingerprint stubs that are neither source nor shippable.
 */
const BUILD_OUTPUT = "target";

/**
 * The ONE production file the sweep catches: `native/src/spec.rs` is `mod spec;`
 * in `native/src/lib.rs`. Each entry must still be FOUND by the sweep, so an
 * exemption cannot quietly outlive the file it excuses.
 */
const PRODUCTION_EXCEPTIONS = Object.freeze([
  "packages/runner/src/platform/windows/native/src/spec.rs",
]);

/** Every source file the pack could stage, read off the real tree, not a fixture. */
function workspaceSources(): readonly string[] {
  return findWorkspacePackages(REPO_ROOT).flatMap((entry) => {
    const source = join(REPO_ROOT, entry.sourceDir, "src");
    if (!existsSync(source)) return [];
    return walkFiles(source).map((path) => `${entry.sourceDir}/src/${path}`);
  });
}

const SWEPT = Object.freeze(workspaceSources().filter(
  (path) => !path.split("/").includes(BUILD_OUTPUT) && TEST_VOCABULARY.test(path),
));

describe("isTestArtifact, swept over the real workspace tree", () => {
  it("finds test-shaped files to judge at all, so the sweep is never vacuous", () => {
    expect(SWEPT.length).toBeGreaterThan(0);
  });

  it("refuses every test-shaped file in the tree bar the named production exception", () => {
    const shipped = SWEPT
      .filter((path) => !PRODUCTION_EXCEPTIONS.includes(path))
      .filter((path) => !isTestArtifact(path));
    expect(shipped).toEqual([]);
  });

  it.each([
    ["bare -fixtures.ts, with no 'test' in the name",
      (p: string) => /-fixtures\.tsx?$/u.test(p) && !/-test-fixtures\.tsx?$/u.test(p)],
    ["a file NAMED test-fixtures.ts, which a '-test-fixtures.ts' suffix never ends with",
      (p: string) => p.endsWith("/test-fixtures.ts")],
    ["-test-harness.ts, the sibling of the listed -test-helpers.ts",
      (p: string) => p.endsWith("-test-harness.ts")],
    ["a plain tests/ directory, invisible to a __tests__-only segment list",
      (p: string) => p.split("/").includes("tests")],
  ])("still exercises %s", (_shape, matches: (path: string) => boolean) => {
    const cases = SWEPT.filter(matches);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.filter((path) => !isTestArtifact(path))).toEqual([]);
  });

  it("keeps each production exception honest: still on disk, still admitted", () => {
    for (const path of PRODUCTION_EXCEPTIONS) {
      expect(SWEPT).toContain(path);
      expect(isTestArtifact(path)).toBe(false);
    }
  });

  it("leaves the VENDORED closure alone — pruning it would break the clause beside it", () => {
    expect(isTestArtifact("node_modules/fast-uri/test/uri.test.js")).toBe(false);
    expect(isTestArtifact("node_modules/ajv/lib/vocabularies/__tests__/a.js")).toBe(false);
    expect(isTestArtifact("packages/runner/src/platform/windows/native/tests/job_sweep.rs"))
      .toBe(true);
  });
});
