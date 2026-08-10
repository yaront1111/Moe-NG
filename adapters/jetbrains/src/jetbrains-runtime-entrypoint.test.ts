import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SRC_ROOT, "..");
const CHILD_TIMEOUT_MS = 30_000;
const CHILD_KILL_MS = 20_000;

/**
 * vitest rewrites a `./foo.js` specifier back to `foo.ts` and resolves workspace
 * packages through its own aliasing; Node does neither. A missing bridge or an
 * undeclared dependency is therefore invisible to every other suite in this
 * repo, so these probes run in a REAL child Node process.
 *
 * cwd is the package root, so `@moe/jetbrains-adapter` resolves through this
 * package's own `exports` map via Node's self-reference rule, and the two
 * dependency specifiers resolve through THIS package's node_modules — which is
 * what makes them a proof of the dependency EDGE rather than of a copied symbol.
 */
const probe = async (source: string): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    // The child is killed on timeout rather than left to outlive the run.
    { cwd: PACKAGE_ROOT, timeout: CHILD_KILL_MS },
  );
  return JSON.parse(stdout) as unknown;
};

const REPORT_ROOT_ENTRY = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/jetbrains-adapter");
  const keys = Object.keys(ns).filter((key) => key !== "default");
  report({
    outcome: "IMPORTED",
    hasNamedExports: keys.length > 0,
    undefinedBindingCount: keys.filter((key) => ns[key] === undefined).length,
    createSessionType: typeof ns.createJetBrainsSession,
    admitType: typeof ns.admitDistribution,
    requiredKinds: Array.isArray(ns.JETBRAINS_REQUIRED_COMPONENT_KINDS)
      ? [...ns.JETBRAINS_REQUIRED_COMPONENT_KINDS]
      : null,
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

/**
 * Resolves the IDE contract FROM this package. A copied vocabulary would satisfy
 * every in-process assertion in the sibling suite and fail here.
 */
const REPORT_CONTRACT_EDGE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/ide-adapter-contract");
  report({
    outcome: "IMPORTED",
    reasonCodeCount: Array.isArray(ns.IDE_ADAPTER_REASON_CODES)
      ? ns.IDE_ADAPTER_REASON_CODES.length
      : -1,
    layerCount: Array.isArray(ns.IDE_ADAPTER_LAYERS) ? ns.IDE_ADAPTER_LAYERS.length : -1,
    decideDaemonStartType: typeof ns.decideDaemonStart,
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

/**
 * Resolves @moe/contracts FROM this package AND calls into it. Type-stripping
 * erases every `export type`, so only a value proves the edge: a type-only
 * publication would leave this namespace decoratively non-empty and undefined
 * at the point of use. This is the exact specifier that produced TS2305 before
 * the distribution vocabulary was published at the barrel.
 */
const REPORT_CONTRACTS_EDGE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/contracts");
  report({
    outcome: "IMPORTED",
    manifestVersion: ns.DISTRIBUTION_MANIFEST_VERSION,
    distributionRefusalType: typeof ns.distributionRefusal,
    refusal: ns.distributionRefusal("API_RANGE_MISMATCH", "DISTRIBUTION_STARTUP"),
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

it("loads @moe/jetbrains-adapter in Node's strip-types runtime with its values defined",
  async () => {
    // Asserts the BINDINGS, not the exit code: a child can exit 0 having imported
    // nothing, and an import cycle yields a TDZ-undefined binding that imports
    // cleanly and only fails at first use.
    expect(await probe(REPORT_ROOT_ENTRY)).toEqual({
      admitType: "function",
      createSessionType: "function",
      hasNamedExports: true,
      outcome: "IMPORTED",
      requiredKinds: ["CONTROL_ROOM", "DAEMON"],
      undefinedBindingCount: 0,
    });
  }, CHILD_TIMEOUT_MS);

it("resolves @moe/ide-adapter-contract FROM this package, proving the edge", async () => {
  expect(await probe(REPORT_CONTRACT_EDGE)).toEqual({
    decideDaemonStartType: "function",
    layerCount: 4,
    outcome: "IMPORTED",
    reasonCodeCount: 14,
  });
}, CHILD_TIMEOUT_MS);

it("resolves @moe/contracts FROM this package and produces a real refusal", async () => {
  expect(await probe(REPORT_CONTRACTS_EDGE)).toEqual({
    distributionRefusalType: "function",
    manifestVersion: "moe-distribution-manifest/1",
    outcome: "IMPORTED",
    refusal: {
      code: "DISTRIBUTION_MISMATCH",
      ok: false,
      reason: "API_RANGE_MISMATCH",
      refusedBy: "DISTRIBUTION_STARTUP",
    },
  });
}, CHILD_TIMEOUT_MS);

it("still refuses an unbridged test module with ERR_MODULE_NOT_FOUND", async () => {
  // Negative control. Pins the LITERAL reason code, not merely "it threw": it
  // proves test-tier code was kept off the runtime surface AND that the positive
  // probes above can still detect a failure rather than passing vacuously.
  expect(await probe(reportUnbridged("./src/jetbrains-adapter.test.js"))).toEqual({
    code: "ERR_MODULE_NOT_FOUND",
    outcome: "FAILED",
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

type BridgeVerdict = "bridge" | "imports-vitest" | "test-file";

/** A module earns a bridge unless it is test tier, decided by suffix OR content. */
const classify = (file: string): BridgeVerdict => {
  if (file.endsWith(".test.ts")) return "test-file";
  return /from\s+"vitest"/u.test(readFileSync(file, "utf8")) ? "imports-vitest" : "bridge";
};

const bridgeOf = (module: string): string => `${module.slice(0, -".ts".length)}.js`;

const moduleOf = (bridge: string): string => `${bridge.slice(0, -".js".length)}.ts`;

const expectedBridgeSource = (module: string): string =>
  `export * from "./${basename(module, ".ts")}.ts";\n`;

const named = (files: readonly string[]): readonly string[] =>
  files.map((file) => relative(SRC_ROOT, file).split("\\").join("/")).sort();

it("bridges exactly the non-test modules of this package", () => {
  const files = walk(SRC_ROOT);
  const modules = files.filter((file) => file.endsWith(".ts"));
  const expected = modules.filter((file) => classify(file) === "bridge");
  const excluded = modules.filter((file) => classify(file) !== "bridge");

  // A sweep that silently generates zero cases passes while testing nothing, and
  // an audit with nothing excluded never exercises the exclusion at all.
  expect(expected.length).toBeGreaterThan(0);
  expect(excluded.length).toBeGreaterThan(0);
  expect(named(expected)).toContain("index.ts");

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
    "jetbrains-adapter.test.ts": "test-file",
    "jetbrains-runtime-entrypoint.test.ts": "test-file",
  });
});

it("bridges every module reachable from the package entry point", () => {
  const entry = resolve(SRC_ROOT, "index.ts");
  const relativeTargets = (file: string): readonly string[] =>
    [...readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]*)\.js"/gu)].map((match) =>
      resolve(dirname(file), `${match[1]}.ts`),
    );
  const seen = new Set<string>([entry]);
  const pending = [entry];
  while (pending.length > 0) {
    for (const target of relativeTargets(pending.pop() as string)) {
      if (seen.has(target)) continue;
      seen.add(target);
      pending.push(target);
    }
  }

  expect(seen.size).toBeGreaterThan(0);
  expect(named([...seen].filter((file) => !isFile(file)))).toEqual([]);
  expect(named([...seen].filter((file) => !isFile(bridgeOf(file))))).toEqual([]);
});
