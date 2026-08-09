import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SRC_ROOT, "..");
const ENTRY_MODULE = resolve(SRC_ROOT, "index.ts");

/**
 * vitest rewrites a `./foo.js` specifier back to `foo.ts` and `tsc` never reads
 * the bridges at all, so a missing `.js` bridge is invisible to every other
 * suite in this package. These probes therefore run in a REAL child Node
 * process; in-process they would prove nothing.
 *
 * cwd is the package root so the bare specifier `@moe/daemon` resolves through
 * this package's own `exports` map by Node's self-reference rule — the exact
 * resolution an external dependent gets. A relative path would sidestep the
 * export map and test something weaker.
 */
const probe = async (source: string): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: PACKAGE_ROOT },
  );
  return JSON.parse(stdout) as unknown;
};

const REPORT_ROOT_NAMESPACE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/daemon");
  const keys = Object.keys(ns).filter((key) => key !== "default");
  report({
    outcome: "IMPORTED",
    hasNamedExports: keys.length > 0,
    undefinedBindings: keys.filter((key) => ns[key] === undefined),
    claimWork: typeof ns.claimWork,
    evaluateGraphPreviewRequestBytes: typeof ns.evaluateGraphPreviewRequestBytes,
    goalHandlersFrozen: Object.isFrozen(ns.GOAL_HANDLERS),
    readEventPage: typeof ns.readEventPage,
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

const REPORT_TEST_TIER_MODULE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  await import("./src/work/work-race-fixtures.js");
  report({ outcome: "IMPORTED", code: "NONE" });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

it("loads the @moe/daemon root namespace under Node with no undefined binding", async () => {
  // The existing package-root case in graph-preview-request.test.ts imports ONE
  // named export. This one takes the whole namespace, because an import cycle
  // yields a TDZ-undefined binding that imports cleanly and only fails at first
  // use, and cycles resolve differently per entry point. Reported by NAME so a
  // regression says which binding died. Asserting the child's exit code alone
  // would be vacuous: a process can exit 0 having imported nothing.
  expect(await probe(REPORT_ROOT_NAMESPACE)).toEqual({
    outcome: "IMPORTED",
    hasNamedExports: true,
    undefinedBindings: [],
    claimWork: "function",
    evaluateGraphPreviewRequestBytes: "function",
    goalHandlersFrozen: true,
    readEventPage: "function",
  });
});

it("still refuses an unbridged test-tier module with ERR_MODULE_NOT_FOUND", async () => {
  // Negative control, pinning the literal reason code rather than "it threw":
  // it proves test scaffolding was kept OFF the runtime surface and that the
  // probe above can still detect a failure instead of passing vacuously.
  expect(await probe(REPORT_TEST_TIER_MODULE)).toEqual({
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

const testSiblingOf = (module: string): string => `${module.slice(0, -".ts".length)}.test.ts`;

/**
 * Runtime tier is a forward CLOSURE from published units, not a filename suffix.
 * `@moe/runner` can seed its tier from `-test-fixtures.ts` names; this package
 * cannot — `event-stream-fixtures.ts` and the whole `work-race-*` family are
 * scaffolding whose names match no such rule, while `http-adapter.ts` is
 * production code that today has no importer except its own test.
 *
 * So the seed is the package entry plus every module carrying its OWN
 * `<name>.test.ts` sibling — a module under direct test is a published unit —
 * and the tier is everything those reach. Scaffolding is what is left: imported
 * only BY tests, never reached FROM a published unit.
 */
const runtimeTierModules = (
  modules: readonly string[],
  present: ReadonlySet<string>,
): ReadonlySet<string> => {
  const tier = new Set(
    modules.filter((file) => file === ENTRY_MODULE || present.has(testSiblingOf(file))),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of [...tier]) {
      for (const target of relativeImportTargets(file)) {
        if (!present.has(target) || tier.has(target)) continue;
        tier.add(target);
        changed = true;
      }
    }
  }
  return tier;
};

const bridgeOf = (module: string): string => `${module.slice(0, -".ts".length)}.js`;

const expectedBridgeSource = (module: string): string =>
  `export * from "./${basename(module, ".ts")}.ts";\n`;

it("has an exact .js bridge for every runtime module and none for test-tier ones", () => {
  const files = walk(SRC_ROOT);
  const present = new Set(files);
  const modules = files.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const runtime = runtimeTierModules(modules, present);
  const testTier = modules.filter((file) => !runtime.has(file));

  // A sweep that silently generates zero cases passes while testing nothing,
  // and the two judgement calls are pinned by name so a future filename-based
  // rewrite of the rule cannot flip them back without reddening this case.
  expect(runtime.size).toBeGreaterThan(0);
  expect(testTier.length).toBeGreaterThan(0);
  expect(runtime.has(resolve(SRC_ROOT, "http/http-adapter.ts"))).toBe(true);
  expect(runtime.has(resolve(SRC_ROOT, "work/work-race-fixtures.ts"))).toBe(false);

  const bridges = new Set(files.filter((file) => file.endsWith(".js")));
  const missing = [...runtime].filter((file) => !bridges.has(bridgeOf(file)));
  const unexpected = [...bridges].filter((bridge) => {
    const module = `${bridge.slice(0, -".js".length)}.ts`;
    return !present.has(module) || !runtime.has(module);
  });
  const wrongContent = [...runtime].filter(
    (file) =>
      bridges.has(bridgeOf(file)) &&
      readFileSync(bridgeOf(file), "utf8") !== expectedBridgeSource(file),
  );

  // Report by NAME so a regression says which module, not merely a count.
  expect({
    missing: missing.map((file) => relative(SRC_ROOT, file)),
    unexpected: unexpected.map((file) => relative(SRC_ROOT, file)),
    wrongContent: wrongContent.map((file) => relative(SRC_ROOT, file)),
  }).toEqual({ missing: [], unexpected: [], wrongContent: [] });
});
