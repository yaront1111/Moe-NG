import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * EVERY MODULE IN THIS DIRECTORY IS PACKAGED FOR THE NATIVE RUNTIME.
 *
 * `wrapper-lane.ts` spawns the wrapper with `node --experimental-transform-types`. Type stripping
 * removes types; it does NOT rewrite a `./foo.js` specifier to `foo.ts`. Every runtime-loaded
 * module here therefore needs a one-line `.js` bridge beside it, and two shipped without one —
 * the wrapper died at import before any staffing while vitest and `tsc`, which both resolve
 * `./foo.js` to `foo.ts` themselves, stayed green.
 *
 * WHAT THIS ADDS OVER `wrapper-entrypoint.test.ts`, which already loads the two public
 * entrypoints natively and is the gate that catches the defect above: that probe can only see
 * modules the entrypoints already import. A module written before its call site is wired, or a
 * bridge left behind by a deleted module, is invisible to it and visible here. These arms cost no
 * process spawn, so the cheap check runs everywhere the expensive one does.
 *
 * NO COUNT IS FROZEN. Both rosters are read off the directory at run time — a concurrent row
 * adding a module must not have to come back and bump a literal here. The two lower bounds are
 * denominators only: they fail a sweep that silently matched nothing, not a directory that grew.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const entries = readdirSync(HERE);

/** Test modules load only under vitest, which resolves `.js` specifiers itself. */
const runtimeSources = entries.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
const bridges = entries.filter((name) => name.endsWith(".js"));

describe("orchestrator .js bridges", () => {
  it("resolves every relative .js specifier a runtime-loaded module imports", () => {
    const misses: string[] = [];
    let specifiers = 0;
    for (const source of runtimeSources) {
      const text = readFileSync(`${HERE}/${source}`, "utf8");
      // `from "./x.js"` covers static and re-export forms; the alternation adds bare
      // side-effect `import "./x.js"` and dynamic `import("./x.js")`, which no module here
      // uses TODAY — a sweep that only matches the forms already in use cannot catch the
      // first file to introduce another one.
      const specifier = /(?:from|import\s*\(?)\s*"\.\/([A-Za-z0-9._-]+\.js)"/gu;
      for (const [, target] of text.matchAll(specifier)) {
        if (target === undefined) continue;
        specifiers += 1;
        if (!existsSync(`${HERE}/${target}`)) misses.push(`${source} -> ./${target}`);
      }
    }
    expect(specifiers).toBeGreaterThan(20);
    expect(misses).toStrictEqual([]);
  });

  it("keeps every bridge canonical and backed by a real module", () => {
    const broken: string[] = [];
    for (const bridge of bridges) {
      const source = `${bridge.slice(0, -3)}.ts`;
      const body = readFileSync(`${HERE}/${bridge}`, "utf8").trim();
      if (!existsSync(`${HERE}/${source}`)) broken.push(`${bridge}: no ${source}`);
      else if (body !== `export * from "./${source}";`) broken.push(`${bridge}: ${body}`);
    }
    expect(bridges.length).toBeGreaterThan(20);
    expect(broken).toStrictEqual([]);
  });
});
