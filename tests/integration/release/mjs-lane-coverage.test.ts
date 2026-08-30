import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const INTEGRATION_ROOT = join(REPO_ROOT, "tests", "integration");

/**
 * EVERY `node:test` harness under `tests/integration` IS REACHED BY A NAMED LANE.
 *
 * THE MECHANISM THIS EXISTS TO CATCH, because it is not a typo and it will recur. Two files sit
 * one path segment apart and share a basename:
 *
 *   tests/integration/release-supply-chain.test.mjs          (1937 lines, listed)
 *   tests/integration/release/release-supply-chain.test.mjs  (146 lines, was NOT listed)
 *
 * `package.json`'s `test:integration` names the first; a reader scanning the list sees the
 * basename and believes both are covered. The second went unrun from the day it was written —
 * it is task-bf2b2aac's DoD-4 forgery harness, which stages a forged pnpm first on PATH and
 * asserts `FORGED_PNPM_EXECUTED` appears nowhere. A supply-chain guard that no lane runs is
 * indistinguishable from one that does, until it is not.
 *
 * THE DISCRIMINATOR IS NEVER THE NAME. It is enumerating what the runner actually globs against
 * what exists on disk, which is exactly what this file does.
 *
 * WHY HERE AND NOT IN `tests/security/lane-smoke.security.ts`: this path is reached by BOTH the
 * root lane (`vitest.config.ts` includes `tests/**​/*.test.ts`) and the integration lane
 * (`vitest run tests/integration`), whereas `tests/security/vitest.config.ts` includes only
 * `**​/*.security.ts` and so runs in neither.
 */

/** Disk yields `\` on Windows; `package.json` holds `/`. Compare in one spelling. */
function slashes(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Every `.test.mjs` under `tests/integration`, FROM DISK so an untracked file also counts. */
function discoveredHarnesses(): readonly string[] {
  return readdirSync(INTEGRATION_ROOT, { recursive: true, withFileTypes: false })
    .map((entry) => slashes(String(entry)))
    .filter((entry) => entry.endsWith(".test.mjs"))
    .map((entry) => `tests/integration/${entry}`)
    .sort();
}

/** The paths `test:integration` hands to `node --test`. */
function lanePaths(): readonly string[] {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { readonly scripts?: Readonly<Record<string, string>> };
  const script = manifest.scripts?.["test:integration"] ?? "";
  const marker = "node --test ";
  const index = script.indexOf(marker);
  if (index === -1) return [];
  return script
    .slice(index + marker.length)
    .split(/\s+/u)
    .filter((segment) => segment.endsWith(".test.mjs"))
    .map(slashes)
    .sort();
}

describe("every node:test harness under tests/integration is run by a named lane", () => {
  it("lists exactly the .test.mjs files that exist on disk", () => {
    const discovered = discoveredHarnesses();
    const listed = lanePaths();

    // NON-VACUITY FIRST. A readdir that found nothing, or a parse that silently yielded nothing,
    // makes the set-equality below trivially true and the guard passes forever. These two
    // assertions are what stop this file becoming decoration.
    expect(discovered.length, `discovered: ${JSON.stringify(discovered)}`).toBeGreaterThan(0);
    expect(listed.length, `parsed from test:integration: ${JSON.stringify(listed)}`)
      .toBeGreaterThan(0);

    // SET EQUALITY, BOTH DIRECTIONS — not a subset. Left-to-right catches a harness on disk that
    // no lane runs (the defect this file was written for); right-to-left catches a listed path
    // that no longer exists, which would make `node --test` fail on a stale name.
    // Deliberately NO hard-coded count: set-equality already reds a new unlisted file, and a
    // count would force two edits for one legitimate addition.
    expect(discovered).toEqual(listed);
  });
});
