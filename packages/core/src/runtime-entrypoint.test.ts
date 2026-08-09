import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SRC_ROOT, "..");
const MODULE_ENTRY = resolve(SRC_ROOT, "index.ts");

/**
 * vitest resolves a `./foo.js` specifier back to `foo.ts`; Node does not, and
 * `--experimental-strip-types` strips types without adding TypeScript's
 * `.js` -> `.ts` resolution. A missing bridge is therefore invisible to every
 * other suite in this repo, so these probes run in a REAL child Node process —
 * running them in-process would prove nothing.
 *
 * cwd is the package root so the bare specifier `@moe/core` resolves through
 * this package's own `exports` map via Node's self-reference rule, which is the
 * exact resolution `apps/daemon` gets. A relative path would sidestep the export
 * map and test something weaker.
 */
const probe = async (source: string): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: PACKAGE_ROOT },
  );
  return JSON.parse(stdout) as unknown;
};

const REPORT_ROOT_ENTRY = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/core");
  const keys = Object.keys(ns).filter((key) => key !== "default");
  report({
    outcome: "IMPORTED",
    hasNamedExports: keys.length > 0,
    undefinedBindingCount: keys.filter((key) => ns[key] === undefined).length,
    reduceProject: typeof ns.reduceProject,
    reduceGoal: typeof ns.reduceGoal,
    reducePlanningRun: typeof ns.reducePlanningRun,
    reduceGraphRevision: typeof ns.reduceGraphRevision,
    evaluatePolicy: typeof ns.evaluatePolicy,
    applyApprovalInvalidation: typeof ns.applyApprovalInvalidation,
    authenticateCommand: typeof ns.authenticateCommand,
    policyOutcomesFrozen: Object.isFrozen(ns.POLICY_OUTCOMES),
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

const REPORT_TEST_ONLY_MODULE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  await import("./src/planning/planning-run-test-fixtures.js");
  report({ outcome: "IMPORTED", code: "NONE" });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

it("loads @moe/core in Node's strip-types runtime with its named exports defined", async () => {
  // Asserts the BINDINGS, not the exit code: a child can exit 0 having imported
  // nothing, and an import cycle yields a TDZ-undefined binding that imports
  // cleanly and only fails at first use. `authenticateCommand` arrives through
  // the `export * from "./identity/index.js"` chain, the most cycle-sensitive
  // path on the surface.
  expect(await probe(REPORT_ROOT_ENTRY)).toEqual({
    outcome: "IMPORTED",
    hasNamedExports: true,
    undefinedBindingCount: 0,
    reduceProject: "function",
    reduceGoal: "function",
    reducePlanningRun: "function",
    reduceGraphRevision: "function",
    evaluatePolicy: "function",
    applyApprovalInvalidation: "function",
    authenticateCommand: "function",
    policyOutcomesFrozen: true,
  });
});

it("still refuses an unbridged test-only module with ERR_MODULE_NOT_FOUND", async () => {
  // Negative control. Pins the literal reason code, not merely "it threw": it
  // proves test-only code was kept off the runtime surface AND that the positive
  // probe can still detect a failure rather than passing vacuously.
  expect(await probe(REPORT_TEST_ONLY_MODULE)).toEqual({
    outcome: "FAILED",
    code: "ERR_MODULE_NOT_FOUND",
  });
});

const walk = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const relativeImportTargets = (file: string): readonly string[] =>
  [...readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]*)\.js"/g)].map((match) =>
    resolve(dirname(file), `${match[1]}.ts`),
  );

/**
 * `packages/core/package.json` pins `"exports": { ".": "./src/index.ts" }` — an
 * exclusive map, so no consumer can deep-import. Runtime reachability is
 * therefore EXACTLY reachability from `index.ts`, and that is the rule this
 * audit uses.
 *
 * A name-based rule would be wrong here, and so would the import-direction
 * closure that `@moe/runner` uses: `planning-invariant-drivers.ts` and
 * `planning-invariant-fixtures.ts` are test-only by CONSUMER direction (only
 * `planning-invariants.test.ts` reaches them) while matching no naming
 * convention and importing no name-matched fixture. Both rules would bridge
 * them and put test code on the runtime surface.
 */
const runtimeReachable = (entry: string): ReadonlySet<string> => {
  const seen = new Set<string>([entry]);
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    for (const target of relativeImportTargets(file)) {
      if (seen.has(target)) continue;
      seen.add(target);
      pending.push(target);
    }
  }
  return seen;
};

const bridgeOf = (module: string): string => `${module.slice(0, -".ts".length)}.js`;

const moduleOf = (bridge: string): string => `${bridge.slice(0, -".js".length)}.ts`;

const expectedBridgeSource = (module: string): string =>
  `export * from "./${basename(module, ".ts")}.ts";\n`;

const named = (files: readonly string[]): readonly string[] =>
  files.map((file) => relative(SRC_ROOT, file).split("\\").join("/")).sort();

it("bridges exactly the modules reachable from the package entry point", () => {
  const files = walk(SRC_ROOT);
  const modules = files.filter((file) => file.endsWith(".ts"));
  const runtime = [...runtimeReachable(MODULE_ENTRY)];

  // A sweep that silently generates zero cases passes while testing nothing, and
  // an audit with nothing excluded is not exercising the exclusion at all.
  expect(runtime.length).toBeGreaterThan(0);
  expect(modules.filter((file) => !runtime.includes(file)).length).toBeGreaterThan(0);
  // Every reachable target must be a real module, or the closure walked past a
  // hole and silently stopped short of the modules behind it.
  expect(named(runtime.filter((file) => !modules.includes(file)))).toEqual([]);

  const bridges = files.filter((file) => file.endsWith(".js"));
  const bridged = new Set(bridges);
  const missing = runtime.filter((file) => !bridged.has(bridgeOf(file)));
  const unexpected = bridges.filter((bridge) => !runtime.includes(moduleOf(bridge)));
  // Compared as bytes-through-utf8, so a CRLF bridge is `...";\r\n` and lands
  // here — `git diff --stat` would not have shown it.
  const wrongContent = runtime.filter(
    (file) =>
      bridged.has(bridgeOf(file)) &&
      readFileSync(bridgeOf(file), "utf8") !== expectedBridgeSource(file),
  );

  // Reported by NAME so a regression says which module, not just a count.
  expect({
    missing: named(missing),
    unexpected: named(unexpected),
    wrongContent: named(wrongContent),
  }).toEqual({ missing: [], unexpected: [], wrongContent: [] });
});

/**
 * The four modules that must never gain a bridge. Two match the repo's
 * `*-test-fixtures.ts` convention; two do not, and those two are the whole
 * reason this audit keys on reachability. Pinned by name so promoting one onto
 * the runtime surface is a deliberate, visible decision rather than a silent
 * side effect of a sweep.
 */
const TEST_ONLY_MODULES = [
  "planning/graph-revision-test-fixtures.ts",
  "planning/planning-invariant-drivers.ts",
  "planning/planning-invariant-fixtures.ts",
  "planning/planning-run-test-fixtures.ts",
] as const;

it("keeps the four test-only planning modules off the runtime surface", () => {
  const runtime = runtimeReachable(MODULE_ENTRY);
  const paths = TEST_ONLY_MODULES.map((suffix) => resolve(SRC_ROOT, suffix));

  expect(paths.filter((file) => runtime.has(file)).length).toBe(0);
  expect(named(paths.filter((file) => existsOnDisk(bridgeOf(file))))).toEqual([]);
  // The subjects must still exist; a renamed module would empty this guard.
  expect(named(paths.filter((file) => !existsOnDisk(file)))).toEqual([]);
});

const existsOnDisk = (path: string): boolean => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};
