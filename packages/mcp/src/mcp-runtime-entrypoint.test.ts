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
const CHILD_TIMEOUT_MS = 30_000;
const CHILD_KILL_MS = 20_000;

/**
 * vitest rewrites a `./foo.js` specifier back to `foo.ts`; Node does not, and
 * `--experimental-strip-types` strips types without adding TypeScript's
 * `.js` -> `.ts` resolution. A missing bridge is therefore invisible to every
 * other suite in this repo, so these probes run in a REAL child Node process.
 *
 * cwd is the package root so the bare specifier `@moe/mcp` resolves through this
 * package's own `exports` map via Node's self-reference rule — the exact
 * resolution a consumer gets. A relative path would sidestep the map.
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
  const ns = await import("@moe/mcp");
  const keys = Object.keys(ns).filter((key) => key !== "default");
  report({
    outcome: "IMPORTED",
    hasNamedExports: keys.length > 0,
    undefinedBindingCount: keys.filter((key) => ns[key] === undefined).length,
    createStdioMcpServer: typeof ns.createStdioMcpServer,
    decodeAndDispatch: typeof ns.decodeAndDispatch,
    readBootstrapCredential: typeof ns.readBootstrapCredential,
    generateStdioToolEntries: typeof ns.generateStdioToolEntries,
    toolLabelForKind: typeof ns.toolLabelForKind,
    credentialEnv: typeof ns.MOE_SESSION_CREDENTIAL_ENV,
    toolEntriesNonEmpty: Array.isArray(ns.STDIO_TOOL_ENTRIES) && ns.STDIO_TOOL_ENTRIES.length > 0,
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE", specifier: error.url ?? "NO_URL" });
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

it("loads @moe/mcp in Node's strip-types runtime with its named exports defined", async () => {
  // Asserts the BINDINGS, not the exit code: a child can exit 0 having imported
  // nothing, and an import cycle yields a TDZ-undefined binding that imports
  // cleanly and only fails at first use. This also exercises the one third-party
  // dependency in the sweep — stdio-server pulls @modelcontextprotocol/sdk in,
  // so a red assertion here distinguishes nothing about bridges by itself; see
  // the ERR_MODULE_NOT_FOUND specifier reported on failure.
  expect(await probe(REPORT_ROOT_ENTRY)).toEqual({
    outcome: "IMPORTED",
    hasNamedExports: true,
    undefinedBindingCount: 0,
    createStdioMcpServer: "function",
    decodeAndDispatch: "function",
    readBootstrapCredential: "function",
    generateStdioToolEntries: "function",
    toolLabelForKind: "function",
    credentialEnv: "string",
    toolEntriesNonEmpty: true,
  });
}, CHILD_TIMEOUT_MS);

it("still refuses the unbridged suffix-named test helper with ERR_MODULE_NOT_FOUND", async () => {
  // Negative control 1. Pins the LITERAL reason code, not merely "it threw": the
  // subject is a real file deliberately left unbridged, so one assertion proves
  // both that the probe can detect failure and that the exclusion was honoured.
  expect(await probe(reportUnbridged("./src/http/http-server-test-helpers.js"))).toEqual({
    outcome: "FAILED",
    code: "ERR_MODULE_NOT_FOUND",
  });
}, CHILD_TIMEOUT_MS);

it("still refuses the unbridged vitest-importing conformance module", async () => {
  // Negative control 2, and the one the naming convention would have missed:
  // dispatch-conformance.ts carries no test suffix and is test tier only by
  // content. Bridging it would publish a vitest import on the runtime surface.
  expect(await probe(reportUnbridged("./src/dispatch-conformance.js"))).toEqual({
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
 * vitest-importing module can carry no naming signal at all, and this package
 * is where that case is real.
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

it("bridges exactly the non-test modules across all three directories", () => {
  const files = walk(SRC_ROOT);
  const modules = files.filter((file) => file.endsWith(".ts"));
  const expected = modules.filter((file) => classify(file) === "bridge");
  const excluded = modules.filter((file) => classify(file) !== "bridge");

  // A sweep that silently generates zero cases passes while testing nothing, and
  // an audit with nothing excluded never exercises the exclusion at all.
  expect(expected.length).toBeGreaterThan(0);
  expect(excluded.length).toBeGreaterThan(0);
  // src/, src/http/ and src/stdio/ must all be represented, or a top-level-only
  // sweep would look identical to a complete one.
  expect([...new Set(named(expected).map((file) => file.split("/").slice(0, -1).join("/")))].sort())
    .toEqual(["", "http", "stdio"]);

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

  // Pinned by name AND reason. `dispatch-conformance.ts` reading "imports-vitest"
  // rather than "test-file" is the whole point: a suffix-only rule would have
  // classified it "bridge" and this expectation would go red.
  expect(verdicts).toEqual({
    "dispatch-conformance.ts": "imports-vitest",
    "http/http-parity.test.ts": "test-file",
    "http/http-server-lifecycle.test.ts": "test-file",
    "http/http-server-test-helpers.ts": "helpers-suffix",
    "http/http-server.test.ts": "test-file",
    "http/http-session.test.ts": "test-file",
    "mcp-runtime-entrypoint.test.ts": "test-file",
    "stdio/stdio-schemas.test.ts": "test-file",
    "stdio/stdio-server.test.ts": "test-file",
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

  // Reachability is a SUBSET of the bridge set here, not equal to it: the http/
  // transport is production code that `index.ts` does not export yet. Bridging
  // an unreachable production module is inert; skipping a reachable one breaks
  // the entry point, so this is the direction worth asserting.
  expect(seen.size).toBeGreaterThan(1);
  expect(named([...seen].filter((file) => !isFile(file)))).toEqual([]);
  expect(named([...seen].filter((file) => !isFile(bridgeOf(file))))).toEqual([]);
});
