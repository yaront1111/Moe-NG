import { createHash } from "node:crypto";
import {
  linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  admitCargoPackTool, PACKAGING_TOOLCHAIN_LAYER, PackCargoToolError,
  parseCargoToolchainPins, readCargoToolchainPins,
  type CargoAdmissionDependencies, type CargoSpawn, type CargoToolchainPin,
} from "./pack-cargo-tool.js";
import { resolveCargoPackTool } from "./pack-command.js";
import { assertPackToolIdentity } from "./pack-tool-identity.js";
import { leaseEntriesForTool } from "./pack-windows-process-lease.js";

const VERSION = "cargo 1.96.0 (30a34c682 2026-05-25)";
const TRACKED_PIN: CargoToolchainPin = Object.freeze({
  arch: "x64",
  cargoSha256: "122f18d28a63fa358f3db266abee1ff1d8aabf0ab7f2dd9ac38a38da99977ae5",
  cargoVersionLine: VERSION,
  platform: "win32",
  schemaVersion: "cargo-toolchain-pins/1",
  toolchain: "1.96.0-x86_64-pc-windows-msvc",
});
const PIN_KEYS = Object.freeze([
  "arch", "cargoSha256", "cargoVersionLine", "platform", "schemaVersion", "toolchain",
] as const);
const roots: string[] = [];

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function writeExecutable(root: string, toolchain: string, name: string, contents: string): string {
  const executable = join(root, "toolchains", toolchain, "bin", name);
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, contents, "utf8");
  return executable;
}

interface Fixture {
  readonly calls: Array<Readonly<{
    args: readonly string[]; command: string; options: Parameters<CargoSpawn>[2];
  }>>;
  readonly contents: string;
  readonly executable: string;
  readonly pin: CargoToolchainPin;
  readonly repositoryRoot: string;
  readonly spawn: CargoSpawn;
  readonly toolRoot: string;
}

function fixture(
  toolchain = TRACKED_PIN.toolchain, name = "cargo.exe", contents = "cargo fixture bytes\n",
): Fixture {
  const repositoryRoot = temporary("moe-cargo-repository-");
  const toolRoot = temporary("moe-cargo-tool-");
  const executable = writeExecutable(toolRoot, toolchain, name, contents);
  const pin = Object.freeze({ ...TRACKED_PIN, cargoSha256: sha256(contents) });
  const calls: Fixture["calls"] = [];
  const spawn: CargoSpawn = (command, args, options) => {
    calls.push(Object.freeze({ args: Object.freeze([...args]), command, options }));
    return Object.freeze({ status: 0, stderr: "", stdout: `${pin.cargoVersionLine}\n` });
  };
  return Object.freeze({ calls, contents, executable, pin, repositoryRoot, spawn, toolRoot });
}

function admit(
  value: Fixture,
  dependencies: CargoAdmissionDependencies = {},
  executable = value.executable,
) {
  return admitCargoPackTool(value.repositoryRoot, executable, value.pin, {
    architecture: "x64", platform: "win32", spawn: value.spawn, ...dependencies,
  });
}

function refusal(action: () => unknown): PackCargoToolError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(PackCargoToolError);
  expect(caught).toMatchObject({
    code: "PACK_STEP_FAILED", layer: PACKAGING_TOOLCHAIN_LAYER,
    message: "PACK_STEP_FAILED",
  });
  expect(String(caught)).toBe("PackCargoToolError: PACK_STEP_FAILED");
  expect(Object.isFrozen(caught)).toBe(true);
  return caught as PackCargoToolError;
}

function pinRecord(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ...TRACKED_PIN, ...overrides };
}

const PIN_CASES = Object.freeze([
  ...PIN_KEYS.map((key) => {
    const value = pinRecord(); delete value[key];
    return Object.freeze({ bytes: JSON.stringify(value), name: `missing ${key}` });
  }),
  ...PIN_KEYS.map((key) => Object.freeze({
    bytes: JSON.stringify(pinRecord({ [key]: 7 })), name: `wrong-type ${key}`,
  })),
  Object.freeze({ bytes: JSON.stringify(pinRecord({ ambientOverride: "attacker" })), name: "extra" }),
  Object.freeze({
    bytes: JSON.stringify(TRACKED_PIN).replace(
      '"arch":"x64"', '"arch":"attacker","\\u0061rch":"x64"',
    ),
    name: "escaped duplicate",
  }),
  Object.freeze({ bytes: "{", name: "bad JSON" }),
  Object.freeze({ bytes: " ".repeat(8_193), name: "oversize" }),
  Object.freeze({ bytes: "", name: "empty document" }),
  ...Object.entries({
    arch: "arm64", cargoSha256: "f".repeat(64), cargoVersionLine: `${VERSION}!`,
    platform: "linux", schemaVersion: "cargo-toolchain-pins/2", toolchain: "stable",
  }).map(([key, value]) => Object.freeze({
    bytes: JSON.stringify(pinRecord({ [key]: value })), name: `unsupported ${key}`,
  })),
]);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Cargo packaging-toolchain authority", () => {
  it("reads one frozen tracked six-key pin document", () => {
    const pin = readCargoToolchainPins();
    expect(pin).toEqual(TRACKED_PIN);
    expect(Object.keys(pin).sort()).toEqual([...PIN_KEYS].sort());
    expect(Object.isFrozen(pin)).toBe(true);
  });

  it.each(PIN_CASES)("refuses $name pin authority at PACKAGING_TOOLCHAIN", ({ bytes }) => {
    expect(PIN_CASES).toHaveLength(23);
    refusal(() => parseCargoToolchainPins(bytes));
  });

  it("admits exact Cargo bytes and returns a deeply frozen leased identity", () => {
    const value = fixture();
    const tool = admit(value);

    expect(tool).toMatchObject({
      argsPrefix: [], executable: { path: value.executable, sha256: value.pin.cargoSha256 },
      kind: "cargo", schemaVersion: "moe-pack-tool/1", witnesses: [],
    });
    expect([tool, tool.argsPrefix, tool.executable, tool.witnesses]
      .every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(() => assertPackToolIdentity(tool)).not.toThrow();
    const leases = leaseEntriesForTool(tool);
    expect(leases.length).toBeGreaterThan(0);
    expect(Object.isFrozen(leases)).toBe(true);
    expect(leases).toContainEqual(expect.objectContaining({
      kind: "file", path: value.executable, sha256: value.pin.cargoSha256,
    }));
    expect(value.calls).toHaveLength(1);
    expect(value.calls[0]).toMatchObject({
      args: ["--version"], command: value.executable,
      options: {
        cwd: value.repositoryRoot, encoding: "utf8", env: {}, shell: false,
        stdio: "pipe", windowsHide: true,
      },
    });
    expect(value.calls[0]?.options.timeout).toBeGreaterThan(0);
    expect(value.calls[0]?.options.maxBuffer).toBeGreaterThan(0);
  });

  it("keeps the durable wrapper two-argument and fixed to tracked authority", () => {
    expect(resolveCargoPackTool).toHaveLength(2);
    refusal(() => resolveCargoPackTool(
      temporary("moe-cargo-wrapper-repository-"),
      join(temporary("moe-cargo-wrapper-tool-"), "missing", "cargo.exe"),
    ));
  });

  it("refuses every invalid explicit path and identity with a nonzero denominator", () => {
    const missing = fixture();
    const inside = fixture();
    const insideExecutable = writeExecutable(
      inside.repositoryRoot, TRACKED_PIN.toolchain, "cargo.exe", inside.contents,
    );
    const noncanonical = fixture();
    const rawNoncanonical = `${dirname(noncanonical.executable)}${sep}..${sep}bin${sep}cargo.exe`;
    const wrongName = fixture(TRACKED_PIN.toolchain, "cargo-copy.exe");
    const wrongToolchain = fixture("stable-x86_64-pc-windows-msvc");
    const hardlinked = fixture();
    linkSync(hardlinked.executable, join(dirname(hardlinked.executable), "cargo-hardlink.exe"));
    const linked = fixture();
    const aliasParent = temporary("moe-cargo-link-");
    const aliasRoot = join(aliasParent, "alias");
    symlinkSync(linked.toolRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const linkedExecutable = join(
      aliasRoot, "toolchains", TRACKED_PIN.toolchain, "bin", "cargo.exe",
    );
    const noncanonicalRoot = fixture();
    const cases = Object.freeze([
      ["missing", missing, join(missing.toolRoot, "missing", "cargo.exe"), missing.repositoryRoot],
      ["inside repository", inside, insideExecutable, inside.repositoryRoot],
      ["noncanonical leaf", noncanonical, rawNoncanonical, noncanonical.repositoryRoot],
      ["wrong basename", wrongName, wrongName.executable, wrongName.repositoryRoot],
      ["wrong toolchain", wrongToolchain, wrongToolchain.executable, wrongToolchain.repositoryRoot],
      ["hardlink", hardlinked, hardlinked.executable, hardlinked.repositoryRoot],
      ["symlink or junction", linked, linkedExecutable, linked.repositoryRoot],
      ["noncanonical repository", noncanonicalRoot, noncanonicalRoot.executable,
        `${noncanonicalRoot.repositoryRoot}${sep}.`],
    ] as const);
    expect(cases).toHaveLength(8);
    for (const [name, value, executable, repositoryRoot] of cases) {
      const error = refusal(() => admitCargoPackTool(repositoryRoot, executable, value.pin, {
        architecture: "x64", platform: "win32", spawn: value.spawn,
      }));
      expect({ code: error.code, layer: error.layer, name }).toEqual({
        code: "PACK_STEP_FAILED", layer: "PACKAGING_TOOLCHAIN", name,
      });
    }
  });

  it("refuses unsupported injected platform and architecture", () => {
    const value = fixture();
    const cases = Object.freeze([
      ["platform", { platform: "linux" }], ["architecture", { architecture: "arm64" }],
    ] as const);
    expect(cases).toHaveLength(2);
    for (const [_name, dependencies] of cases) refusal(() => admit(value, dependencies));
    expect(value.calls).toHaveLength(0);
  });

  it("refuses a digest-only mismatch before the version subprocess", () => {
    const value = fixture();
    const pin = Object.freeze({ ...value.pin, cargoSha256: "f".repeat(64) });
    refusal(() => admitCargoPackTool(value.repositoryRoot, value.executable, pin, {
      architecture: "x64", platform: "win32", spawn: value.spawn,
    }));
    expect(value.calls).toHaveLength(0);
  });

  it("refuses a version-only mismatch with exactly one stdout byte wrong", () => {
    const value = fixture();
    const expected = `${value.pin.cargoVersionLine}\n`;
    const wrong = `${value.pin.cargoVersionLine.slice(0, -1)}]\n`;
    expect([...expected].filter((byte, index) => byte !== wrong[index])).toHaveLength(1);
    const spawn: CargoSpawn = () => ({ status: 0, stderr: "", stdout: wrong });
    refusal(() => admit(value, { spawn }));
  });

  it("refuses spawn failure, timeout, overflow, status, and stderr cases", () => {
    const value = fixture();
    const cases: readonly CargoSpawn[] = Object.freeze([
      () => ({ error: new Error("secret spawn failure"), status: null, stderr: "", stdout: "" }),
      () => ({ error: Object.assign(new Error("secret timeout"), { code: "ETIMEDOUT" }),
        status: null, stderr: "", stdout: "" }),
      () => ({ status: 0, stderr: "", stdout: "x".repeat(8_193) }),
      () => ({ status: 7, stderr: "", stdout: `${VERSION}\n` }),
      () => ({ status: 0, stderr: "secret stderr", stdout: `${VERSION}\n` }),
    ]);
    expect(cases).toHaveLength(5);
    for (const spawn of cases) refusal(() => admit(value, { spawn }));
  });

  it("refuses same-path same-length post-capture substitution", () => {
    const value = fixture();
    const replacement = "X".repeat(value.contents.length);
    expect(replacement).toHaveLength(value.contents.length);
    const spawn: CargoSpawn = () => {
      writeFileSync(value.executable, replacement, "utf8");
      return { status: 0, stderr: "", stdout: `${value.pin.cargoVersionLine}\n` };
    };
    refusal(() => admit(value, { spawn }));
  });
});
