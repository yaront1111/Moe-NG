/**
 * Security lane smoke — DEVELOPMENT_ONLY / NOT_CONFIRMATORY.
 *
 * Grants NO security, fault, restore or platform authority. It is the
 * hostile-lane runner's own evidence and nothing else: the two lane Vitest
 * configs and the two root scripts say what they are supposed to say, and the
 * ordinary root config still discovers only `*.test.ts`. It imports the REAL
 * config modules and reads the REAL `package.json`, never a restatement of
 * either, and never anything under `packages/**`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";
import type { TestSpecification } from "vitest/node";

import faultConfig from "../fault/vitest.config.js";
import rootConfig from "../../vitest.config.js";
import securityConfig from "./vitest.config.js";

type LaneTest = NonNullable<ViteUserConfig["test"]>;

const HERE = fileURLToPath(import.meta.url);
const LANE_ROOT = dirname(HERE);
const REPO_ROOT = resolve(LANE_ROOT, "..", "..");

const FAULT_SCRIPT =
  "tsc -p tests/fault/tsconfig.json && vitest run --config tests/fault/vitest.config.ts";
const SECURITY_SCRIPT =
  "tsc -p tests/security/tsconfig.json && vitest run --config tests/security/vitest.config.ts";

/**
 * Pinned for the same reason as the two lane scripts: it is the only invocation of
 * `typecheck:import`, and `typecheck:import` is the only thing that type-checks
 * `tools/import/**` at all: `pnpm --recursive typecheck` reaches workspace packages
 * and `tools/` is in none. A typecheck script no gate runs is indistinguishable from
 * one that does not exist, and losing either leg from here is silent.
 */
const INTEGRATION_SCRIPT =
  "pnpm typecheck:packaging && pnpm typecheck:import && vitest run tests/integration"
  + " && node --test tests/integration/release-supply-chain.test.mjs";

/** Predecessor scripts that this task must preserve byte-for-byte. */
const INHERITED_SCRIPTS = [
  "typecheck", "test", "test:meta", "test:property", "test:e2e", "test:e2e:browser",
  "test:integration", "test:store", "typecheck:packaging", "verify:foundation", "verify:store",
] as const;

const slashes = (value: string): string => value.replaceAll("\\", "/");

const laneTest = (config: ViteUserConfig, label: string): LaneTest => {
  const block = config.test;
  if (block === undefined) {
    throw new Error(`${label} vitest config exposes no test block`);
  }
  return block;
};

const readScripts = (): Readonly<Record<string, string>> => {
  const parsed: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("root package.json is not an object");
  }
  const { scripts } = parsed as { scripts?: unknown };
  if (typeof scripts !== "object" || scripts === null) {
    throw new Error("root package.json has no scripts object");
  }
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value !== "string") {
      throw new Error(`root package.json script ${key} is not a string`);
    }
    flat[key] = value;
  }
  return flat;
};

/**
 * A real TestSpecification needs a live Vitest project, and the sequencer
 * contract reads exactly one of its fields. Supply that field and cast once,
 * here, rather than scattering casts through the assertions.
 */
const spec = (moduleId: string): TestSpecification =>
  ({ moduleId }) as unknown as TestSpecification;

const sortedModuleIds = async (block: LaneTest, moduleIds: readonly string[]): Promise<string[]> => {
  const Sequencer = block.sequence?.sequencer;
  if (Sequencer === undefined) {
    throw new Error("lane config pins no sequencer");
  }
  const sequencer = new Sequencer({} as never);
  const sorted = await sequencer.sort(moduleIds.map(spec));
  return sorted.map((entry) => entry.moduleId);
};

const expectStableSerialLane = (block: LaneTest): void => {
  expect(block.environment).toBe("node");
  expect(block.pool).toBe("forks");
  expect(block.isolate).toBe(true);
  expect(block.passWithNoTests).toBe(false);
  expect(block.allowOnly).toBe(false);
  expect(block.retry).toBe(0);
  expect(block.dangerouslyIgnoreUnhandledErrors).toBe(false);
  expect(block.fileParallelism).toBe(false);
  expect(block.maxConcurrency).toBe(1);
  expect(block.sequence?.concurrent).toBe(false);
  expect(block.sequence?.shuffle).toBe(false);
  expect(typeof block.sequence?.sequencer).toBe("function");
};

describe("hostile lane smoke — identity", () => {
  it("is a *.security.ts file inside the security lane", () => {
    expect(slashes(HERE).endsWith("/tests/security/lane-smoke.security.ts")).toBe(true);
    expect(slashes(LANE_ROOT).endsWith("/tests/security")).toBe(true);
  });
});

describe("hostile lane smoke — root scripts", () => {
  it("exposes test:fault and test:security exactly", () => {
    const scripts = readScripts();
    expect(scripts["test:fault"]).toBe(FAULT_SCRIPT);
    expect(scripts["test:security"]).toBe(SECURITY_SCRIPT);
  });

  it("runs both tools typecheck legs inside test:integration", () => {
    const scripts = readScripts();
    expect(scripts["test:integration"]).toBe(INTEGRATION_SCRIPT);
  });

  it("typechecks before Vitest in both lane scripts", () => {
    // Read back off disk rather than re-reading the constants above: an
    // assertion over FAULT_SCRIPT/SECURITY_SCRIPT would only be checking this
    // file against itself. Kept in its own case so the exact-string assertion
    // above cannot short-circuit it.
    const scripts = readScripts();
    for (const key of ["test:fault", "test:security"]) {
      const script = scripts[key];
      if (script === undefined) {
        throw new Error(`root package.json has no ${key} script`);
      }
      const tscAt = script.indexOf("tsc -p ");
      const vitestAt = script.indexOf("vitest run ");
      expect(tscAt).toBeGreaterThanOrEqual(0);
      expect(vitestAt).toBeGreaterThan(tscAt);
      expect(script.slice(tscAt, vitestAt)).toContain("&&");
    }
  });

  it("preserves every script added by predecessor tasks", () => {
    // Deliberately a subset check, not set equality. Deleting a predecessor
    // script must go red; ADDING one must not, because package.json has
    // downstream co-owners whose own scripts are legitimate.
    const scripts = readScripts();
    const present = new Set(Object.keys(scripts));
    const missing = [...INHERITED_SCRIPTS, "test:fault", "test:security"].filter(
      (key) => !present.has(key),
    );
    expect(missing).toStrictEqual([]);
  });
});

describe("hostile lane smoke — fault config", () => {
  const block = laneTest(faultConfig, "fault");

  it("is rooted at tests/fault and collects only fault-lane files", () => {
    expect(slashes(String(faultConfig.root)).endsWith("/tests/fault")).toBe(true);
    expect(block.include).toStrictEqual(["foundation/**/*.test.ts", "**/*.fault.ts"]);
    expect(block.include?.some((pattern) => pattern.endsWith(".security.ts"))).toBe(false);
  });

  it("keeps Vitest's own excludes and adds the opposite lane", () => {
    for (const preset of configDefaults.exclude) {
      expect(block.exclude).toContain(preset);
    }
    expect(block.exclude).toContain("**/*.security.ts");
  });

  it("fails empty and runs one file at a time in a pinned order", () => {
    expectStableSerialLane(block);
  });
});

describe("hostile lane smoke — security config", () => {
  const block = laneTest(securityConfig, "security");

  it("is rooted at tests/security and collects only *.security.ts", () => {
    expect(slashes(String(securityConfig.root)).endsWith("/tests/security")).toBe(true);
    expect(block.include).toStrictEqual(["**/*.security.ts"]);
  });

  it("keeps Vitest's own excludes and adds every non-security suffix", () => {
    for (const preset of configDefaults.exclude) {
      expect(block.exclude).toContain(preset);
    }
    for (const foreign of ["**/*.fault.ts", "**/*.test.ts", "**/*.spec.ts"]) {
      expect(block.exclude).toContain(foreign);
    }
  });

  it("fails empty and runs one file at a time in a pinned order", () => {
    expectStableSerialLane(block);
  });
});

describe("hostile lane smoke — ordinary root config is untouched", () => {
  const block = laneTest(rootConfig, "root");

  /**
   * The roster is pinned EXACTLY, in config order, so a new discovery root can
   * never appear without a deliberate edit here. `tools/**` is the fourth root:
   * f28cfe4 added it so tools/import/import-shadow.test.ts — the coverage for
   * binding the shadow importer to the durable store's MAX_EVENTS_PER_COMMIT —
   * executes in some root lane; tools/ was in no include root before it.
   *
   * The pin's rationale ("hostile files are not regression evidence") survives
   * that fourth root: tools/ was enumerated again when pack-docs.test.ts landed
   * and holds two *.test.ts and zero *.fault.ts / *.security.ts / *.spec.ts /
   * fixture files, and the pattern itself still matches only the .test.ts
   * suffix. The durable guard is
   * the suffix sweep below, which iterates block.include and so covers any
   * future root automatically — the length witness keeps it from going vacuous
   * if the include is ever silently emptied.
   */
  it("still discovers *.test.ts only, so hostile files are not regression evidence", () => {
    expect(block.include).toStrictEqual([
      "adapters/**/*.test.ts",
      "packages/**/*.test.ts",
      "tests/**/*.test.ts",
      "tools/**/*.test.ts",
    ]);
    expect(block.passWithNoTests).toBe(false);
    expect(block.include).toHaveLength(4);
    for (const pattern of block.include ?? []) {
      expect(pattern.endsWith(".fault.ts")).toBe(false);
      expect(pattern.endsWith(".security.ts")).toBe(false);
    }
  });
});

/**
 * Both lanes carry their own copy of the comparator, so every ordering property
 * is asserted against BOTH. A mutation drill caught the earlier version: it
 * pinned code-unit ordering on the security sequencer only, and swapping the
 * fault comparator for `localeCompare` survived all thirteen cases.
 */
describe.each([
  ["fault", faultConfig],
  ["security", securityConfig],
])("hostile lane smoke — %s file order is stable and locale-independent", (label, config) => {
  const block = laneTest(config, label);

  it("orders by code unit, so an uppercase name sorts before a lowercase one", async () => {
    const shuffled = [`b.${label}.ts`, `a.${label}.ts`, `B.${label}.ts`, `A.${label}.ts`];
    await expect(sortedModuleIds(block, shuffled)).resolves.toStrictEqual([
      `A.${label}.ts`,
      `B.${label}.ts`,
      `a.${label}.ts`,
      `b.${label}.ts`,
    ]);
  });

  it("normalizes Windows separators before comparing", async () => {
    const mixed = [`D:\\lane\\zz\\a.${label}.ts`, `D:/lane/aa/b.${label}.ts`, `D:\\lane\\aa\\a.${label}.ts`];
    await expect(sortedModuleIds(block, mixed)).resolves.toStrictEqual([
      `D:\\lane\\aa\\a.${label}.ts`,
      `D:/lane/aa/b.${label}.ts`,
      `D:\\lane\\zz\\a.${label}.ts`,
    ]);
  });

  it("returns a new array rather than sorting the caller's list in place", async () => {
    const Sequencer = block.sequence?.sequencer;
    if (Sequencer === undefined) {
      throw new Error(`${label} config pins no sequencer`);
    }
    const input = [spec(`z.${label}.ts`), spec(`a.${label}.ts`)];
    const sorted = await new Sequencer({} as never).sort(input);
    expect(sorted.map((entry) => entry.moduleId)).toStrictEqual([`a.${label}.ts`, `z.${label}.ts`]);
    expect(input.map((entry) => entry.moduleId)).toStrictEqual([`z.${label}.ts`, `a.${label}.ts`]);
  });
});
