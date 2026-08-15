import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SRC_ROOT, "..");

/**
 * vitest resolves a `./foo.js` specifier back to `foo.ts`; Node does not, and
 * `--experimental-strip-types` strips types without adding TypeScript's
 * `.js` -> `.ts` resolution. So a missing bridge is invisible to every other
 * suite in this repo. These probes run in a REAL child Node process for that
 * reason — running them in-process would prove nothing.
 *
 * cwd is the package root so the bare specifier `@moe/runner` resolves through
 * this package's own `exports` map via Node's self-reference rule, which is the
 * exact resolution a dependent package gets. A relative path would sidestep the
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

const REPORT_ROOT_ENTRY = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/runner");
  const keys = Object.keys(ns).filter((key) => key !== "default");
  report({
    outcome: "IMPORTED",
    hasNamedExports: keys.length > 0,
    undefinedBindingCount: keys.filter((key) => ns[key] === undefined).length,
    applyEffectCommand: typeof ns.applyEffectCommand,
    buildInputManifest: typeof ns.buildInputManifest,
    createArtifactStore: typeof ns.createArtifactStore,
    effectStatesFrozen: Object.isFrozen(ns.EFFECT_STATES),
    observeScope: typeof ns.observeScope,
    probeCodexRuntime: typeof ns.probeCodexRuntime,
    recordCodexStream: typeof ns.recordCodexStream,
    codexCapabilitiesFrozen: Object.isFrozen(ns.CODEX_CAPABILITIES),
    codexStreamRecordVersion: ns.CODEX_STREAM_RECORD_VERSION,
    launchClaudeWithTelemetry: typeof ns.launchClaudeWithTelemetry,
    parseClaudeResultTelemetry: typeof ns.parseClaudeResultTelemetry,
    providerTelemetryContractVersion: ns.PROVIDER_TELEMETRY_CONTRACT_VERSION,
    providerTerminalOutcomesFrozen: Object.isFrozen(ns.PROVIDER_TERMINAL_OUTCOMES),
    // Leakage and its POSITIVE CONTROL, measured by the same membership check in
    // the same child: a leak count of 0 produced by a broken check would leave
    // the published count at 0 too, so the pair cannot both be satisfied by a
    // membership test that has stopped working.
    telemetryHelperLeaks: [
      "knownCount", "readCount", "readText", "countCoverage", "unknownFact",
      "telemetryRefusal", "snapshotRunRef", "PROVIDER_TELEMETRY_MESSAGES",
    ].filter((name) => name in ns).length,
    telemetryPublished: [
      "launchClaudeWithTelemetry", "parseClaudeResultTelemetry", "PROVIDER_TELEMETRY_CODES",
      "PROVIDER_TELEMETRY_LAYERS", "CLAUDE_TELEMETRY_HANDOFF_VERSION",
      "CLAUDE_RESULT_TELEMETRY_VERSION", "CLAUDE_TOKEN_FIELDS", "CLAUDE_RESULT_SUBTYPES",
    ].filter((name) => name in ns).length,
  });
} catch (error) {
  // Report the SPECIFIER, not just the code. A bridge that fails to resolve
  // surfaces downstream as an undefined binding, which names nothing and sends
  // the reader hunting; the specifier says which module was not found.
  report({
    outcome: "FAILED",
    code: error.code ?? "NO_CODE",
    specifier: error.url ?? String(error.message ?? "").match(/'([^']+)'/)?.[1] ?? "NO_SPECIFIER",
  });
}
`;

const REPORT_TEST_ONLY_MODULE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  await import("./src/supervisor/effect-test-fixtures.js");
  report({ outcome: "IMPORTED", code: "NONE" });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

it("loads @moe/runner in Node's strip-types runtime with its named exports defined", async () => {
  // Asserts the bindings, not the exit code: a child can exit 0 having imported
  // nothing useful, and that weak assertion is what let this defect live.
  //
  // The four Codex bindings are read here because a surface module's bridge is
  // invisible to every other suite in this repo: vitest resolves `./x.js` back
  // to `x.ts`, so a missing or misdirected `surface/codex-surface.js` leaves the
  // whole namespace suite green. Only a real child Node process consults it.
  // `codexStreamRecordVersion` reads a VALUE rather than a `typeof`, so a
  // binding that resolves to `undefined` is distinguishable from one that never
  // resolved at all.
  expect(await probe(REPORT_ROOT_ENTRY)).toEqual({
    outcome: "IMPORTED",
    hasNamedExports: true,
    undefinedBindingCount: 0,
    applyEffectCommand: "function",
    buildInputManifest: "function",
    createArtifactStore: "function",
    effectStatesFrozen: true,
    observeScope: "function",
    probeCodexRuntime: "function",
    recordCodexStream: "function",
    codexCapabilitiesFrozen: true,
    codexStreamRecordVersion: "moe-codex-stream-record/1",
    // The telemetry seam is read here for the same reason as the Codex block:
    // its three modules live behind their own `.js` bridges, which only a real
    // child Node process consults. The contract version is a VALUE rather than a
    // `typeof`, so a binding resolving to `undefined` is distinguishable from
    // one that never resolved at all.
    launchClaudeWithTelemetry: "function",
    parseClaudeResultTelemetry: "function",
    providerTelemetryContractVersion: "moe-provider-telemetry/1",
    providerTerminalOutcomesFrozen: true,
    telemetryHelperLeaks: 0,
    telemetryPublished: 8,
  });
});

it("still refuses an unbridged test-only module with ERR_MODULE_NOT_FOUND", async () => {
  // Negative control. Pins the literal reason code, not merely "it threw":
  // it proves test-only code was kept off the runtime surface AND that the
  // probe above can still detect a failure rather than passing vacuously.
  expect(await probe(REPORT_TEST_ONLY_MODULE)).toEqual({
    outcome: "FAILED",
    code: "ERR_MODULE_NOT_FOUND",
  });
});

const TEST_ONLY_NAME = /\.test\.ts$|-test-fixtures\.ts$|-test-helpers\.ts$/;

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
 * Test-tier is a CLOSURE, not a filename suffix. A module that imports test-only
 * code is itself unloadable under Node — bridging it would either publish test
 * code on the runtime surface or force a bridge for the fixtures it depends on.
 * Deriving the set instead of listing names is what makes this guard survive the
 * next module someone adds.
 */
const testTierModules = (modules: readonly string[]): ReadonlySet<string> => {
  const tier = new Set(modules.filter((file) => TEST_ONLY_NAME.test(file)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of modules) {
      if (tier.has(file)) continue;
      if (!relativeImportTargets(file).some((target) => tier.has(target))) continue;
      tier.add(file);
      changed = true;
    }
  }
  return tier;
};

const bridgeOf = (module: string): string => `${module.slice(0, -".ts".length)}.js`;

const expectedBridgeSource = (module: string): string =>
  `export * from "./${basename(module, ".ts")}.ts";\n`;

it("has an exact .js bridge for every runtime module and none for test-tier modules", () => {
  const files = walk(SRC_ROOT);
  const modules = files.filter((file) => file.endsWith(".ts"));
  const tier = testTierModules(modules);
  const runtimeModules = modules.filter((file) => !tier.has(file));

  // A sweep that generates zero cases passes while testing nothing.
  expect(runtimeModules.length).toBeGreaterThan(0);
  expect(tier.size).toBeGreaterThan(0);

  const bridges = new Set(files.filter((file) => file.endsWith(".js")));
  const missing = runtimeModules.filter((file) => !bridges.has(bridgeOf(file)));
  const unexpected = [...bridges].filter((bridge) => {
    const module = `${bridge.slice(0, -".js".length)}.ts`;
    return !modules.includes(module) || tier.has(module);
  });
  const wrongContent = runtimeModules.filter(
    (file) =>
      bridges.has(bridgeOf(file)) &&
      readFileSync(bridgeOf(file), "utf8") !== expectedBridgeSource(file),
  );

  // Report by NAME so a regression says which module, not just a count.
  expect({
    missing: missing.map((file) => relative(SRC_ROOT, file)),
    unexpected: unexpected.map((file) => relative(SRC_ROOT, file)),
    wrongContent: wrongContent.map((file) => relative(SRC_ROOT, file)),
  }).toEqual({ missing: [], unexpected: [], wrongContent: [] });
});
