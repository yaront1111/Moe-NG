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
const GENERATED_MODULE = resolve(SRC_ROOT, "generated", "generated-client.ts");
const CHILD_TIMEOUT_MS = 30_000;
const CHILD_KILL_MS = 20_000;

/**
 * vitest rewrites a `./foo.js` specifier back to `foo.ts`; Node does not, and
 * `--experimental-strip-types` strips types without adding TypeScript's
 * `.js` -> `.ts` resolution. A missing bridge is therefore invisible to every
 * other suite in this repo, so these probes run in a REAL child Node process.
 *
 * cwd is the package root so the bare specifier `@moe/control-room-client`
 * resolves through this package's own `exports` map via Node's self-reference
 * rule — the exact resolution `apps/control-room` gets.
 */
const probe = async (source: string): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    // The child is killed on timeout rather than left to outlive the run: vitest's
    // own test timeout fails the assertion but would not reap the process.
    { cwd: PACKAGE_ROOT, timeout: CHILD_KILL_MS },
  );
  return JSON.parse(stdout) as unknown;
};

const REPORT_ROOT_ENTRY = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/control-room-client");
  const keys = Object.keys(ns).filter((key) => key !== "default");
  report({
    outcome: "IMPORTED",
    hasNamedExports: keys.length > 0,
    undefinedBindingCount: keys.filter((key) => ns[key] === undefined).length,
    createCompatGate: typeof ns.createCompatGate,
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

const REPORT_GENERATED_MODULE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("./src/generated/generated-client.js");
  const keys = Object.keys(ns).filter((key) => key !== "default");
  report({
    outcome: "IMPORTED",
    hasNamedExports: keys.length > 0,
    undefinedBindingCount: keys.filter((key) => ns[key] === undefined).length,
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

const reportUnbridged = (specifier: string): string => `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  await import(${JSON.stringify(specifier)});
  report({ outcome: "IMPORTED", code: "NONE" });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

it("loads @moe/control-room-client in Node's strip-types runtime with createCompatGate defined", async () => {
  // Asserts the BINDING, not the exit code: a child can exit 0 having imported
  // nothing, and an import cycle yields a TDZ-undefined binding that imports
  // cleanly and only fails at first use. `createCompatGate` is the package's
  // public entry point and its only value export — the rest of index.ts is
  // `export type`, which type-stripping erases, so one is the correct count.
  expect(await probe(REPORT_ROOT_ENTRY)).toEqual({
    outcome: "IMPORTED",
    hasNamedExports: true,
    undefinedBindingCount: 0,
    createCompatGate: "function",
  });
}, CHILD_TIMEOUT_MS);

it("loads the generated module through its hand-written sibling bridge", async () => {
  // The bridge beside generated output is hand-written tracked source. The
  // generator was NOT taught to emit it; if it had been, the bridge would be
  // regenerable output that drifts the moment the generator changes.
  expect(await probe(REPORT_GENERATED_MODULE)).toEqual({
    outcome: "IMPORTED",
    hasNamedExports: true,
    undefinedBindingCount: 0,
  });
}, CHILD_TIMEOUT_MS);

it("still refuses an unbridged test module with ERR_MODULE_NOT_FOUND", async () => {
  // Negative control. Pins the LITERAL reason code, not merely "it threw": it
  // proves test-tier code was kept off the runtime surface AND that the positive
  // probes above can still detect a failure rather than passing vacuously.
  expect(await probe(reportUnbridged("./src/client-compat.test.js"))).toEqual({
    outcome: "FAILED",
    code: "ERR_MODULE_NOT_FOUND",
  });
}, CHILD_TIMEOUT_MS);

const walk = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

type BridgeVerdict = "bridge" | "fixtures-suffix" | "helpers-suffix" | "imports-vitest" | "test-file";

/**
 * The rule, stated once and asserted rather than described. A module earns a
 * bridge unless it is test tier, and "test tier" is decided by suffix OR by
 * content: `mem:gotcha-test-tier-modules-have-no-test-suffix` records that a
 * vitest-importing module can carry no naming signal at all.
 */
const classify = (file: string): BridgeVerdict => {
  if (file.endsWith(".test.ts")) return "test-file";
  if (file.endsWith("-test-fixtures.ts")) return "fixtures-suffix";
  if (file.endsWith("-test-helpers.ts")) return "helpers-suffix";
  return /from\s+"vitest"/u.test(readFileSync(file, "utf8")) ? "imports-vitest" : "bridge";
};

const bridgeOf = (module: string): string => `${module.slice(0, -".ts".length)}.js`;

const moduleOf = (bridge: string): string => `${bridge.slice(0, -".js".length)}.ts`;

const expectedBridgeSource = (module: string): string =>
  `export * from "./${basename(module, ".ts")}.ts";\n`;

const named = (files: readonly string[]): readonly string[] =>
  files.map((file) => relative(SRC_ROOT, file).split("\\").join("/")).sort();

it("bridges exactly the non-test modules, generated output included", () => {
  const files = walk(SRC_ROOT);
  const modules = files.filter((file) => file.endsWith(".ts"));
  const expected = modules.filter((file) => classify(file) === "bridge");
  const excluded = modules.filter((file) => classify(file) !== "bridge");

  // A sweep that silently generates zero cases passes while testing nothing, and
  // an audit with nothing excluded never exercises the exclusion at all.
  expect(expected.length).toBeGreaterThan(0);
  expect(excluded.length).toBeGreaterThan(0);
  // The generated subdirectory must be in scope, or a top-level-only sweep would
  // look identical to a complete one.
  expect(expected).toContain(GENERATED_MODULE);

  const bridges = files.filter((file) => file.endsWith(".js"));
  const bridged = new Set(bridges);
  // Compared as bytes-through-utf8, so a CRLF bridge is `...";\r\n` and lands in
  // wrongContent — `git diff --stat` would never have shown it.
  expect({
    missing: named(expected.filter((file) => !bridged.has(bridgeOf(file)))),
    unexpected: named(bridges.filter((bridge) => !expected.includes(moduleOf(bridge)))),
    wrongContent: named(
      expected.filter(
        (file) =>
          bridged.has(bridgeOf(file)) &&
          readFileSync(bridgeOf(file), "utf8") !== expectedBridgeSource(file),
      ),
    ),
  }).toEqual({ missing: [], unexpected: [], wrongContent: [] });
});

it("excludes every test module for a named reason, and only those", () => {
  const modules = walk(SRC_ROOT).filter((file) => file.endsWith(".ts"));
  const verdicts = Object.fromEntries(
    modules
      .filter((file) => classify(file) !== "bridge")
      .map((file) => [named([file])[0], classify(file)] as const),
  );

  // Pinned by name AND reason so promoting one onto the runtime surface, or
  // silently reclassifying it, is a visible decision rather than a side effect.
  expect(verdicts).toEqual({
    "client-compat.test.ts": "test-file",
    "control-room-client-runtime-entrypoint.test.ts": "test-file",
    "generated-coverage.test.ts": "test-file",
    "generator-determinism.test.ts": "test-file",
  });
});

it("bridges every module reachable from the package entry point", () => {
  const relativeTargets = (file: string): readonly string[] =>
    [...readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]*)\.js"/gu)].map((match) =>
      resolve(dirname(file), `${match[1]}.ts`),
    );
  const seen = new Set<string>([MODULE_ENTRY]);
  const pending = [MODULE_ENTRY];
  while (pending.length > 0) {
    for (const target of relativeTargets(pending.pop() as string)) {
      if (seen.has(target)) continue;
      seen.add(target);
      pending.push(target);
    }
  }

  expect(seen.size).toBeGreaterThan(1);
  expect(seen.has(GENERATED_MODULE)).toBe(true);
  expect(named([...seen].filter((file) => !isFile(file)))).toEqual([]);
  expect(named([...seen].filter((file) => !isFile(bridgeOf(file))))).toEqual([]);
});
