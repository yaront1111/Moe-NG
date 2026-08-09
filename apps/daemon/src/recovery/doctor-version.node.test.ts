import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { DOCTOR_ERROR_CODES } from "./doctor-commands.js";
import { comparePin } from "./doctor-version-contract.js";
import type { ObservedValue } from "./doctor-version-contract.js";
import {
  collectDoctorVersionReport,
  readDeclaredPins,
  readObservedRuntime,
  readPnpmVersion,
  readWorkspaceComponents,
  resolveRepoRoot,
} from "./doctor-version.node.js";

const execFileAsync = promisify(execFile);

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = resolve(SRC_ROOT, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

const temporaryRoots: string[] = [];

/** A minimal repo root. Anything omitted is a case about an unreadable pin. */
function fixtureRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "moe-doctor-version-"));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

afterAll(() => {
  for (const root of temporaryRoots) {
    // Best-effort: a Windows handle held open by an antivirus scan must not turn
    // a green suite red on cleanup.
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* leaked fixture directory, not a test failure */
    }
  }
});

const WORKSPACE = 'packages:\n  - "apps/*"\n  - "adapters/*"\n  - "packages/*"\n';

/** Collected across the suite, then asserted against the frozen vocabulary. */
const emittedCodes = new Set<string>();
const record = (value: ObservedValue): ObservedValue => {
  if (!value.known) emittedCodes.add(value.code);
  return value;
};

type RuntimeObservation = ReturnType<typeof readObservedRuntime>;

/** Swaps a live `process` property for the duration of one assertion, then restores it. */
function withProcessValue(key: string, value: unknown, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, key);
  expect(original).toBeDefined();
  try {
    Object.defineProperty(process, key, { value, configurable: true, writable: true });
    body();
  } finally {
    if (original !== undefined) Object.defineProperty(process, key, original);
  }
}

describe("the observed runtime is READ from the process, never restated", () => {
  /**
   * DoD 1 and task rail 2. The expected value is read by the TEST from the same
   * API the reader uses, so a version literal compiled into the reader cannot
   * satisfy it. The shape assertion is the second half: it stops a reader that
   * returns some other constant that happens to match today.
   */
  it("reports the running node version", () => {
    const observed = readObservedRuntime();
    expect(observed.node).toEqual({ known: true, value: process.version });
    expect(observed.node.known && observed.node.value).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it("reports the running platform and architecture", () => {
    const observed = readObservedRuntime();
    expect(observed.platform).toEqual({ known: true, value: process.platform });
    expect(observed.arch).toEqual({ known: true, value: process.arch });
  });

  /**
   * Written because the step-6 drill SURVIVED without it. Replacing the reader
   * body with the literal "v24.16.0" left every case above green, since on this
   * host that IS `process.version` — comparing a read against the same host's
   * value cannot separate a real read from a correct constant. Redefining the
   * live property does separate them, and reddens any hard-coded value.
   */
  it.each([
    ["version", "v9.99.99", (o: RuntimeObservation) => o.node],
    ["platform", "sunos", (o: RuntimeObservation) => o.platform],
    ["arch", "mips", (o: RuntimeObservation) => o.arch],
  ])("re-reads process.%s live rather than returning a captured constant", (key, spoofed, pick) => {
    withProcessValue(key, spoofed, () => {
      expect(pick(readObservedRuntime())).toEqual({ known: true, value: spoofed });
    });
  });

  it.each([["version"], ["platform"], ["arch"]])(
    "codes process.%s as unreadable when it is not a usable string",
    (key) => {
      withProcessValue(key, undefined, () => {
        const observed = readObservedRuntime();
        const field = key === "version" ? observed.node : observed[key as "platform" | "arch"];
        expect(record(field)).toEqual({
          known: false,
          code: "DOCTOR_RUNTIME_VERSION_UNREADABLE",
          layer: "DOCTOR_VERSION_HOST",
        });
      });
    },
  );
});

describe("the pnpm version is a value or an honest coded UNKNOWN", () => {
  /**
   * Asserting `11.0.8` would be machine-dependent: the reader legitimately
   * answers UNKNOWN on a host where no non-shim pnpm resolves. So both branches
   * are named, and the exactly-one assertion stops it passing by taking neither.
   */
  it("takes exactly one of its two declared branches", async () => {
    const value = record(await readPnpmVersion());
    const asValue = value.known && /^\d+\.\d+\.\d+/.test(value.value);
    const asUnknown =
      !value.known &&
      value.code === "DOCTOR_TOOL_VERSION_UNREADABLE" &&
      value.layer === "DOCTOR_VERSION_HOST";
    expect([asValue, asUnknown].filter(Boolean)).toHaveLength(1);
  });

  it("never throws, because a doctor that crashes reports nothing", async () => {
    await expect(readPnpmVersion()).resolves.toBeDefined();
  });

  /**
   * `npm_execpath` is inherited from the environment and this reader runs it
   * through `process.execPath`. Without the name guard, an inherited variable
   * turns a version probe into "execute whatever script the environment names".
   */
  it("ignores an npm_execpath that does not name pnpm", async () => {
    // A REAL runnable script whose output is a valid semver no pnpm would emit.
    // With the guard it is never executed; without it, the reader would run it and
    // report 99.99.99 — so this assertion fails the moment the guard is removed.
    const root = fixtureRoot({ "decoy.cjs": 'console.log("99.99.99");\n' });
    const original = process.env["npm_execpath"];
    try {
      process.env["npm_execpath"] = join(root, "decoy.cjs");
      const answer = await readPnpmVersion();
      expect(answer.known && answer.value).not.toBe("99.99.99");
    } finally {
      if (original === undefined) delete process.env["npm_execpath"];
      else process.env["npm_execpath"] = original;
    }
  });
});

describe("the repo root is discovered by walking up, never hard-coded", () => {
  it("finds the workspace root from this module's own location", () => {
    expect(resolveRepoRoot(SRC_ROOT)).toBe(REPO_ROOT);
  });

  it("returns null rather than throwing when no workspace root is above it", () => {
    expect(resolveRepoRoot(fixtureRoot({ "a/b/.keep": "" }))).toBeNull();
  });
});

describe("declared pins are read from the repo, separately from what is observed", () => {
  it("reads the real .node-version, packageManager and engines", () => {
    const declared = readDeclaredPins(REPO_ROOT);
    const onDisk = readFileSync(join(REPO_ROOT, ".node-version"), "utf8");
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      packageManager: string;
      engines: { node: string; pnpm: string };
    };
    expect(declared.nodeVersionFile).toEqual({ known: true, value: onDisk });
    expect(declared.packageManager).toEqual({ known: true, value: manifest.packageManager });
    expect(declared.enginesNode).toEqual({ known: true, value: manifest.engines.node });
    expect(declared.enginesPnpm).toEqual({ known: true, value: manifest.engines.pnpm });
  });

  it("codes a missing .node-version rather than defaulting it", () => {
    const root = fixtureRoot({ "pnpm-workspace.yaml": WORKSPACE, "package.json": "{}" });
    expect(record(readDeclaredPins(root).nodeVersionFile)).toEqual({
      known: false,
      code: "DOCTOR_DECLARED_PIN_UNREADABLE",
      layer: "DOCTOR_VERSION_HOST",
    });
  });

  it("codes an unparseable root package.json rather than throwing", () => {
    const root = fixtureRoot({ "pnpm-workspace.yaml": WORKSPACE, "package.json": "{ not json" });
    const declared = readDeclaredPins(root);
    for (const pin of [declared.packageManager, declared.enginesNode, declared.enginesPnpm]) {
      expect(record(pin)).toEqual({
        known: false,
        code: "DOCTOR_DECLARED_PIN_UNREADABLE",
        layer: "DOCTOR_VERSION_HOST",
      });
    }
  });

  it("codes every pin when the root could not be discovered at all", () => {
    const declared = readDeclaredPins(null);
    const pins = Object.values(declared);
    expect(pins).toHaveLength(4);
    for (const pin of pins) expect(record(pin).known).toBe(false);
  });

  /**
   * The reader and the comparator meeting: a Windows checkout leaves CRLF on
   * `.node-version`, and `process.version` carries a leading `v`. Measured, not
   * hypothesised — without both normalisations this pin reads MISMATCHED on a
   * correctly pinned host, which is the failure DoD 2 exists to prevent.
   */
  it("still satisfies the node pin when the file is CRLF-terminated", () => {
    const root = fixtureRoot({
      "pnpm-workspace.yaml": WORKSPACE,
      "package.json": "{}",
      ".node-version": "24.16.0\r\n",
    });
    const declared = readDeclaredPins(root);
    const verdict = comparePin("NODE_RUNTIME", declared.nodeVersionFile, { known: true, value: "v24.16.0" });
    expect(verdict.verdict).toBe("SATISFIED");
  });
});

describe("the component sweep reports what it found and whether it could look", () => {
  it("enumerates the real workspace including this daemon, with a positive count", () => {
    const inventory = readWorkspaceComponents(REPO_ROOT);
    expect(inventory.components.length).toBeGreaterThan(0);
    expect(inventory.components.map((entry) => entry.name)).toContain("@moe/daemon");
    expect(inventory.inventory).toEqual({
      known: true,
      value: String(inventory.components.length),
    });
  });

  it("codes a sweep that matched nothing instead of returning a bare empty array", () => {
    const root = fixtureRoot({ "pnpm-workspace.yaml": WORKSPACE });
    const inventory = readWorkspaceComponents(root);
    expect(inventory.components).toEqual([]);
    expect(record(inventory.inventory)).toEqual({
      known: false,
      code: "DOCTOR_COMPONENT_INVENTORY_EMPTY",
      layer: "DOCTOR_VERSION_HOST",
    });
  });

  /** `adapters/` is globbed by this repo's workspace file and does not exist. */
  it("tolerates a declared glob root that is absent from disk", () => {
    const root = fixtureRoot({
      "pnpm-workspace.yaml": WORKSPACE,
      "packages/core/package.json": '{"name":"@fixture/core","version":"1.2.3"}',
    });
    const inventory = readWorkspaceComponents(root);
    expect(inventory.components).toEqual([
      { name: "@fixture/core", version: { known: true, value: "1.2.3" } },
    ]);
  });

  it("codes a component whose manifest cannot be parsed, keeping it in the inventory", () => {
    const root = fixtureRoot({
      "pnpm-workspace.yaml": WORKSPACE,
      "packages/broken/package.json": "{ not json",
    });
    const inventory = readWorkspaceComponents(root);
    expect(inventory.components).toHaveLength(1);
    expect(record(inventory.components[0]!.version).known).toBe(false);
  });
});

describe("the composed report is what the doctor hands to a consumer", () => {
  it("observes the live runtime, compares every pin, and freezes the result", async () => {
    const report = await collectDoctorVersionReport();
    expect(report.observed.node).toEqual({ known: true, value: process.version });
    expect(report.pins).toHaveLength(4);
    expect(report.componentCount).toBe(report.components.length);
    expect(report.componentCount).toBeGreaterThan(0);
    expect(Object.isFrozen(report)).toBe(true);
    expect(report.pins.map((pin) => pin.pin)).toEqual([
      "NODE_RUNTIME",
      "PNPM_TOOL",
      "ENGINES_NODE",
      "ENGINES_PNPM",
    ]);
  });

  it("satisfies this repo's own node pins, which is the point of the report", async () => {
    const report = await collectDoctorVersionReport();
    const byPin = new Map(report.pins.map((pin) => [pin.pin, pin.verdict]));
    expect(byPin.get("NODE_RUNTIME")).toBe("SATISFIED");
    expect(byPin.get("ENGINES_NODE")).toBe("SATISFIED");
  });
});

describe("no production path emits a code outside the frozen vocabulary", () => {
  it("keeps every code this suite produced inside DOCTOR_ERROR_CODES", () => {
    // Ordering matters: this case runs last, after the cases above have driven
    // the real readers. Asserting non-empty first stops a sweep of zero passing.
    expect(emittedCodes.size).toBeGreaterThan(0);
    for (const code of emittedCodes) {
      expect(DOCTOR_ERROR_CODES as readonly string[]).toContain(code);
    }
  });
});

/**
 * DoD 5. vitest rewrites `./x.js` back to `x.ts`, so a missing bridge is
 * invisible to every case above — only a real child Node process can detect it.
 * The probe also CALLS the reader rather than merely importing it, because a
 * module can import cleanly and still fail on first use.
 */
describe("the module loads and runs under plain Node through its .js bridge", () => {
  it("imports the bridge in a child process and produces a live report", async () => {
    const source = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("./src/recovery/doctor-version.node.js");
  const built = await ns.collectDoctorVersionReport();
  report({
    outcome: "IMPORTED",
    node: built.observed.node.value,
    pins: built.pins.length,
    positiveComponents: built.componentCount > 0,
    frozen: Object.isFrozen(built),
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      { cwd: PACKAGE_ROOT },
    );
    expect(JSON.parse(stdout)).toEqual({
      outcome: "IMPORTED",
      node: process.version,
      pins: 4,
      positiveComponents: true,
      frozen: true,
    });
  });
});
