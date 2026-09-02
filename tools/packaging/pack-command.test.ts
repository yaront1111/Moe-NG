import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureNativePackTool, parseWindowsPackToolchain, resolvePnpmPackTool,
  resolvePowerShellPackTool, resolveWindowsPackToolchain, runPackStep,
  serializeWindowsPackToolchain,
  type WindowsPackToolchain,
} from "./pack-command.js";
import * as packCommand from "./pack-command.js";
import {
  capturePackTreeIdentity, normalizedTreeSha256,
} from "./pack-tool-identity.js";
import {
  PACKAGING_TOOLCHAIN_LAYER, PackCargoToolError, readCargoToolchainPins,
} from "./pack-cargo-tool.js";
import { normalizedPnpmPackageTreeSha256 } from "./pack-pnpm-package-identity.js";
import { readToolchainPins, TOOLCHAIN_PINS_PATH } from "./toolchain-pins.js";

const roots: string[] = [];

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function write(root: string, path: string, body: string): string {
  const target = join(root, ...path.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, body, "utf8");
  return target;
}

function repository(): string {
  const root = temporary("moe-pack-tool-repository-");
  write(root, "package.json", JSON.stringify({
    engines: { pnpm: "11.0.8" }, packageManager: "pnpm@11.0.8", private: true,
  }));
  return root;
}

function actionPnpm(version = "11.0.8"): Readonly<{
  entry: string; mutable: string; packageRoot: string; root: string; shim: string;
}> {
  const root = temporary("moe-pack-action-pnpm-");
  const packageRoot = join(root, "node_modules", ".pnpm", "pnpm@11.0.8",
    "node_modules", "pnpm");
  const entry = write(packageRoot, "bin/pnpm.mjs", [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `if (process.argv[2] === '--version') process.stdout.write(${JSON.stringify(version)} + '\\n');`,
    "else if (process.argv[2] === 'mutate') writeFileSync(join(import.meta.dirname, '..', 'dist', 'mutable.txt'), 'changed\\n');",
    "else writeFileSync(process.argv[2], process.argv[3]);",
    "",
  ].join("\n"));
  write(packageRoot, "package.json", JSON.stringify({
    bin: { pnpm: "bin/pnpm.mjs" }, name: "pnpm", version: "11.0.8",
  }));
  const mutable = write(packageRoot, "dist/mutable.txt", "admitted\n");
  write(packageRoot, "dist/node_modules/undici/lib/llhttp/.gitkeep", "");
  const spellings = portableDestinationSpellings(root);
  for (const path of PORTABLE_SHIMS) {
    const prefix = path.endsWith(".CMD") ? spellings.cmd : spellings.shell;
    write(packageRoot, path, `${Array.from({ length: 8 }, (_value, index) =>
      `NODE_PATH_${index}=${prefix}/node_modules/${index}`).join("\n")}\n`);
  }
  const shim = write(root, "node_modules/.bin/pnpm.cmd", "@exit /b 99\r\n");
  write(root, "node_modules/.bin/pnpm", "#!/bin/sh\n");
  symlinkSync(packageRoot, join(root, "node_modules", "pnpm"), "junction");
  return Object.freeze({ entry, mutable, packageRoot, root, shim });
}

function actionPin(action: ReturnType<typeof actionPnpm>): Readonly<{
  readonly expectedPnpmPackageTreeSha256: string;
}> {
  return Object.freeze({
    expectedPnpmPackageTreeSha256:
      normalizedPnpmPackageTreeSha256(capturePackTreeIdentity(action.packageRoot), {
        actionDestination: action.root, pnpmVersion: "11.0.8",
      }),
  });
}

const PORTABLE_SHIMS = Object.freeze([
  "node_modules/.bin/pn", "node_modules/.bin/pn.CMD",
  "node_modules/.bin/pnpm", "node_modules/.bin/pnpm.CMD",
  "node_modules/.bin/pnpx", "node_modules/.bin/pnpx.CMD",
  "node_modules/.bin/pnx", "node_modules/.bin/pnx.CMD",
]);

function portableDestinationSpellings(destination: string): Readonly<{ cmd: string; shell: string }> {
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(destination);
  if (drive === null) return { cmd: destination, shell: destination.replaceAll("\\", "/") };
  return {
    cmd: destination.replaceAll("/", "\\"),
    shell: `/mnt/${drive[1]?.toLowerCase()}/${drive[2]?.replaceAll("\\", "/")}`,
  };
}

function portableActionPnpm(
  label: string,
  options: Readonly<{ nested?: boolean; storeVersion?: string }> = {},
): Readonly<{
  destination: string; entry: string; packageRoot: string; shim: string;
}> {
  const destination = join(temporary("moe-pack-copy-pnpm-"), label);
  const packageDestination = options.nested === true
    ? join(destination, "nested-authority") : destination;
  const packageRoot = join(packageDestination, "node_modules", ".pnpm",
    `pnpm@${options.storeVersion ?? "11.0.8"}`,
    "node_modules", "pnpm");
  const entry = write(packageRoot, "bin/pnpm.mjs", "export {};\n");
  write(packageRoot, "package.json", JSON.stringify({
    bin: { pnpm: "bin/pnpm.mjs" }, name: "pnpm", version: "11.0.8",
  }));
  write(packageRoot, "lib/worker.js", "trusted-nonprefix-byte\n");
  const spellings = portableDestinationSpellings(packageDestination);
  for (const path of PORTABLE_SHIMS) {
    const prefix = path.endsWith(".CMD") ? spellings.cmd : spellings.shell;
    write(packageRoot, path, `${Array.from({ length: 8 }, (_value, index) =>
      `NODE_PATH_${index}=${prefix}/node_modules/${index}`).join("\n")}\n`);
  }
  const shim = write(destination, "node_modules/.bin/pnpm.cmd", "@exit /b 99\r\n");
  write(destination, "node_modules/.bin/pnpm", "#!/bin/sh\n");
  symlinkSync(packageRoot, join(destination, "node_modules", "pnpm"), "junction");
  return Object.freeze({ destination, entry, packageRoot, shim });
}

function portableActionPin(action: ReturnType<typeof portableActionPnpm>): Readonly<{
  readonly expectedPnpmPackageTreeSha256: string;
}> {
  return Object.freeze({
    expectedPnpmPackageTreeSha256:
      normalizedPnpmPackageTreeSha256(capturePackTreeIdentity(action.packageRoot), {
        actionDestination: action.destination, pnpmVersion: "11.0.8",
      }),
  });
}

function movePortablePackageToDirectRoot(
  action: ReturnType<typeof portableActionPnpm>,
): ReturnType<typeof portableActionPnpm> {
  const directRoot = join(action.destination, "node_modules", "pnpm");
  rmSync(directRoot);
  renameSync(action.packageRoot, directRoot);
  return Object.freeze({
    ...action, entry: join(directRoot, "bin", "pnpm.mjs"), packageRoot: directRoot,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("toolchain pin authority (task-861530ae)", () => {
  function pins(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      nodeSha256: "a".repeat(64), nodeVersion: "v24.16.0",
      pnpmNativeSha256: "b".repeat(64), pnpmNativeTreeSha256: "c".repeat(64),
      pnpmPackageTreeSha256: "d".repeat(64), pnpmVersion: "11.0.8",
      schemaVersion: "moe-toolchain-pins/1", ...overrides,
    };
  }

  function writePins(body: Readonly<Record<string, unknown>>): string {
    return write(temporary("moe-toolchain-pins-"), "toolchain-pins.json", JSON.stringify(body));
  }

  const invalidPinCases = Object.freeze([
    ["missing", (() => { const value = pins(); delete value["nodeSha256"]; return value; })()],
    ["extra", pins({ ambientOverride: "attacker" })],
    ["non-hex", pins({ pnpmPackageTreeSha256: "g".repeat(64) })],
    ["short-hex", pins({ pnpmPackageTreeSha256: "a".repeat(63) })],
  ] as const);

  it("reads the tracked exact-key pin document", () => {
    expect(invalidPinCases).toHaveLength(4);
    expect(readToolchainPins()).toEqual({
      nodeSha256: "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3",
      nodeVersion: "v24.16.0",
      pnpmNativeSha256: "625c0ea2ef7dfd25e1042b19f92da6fd8f0a5b37f08abe4d8ff18977011ae019",
      pnpmNativeTreeSha256: "f03c1be35f86496eea3c6d0b5edab522803f35a34001a951d3904f73e7c4ad7c",
      pnpmPackageTreeSha256: "22c177c6e8cac54a8b26001b3b49390bd78dc6ecc15a3c9aac50869cf19b4cf7",
      pnpmVersion: "11.0.8", schemaVersion: "moe-toolchain-pins/1",
    });
    expect(TOOLCHAIN_PINS_PATH.endsWith("toolchain-pins.json")).toBe(true);
  });

  it.each(invalidPinCases)("refuses %s pin authority with the stable packaging code", (_name, body) => {
    expect(() => readToolchainPins(writePins(body)))
      .toThrow("PACK_STEP_FAILED: toolchain pins invalid");
  });
});

describe("pnpm action handoff (task-861530ae, R3-12-E2)", () => {
  function actionEnvironment(action: Readonly<{ shim: string }>): NodeJS.ProcessEnv {
    const environment = { ...process.env, PNPM_HOME: dirname(action.shim) };
    delete environment["npm_execpath"];
    return environment;
  }

  it("resolves the authenticated PNPM_HOME package without npm_execpath", () => {
    const repo = repository();
    const action = actionPnpm();
    const environment = actionEnvironment(action);
    expect(Object.hasOwn(environment, "npm_execpath")).toBe(false);

    const tool = resolvePnpmPackTool(repo, environment, {
      ...actionPin(action), platform: "win32",
    });

    expect(tool.executable.path).toBe(process.execPath);
    expect(tool.argsPrefix).toEqual([action.entry]);
    expect(tool.witnesses.map((witness) => witness.path)).toEqual([action.shim]);
  });

  it("admits the same action-copy package identity at a different install root", () => {
    const repo = repository();
    const left = portableActionPnpm("a");
    const right = portableActionPnpm("copy-destination-with-a-longer-name");
    const leftTree = capturePackTreeIdentity(left.packageRoot);
    const rightTree = capturePackTreeIdentity(right.packageRoot);

    expect(left.destination.length).not.toBe(right.destination.length);
    expect(normalizedTreeSha256(leftTree)).not.toBe(normalizedTreeSha256(rightTree));
    const portable = portableActionPin(left);
    expect(portableActionPin(right)).toEqual(portable);
    const tool = resolvePnpmPackTool(repo, actionEnvironment(right), {
      ...portable,
      platform: "win32",
      spawn: (() => ({ status: 0, stderr: "", stdout: "11.0.8\n" })) as never,
    });

    expect(tool.argsPrefix).toEqual([right.entry]);
    expect(tool.tree?.root).toBe(right.packageRoot);
    expect(tool.witnesses.map((witness) => witness.path)).toEqual([right.shim]);
  });

  it("refuses nested and wrong-version action package roots before version spawn", () => {
    const repo = repository();
    const pin = portableActionPin(portableActionPnpm("canonical-authority"));
    const fixtures = [
      portableActionPnpm("nested-root", { nested: true }),
      portableActionPnpm("wrong-store-label", { storeVersion: "99.0.0" }),
    ];
    let executed = 0;

    for (const action of fixtures) {
      let spawned = false;
      expect(() => resolvePnpmPackTool(repo, actionEnvironment(action), {
        ...pin, platform: "win32",
        spawn: (() => {
          spawned = true;
          return { status: 0, stderr: "", stdout: "11.0.8\n" };
        }) as never,
      })).toThrow("PACK_STEP_FAILED: pnpm package identity unavailable");
      expect(spawned).toBe(false);
      executed += 1;
    }
    expect(fixtures).toHaveLength(2);
    expect(executed).toBe(2);
  });

  it("keeps malformed shim evidence distinct from ordinary package drift", () => {
    const repo = repository();
    const malformed = portableActionPnpm("malformed");
    rmSync(join(malformed.packageRoot, ...PORTABLE_SHIMS[0]!.split("/")));
    const rawMalformedPin = {
      expectedPnpmPackageTreeSha256:
        normalizedTreeSha256(capturePackTreeIdentity(malformed.packageRoot)),
    };
    expect(() => resolvePnpmPackTool(repo, actionEnvironment(malformed), {
      ...rawMalformedPin, platform: "win32",
      spawn: (() => ({ status: 0, stderr: "", stdout: "11.0.8\n" })) as never,
    })).toThrow("PACK_STEP_FAILED: pnpm package identity unavailable");

    const drift = portableActionPnpm("ordinary-drift");
    const pin = portableActionPin(drift);
    write(drift.packageRoot, "lib/worker.js", "changed-nonprefix-byte\n");
    expect(() => resolvePnpmPackTool(repo, actionEnvironment(drift), {
      ...pin, platform: "win32",
      spawn: (() => ({ status: 0, stderr: "", stdout: "11.0.8\n" })) as never,
    })).toThrow("PACK_STEP_FAILED: pnpm provenance invalid");

    const canonical = portableActionPnpm("direct-root");
    const directPin = portableActionPin(canonical);
    const direct = movePortablePackageToDirectRoot(canonical);
    let spawned = false;
    expect(() => resolvePnpmPackTool(repo, actionEnvironment(direct), {
      ...directPin, platform: "win32",
      spawn: (() => {
        spawned = true;
        return { status: 0, stderr: "", stdout: "11.0.8\n" };
      }) as never,
    })).toThrow("PACK_STEP_FAILED: pnpm package identity unavailable");
    expect(spawned).toBe(false);
  });

  it("refuses forged PNPM_HOME package bytes with the provenance reason", () => {
    const repo = repository();
    const action = actionPnpm();
    const expected = actionPin(action);
    writeFileSync(action.mutable, "forged!!\n");

    expect(() => resolvePnpmPackTool(repo, actionEnvironment(action), {
      ...expected, platform: "win32",
    })).toThrow("PACK_STEP_FAILED: pnpm provenance invalid");
  });

  it("refuses a complete non-action PNPM_HOME layout", () => {
    const repo = repository();
    const action = actionPnpm();
    const toolsRoot = join(action.root, "tools");
    renameSync(join(action.root, "node_modules"), toolsRoot);
    const movedPackageRoot = join(toolsRoot, ".pnpm", "pnpm@11.0.8", "node_modules", "pnpm");
    const moved = Object.freeze({
      ...action,
      entry: join(movedPackageRoot, "bin", "pnpm.mjs"),
      packageRoot: movedPackageRoot,
      shim: join(toolsRoot, ".bin", "pnpm.cmd"),
    });

    expect(() => resolvePnpmPackTool(repo, actionEnvironment(moved), {
      expectedPnpmPackageTreeSha256: "0".repeat(64), platform: "win32",
    })).toThrow("PACK_STEP_FAILED: pnpm handoff unavailable");
  });

  it("does not fall back to PNPM_HOME when npm_execpath is present but invalid", () => {
    const action = actionPnpm();
    const environment = {
      ...actionEnvironment(action), npm_execpath: "relative-forged-pnpm",
    };

    expect(() => resolvePnpmPackTool(repository(), environment, {
      ...actionPin(action), platform: "win32",
    })).toThrow("PACK_STEP_FAILED: pnpm handoff unavailable");
  });

  it("requires entry handoffs to carry matching independent PNPM_HOME authority", () => {
    const repositoryRoot = repository();
    const action = portableActionPnpm("entry-authority");
    const unrelated = portableActionPnpm("unrelated-authority");
    const missing = { ...process.env, npm_execpath: action.entry };
    delete missing["PNPM_HOME"];
    const cases = Object.freeze([
      ["missing", missing],
      ["mismatched", {
        ...process.env, npm_execpath: action.entry, PNPM_HOME: dirname(unrelated.shim),
      }],
    ] as const);

    expect(cases).toHaveLength(2);
    for (const [_name, environment] of cases) {
      let spawned = false;
      expect(() => resolvePnpmPackTool(repositoryRoot, environment, {
        ...portableActionPin(action), platform: "win32",
        spawn: (() => {
          spawned = true;
          return { status: 0, stderr: "", stdout: "11.0.8\n" };
        }) as never,
      })).toThrow("PACK_STEP_FAILED: pnpm package identity unavailable");
      expect(spawned).toBe(false);
    }
  });
});

describe("packaging process launch", () => {
  it("passes percent signs and shell metacharacters as literal argv", () => {
    const cwd = temporary("moe-pack-%PATH%-");
    const output = join(cwd, "argv.txt");
    const value = "literal-%PATH%-&-;-$(never-evaluate)";

    runPackStep(captureNativePackTool("node", process.execPath), [
      "-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", output, value,
    ], cwd, () => {});

    expect(readFileSync(output, "utf8")).toBe(value);
  });

  it("uses an action package tree without executing its cmd shim or PATH shadows", () => {
    const repo = repository();
    const trusted = actionPnpm();
    const shadow = write(repo, "node_modules/.bin/pnpm.cmd", "@echo attacker>executed.txt\r\n");
    const output = join(repo, "pnpm-argv.txt");
    const environment = {
      ...process.env,
      npm_execpath: trusted.shim,
      PATH: `${join(repo, "node_modules", ".bin")}${delimiter}${process.env["PATH"] ?? ""}`,
    };
    const tool = resolvePnpmPackTool(repo, environment, actionPin(trusted));

    runPackStep(tool, [output, "exact-argv"], repo, () => {}, environment);

    expect(readFileSync(output, "utf8")).toBe("exact-argv");
    expect(readFileSync(shadow, "utf8")).toContain("attacker");
    expect(() => readFileSync(join(repo, "executed.txt"), "utf8")).toThrow();
  });

  it("refuses a package-manager version mismatch", () => {
    const repo = repository();
    const trusted = actionPnpm("11.0.7");

    expect(() => resolvePnpmPackTool(repo, {
      ...process.env, npm_execpath: trusted.shim,
    }, actionPin(trusted))).toThrow("PACK_STEP_FAILED: pnpm version mismatch");
  });

  it("refuses pnpm package-tree drift both before and after a spawn", () => {
    const repo = repository();
    const pre = actionPnpm();
    const preTool = resolvePnpmPackTool(repo, { ...process.env, npm_execpath: pre.shim }, actionPin(pre));
    writeFileSync(pre.mutable, "substituted\n");
    expect(() => runPackStep(preTool, ["--version"], repo, () => {}))
      .toThrow("PACK_STEP_FAILED: tool identity changed");

    const post = actionPnpm();
    const postTool = resolvePnpmPackTool(repo, { ...process.env, npm_execpath: post.shim }, actionPin(post));
    expect(() => runPackStep(postTool, ["mutate"], repo, () => {}))
      .toThrow("PACK_STEP_FAILED: tool identity changed");
  });

  it("does not discover PowerShell from PATH", () => {
    const shadowRoot = temporary("moe-pack-powershell-shadow-");
    write(shadowRoot, "powershell.exe", "attacker\n");
    const tool = resolvePowerShellPackTool({ PATH: shadowRoot }, {
      platform: "win32", powershellExecutable: process.execPath,
    });
    expect(tool.executable.path).toBe(process.execPath);
  });

  it("refuses an action package whose normalized tree is not the pinned pnpm release", () => {
    const repo = repository();
    const action = actionPnpm();

    expect(() => resolvePnpmPackTool(repo, {
      ...process.env, npm_execpath: action.shim,
    }, {
      expectedPnpmPackageTreeSha256: "0".repeat(64),
    })).toThrow("PACK_STEP_FAILED: pnpm provenance invalid");
  });

  it("binds the pnpm package pin to the complete directory roster", () => {
    const repo = repository();
    const action = actionPnpm();
    const pinned = actionPin(action);
    mkdirSync(join(action.packageRoot, "dist", "unexpected-empty-directory"));

    expect(() => resolvePnpmPackTool(repo, {
      ...process.env, npm_execpath: action.shim,
    }, pinned)).toThrow("PACK_STEP_FAILED: pnpm provenance invalid");
  });

  it("refuses a native pnpm executable before spawn when its official hash is absent", () => {
    const repo = repository();
    const executable = write(temporary("moe-pack-native-pnpm-"), "pnpm.exe", "not pnpm\n");
    let spawned = false;

    expect(() => resolvePnpmPackTool(repo, {
      ...process.env, npm_execpath: executable,
    }, {
      expectedNativePnpmSha256: "0".repeat(64),
      spawn: (() => {
        spawned = true;
        return { status: 0, stderr: "", stdout: "11.0.8\n" };
      }) as never,
    })).toThrow("PACK_STEP_FAILED: pnpm provenance invalid");
    expect(spawned).toBe(false);
  });

  it("binds an admitted native pnpm executable to its complete sibling dist tree", () => {
    const repo = repository();
    const root = temporary("moe-pack-native-pnpm-tree-");
    const executable = write(root, "pnpm.exe", "test-native-pnpm\n");
    const dist = join(root, "dist");
    write(root, "dist/pnpm.mjs", "test-native-dist\n");
    const executableSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");

    const tool = resolvePnpmPackTool(repo, {
      ...process.env, npm_execpath: executable,
    }, {
      architecture: "x64",
      expectedNativePnpmSha256: executableSha256,
      expectedNativePnpmTreeSha256: normalizedTreeSha256(capturePackTreeIdentity(dist)),
      spawn: (() => ({ status: 0, stderr: "", stdout: "11.0.8\n" })) as never,
    });

    expect(tool.tree?.root).toBe(dist);
    expect(tool.tree?.entries.filter((entry) => entry.kind === "file")
      .map((entry) => entry.path)).toEqual(["pnpm.mjs"]);
  });

  it("resolves Git, Node, PowerShell and tar only at fixed protected roots", () => {
    type Resolver = (kind: "git" | "node" | "powershell" | "tar", dependencies: {
      platform: string; protectedProgramFilesRoot: string; protectedSystemRoot: string;
    }) => string;
    const resolver = (packCommand as unknown as {
      readonly resolveProtectedWindowsPackExecutable?: Resolver;
    }).resolveProtectedWindowsPackExecutable;
    expect(typeof resolver).toBe("function");
    if (resolver === undefined) return;
    const programFiles = temporary("moe-protected-program-files-");
    const systemRoot = temporary("moe-protected-windows-");
    const expected = {
      git: write(programFiles, "Git/cmd/git.exe", "git\n"),
      node: write(programFiles, "nodejs/node.exe", "node\n"),
      powershell: write(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe", "ps\n"),
      tar: write(systemRoot, "System32/tar.exe", "tar\n"),
    } as const;
    const dependencies = {
      platform: "win32", protectedProgramFilesRoot: programFiles, protectedSystemRoot: systemRoot,
    };

    for (const kind of ["git", "node", "powershell", "tar"] as const) {
      expect(resolver(kind, dependencies)).toBe(expected[kind]);
    }
  });

  it("ignores ambient SystemRoot when resolving the protected PowerShell broker", () => {
    const protectedSystemRoot = temporary("moe-protected-powershell-");
    const shadowSystemRoot = temporary("moe-shadow-powershell-");
    const expected = write(protectedSystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe", "protected\n");
    write(shadowSystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe", "shadow\n");

    const tool = resolvePowerShellPackTool({ SYSTEMROOT: shadowSystemRoot }, {
      platform: "win32", protectedSystemRoot,
    });

    expect(tool.executable.path).toBe(expected);
  });

  it("authenticates setup-node bytes instead of trusting their installation path", () => {
    const repo = repository();
    const action = actionPnpm();

    expect(() => resolveWindowsPackToolchain(repo, {
      ...process.env, npm_execpath: action.shim,
    }, {
      architecture: "x64",
      expectedNodeSha256: "0".repeat(64),
      nodeExecutable: process.execPath,
      nodeVersion: "v24.16.0",
      platform: "win32",
      powershellExecutable: process.execPath,
      ...actionPin(action),
    })).toThrow("PACK_STEP_FAILED: node provenance invalid");
  });

  it("round-trips the closed tool manifest and refuses extra authority", () => {
    const node = captureNativePackTool("node", process.execPath);
    const toolchain: WindowsPackToolchain = Object.freeze({
      cargo: { ...node, kind: "cargo" as const },
      node, pnpm: { ...node, kind: "pnpm" as const },
      powershell: { ...node, kind: "powershell" as const },
      schemaVersion: "moe-windows-pack-toolchain/1",
    });
    const encoded = serializeWindowsPackToolchain(toolchain);
    expect(parseWindowsPackToolchain(encoded)).toEqual(toolchain);
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    parsed["ambientPath"] = "attacker";
    expect(() => parseWindowsPackToolchain(JSON.stringify(parsed)))
      .toThrow("PACK_STEP_FAILED: tool manifest invalid");
  });

  const CARGO_PIN = readCargoToolchainPins();
  const CARGO_KEYS = Object.freeze(["cargo", "node", "pnpm", "powershell", "schemaVersion"]);

  function pinnedCargoExecutable(): string {
    const rustup = process.env["RUSTUP_HOME"]
      ?? join(process.env["USERPROFILE"] ?? "", ".rustup");
    return join(rustup, "toolchains", CARGO_PIN.toolchain, "bin", "cargo.exe");
  }

  function cargoFixture(
    toolchain = CARGO_PIN.toolchain, name = "cargo.exe", body = "counterfeit cargo bytes\n",
    root = temporary("moe-pack-cargo-tool-"),
  ): string {
    return write(root, `toolchains/${toolchain}/bin/${name}`, body);
  }

  function cargoDependencies(cargoExecutable: string): Readonly<{
    readonly dependencies: Record<string, unknown>;
    readonly shim: string;
  }> {
    const action = actionPnpm();
    return Object.freeze({
      dependencies: {
        architecture: "x64",
        cargoExecutable,
        expectedNodeSha256: createHash("sha256")
          .update(readFileSync(process.execPath)).digest("hex"),
        nodeExecutable: process.execPath,
        nodeVersion: process.version,
        platform: "win32",
        ...actionPin(action),
      },
      shim: action.shim,
    });
  }

  function resolveWithCargo(cargoExecutable: string): WindowsPackToolchain {
    const repo = repository();
    const seam = cargoDependencies(cargoExecutable);
    return resolveWindowsPackToolchain(repo, {
      ...process.env, npm_execpath: seam.shim,
    }, seam.dependencies);
  }

  function cargoRefusal(action: () => unknown): PackCargoToolError {
    let caught: unknown;
    try { action(); } catch (error) { caught = error; }
    // DIVERGENCE: every sibling fence inside resolveWindowsPackToolchain throws a plain Error
    // whose message carries a ": <detail>" suffix ("node provenance invalid",
    // "PowerShell unavailable", "pnpm provenance invalid", "pnpm version mismatch").
    // Only the Cargo guard produces a PackCargoToolError whose message is the bare stable code,
    // so this assertion names which layer refused rather than merely that something refused.
    expect(caught).toBeInstanceOf(PackCargoToolError);
    expect(caught).toMatchObject({
      code: "PACK_STEP_FAILED", layer: PACKAGING_TOOLCHAIN_LAYER, message: "PACK_STEP_FAILED",
    });
    return caught as PackCargoToolError;
  }

  it.runIf(process.platform === "win32")(
    "carries the pinned Cargo identity through the resolved Windows toolchain", () => {
      const toolchain = resolveWithCargo(pinnedCargoExecutable());

      expect(toolchain.cargo.kind).toBe("cargo");
      expect(toolchain.cargo.executable.path).toBe(realpathSync(pinnedCargoExecutable()));
      expect(toolchain.cargo.executable.sha256).toBe(CARGO_PIN.cargoSha256);
      // Literal, not the pin constant: a one-character edit to cargo-toolchain-pins.json
      // must not be able to move both sides of this comparison at once.
      expect(toolchain.cargo.executable.sha256)
        .toBe("122f18d28a63fa358f3db266abee1ff1d8aabf0ab7f2dd9ac38a38da99977ae5");
      expect(toolchain.cargo.argsPrefix).toEqual([]);
      expect(Object.isFrozen(toolchain.cargo)).toBe(true);
      expect(Object.isFrozen(toolchain.cargo.argsPrefix)).toBe(true);
      expect(Object.isFrozen(toolchain.cargo.executable)).toBe(true);
    },
  );

  it.runIf(process.platform === "win32")(
    "advertises exactly the served toolchain roster in both directions", () => {
      const served = resolveWithCargo(pinnedCargoExecutable());
      const parsed = parseWindowsPackToolchain(serializeWindowsPackToolchain(served));

      // Enumerated from the production seam, not from a roster constant: set equality both ways,
      // so a member that silently vanishes from either side reddens this arm.
      expect(Object.keys(served).sort()).toEqual([...CARGO_KEYS]);
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(served).sort());
      expect(parsed).toEqual(served);
      expect(JSON.parse(serializeWindowsPackToolchain(served))).toHaveProperty("cargo");
    },
  );

  it("refuses a serialized toolchain that drops any advertised member", () => {
    const node = captureNativePackTool("node", process.execPath);
    const toolchain: WindowsPackToolchain = Object.freeze({
      cargo: { ...node, kind: "cargo" as const },
      node, pnpm: { ...node, kind: "pnpm" as const },
      powershell: { ...node, kind: "powershell" as const },
      schemaVersion: "moe-windows-pack-toolchain/1",
    });
    const encoded = serializeWindowsPackToolchain(toolchain);
    expect(parseWindowsPackToolchain(encoded)).toEqual(toolchain);

    for (const key of CARGO_KEYS) {
      const parsed = JSON.parse(encoded) as Record<string, unknown>;
      delete parsed[key];
      expect(() => parseWindowsPackToolchain(JSON.stringify(parsed)))
        .toThrow("PACK_STEP_FAILED: tool manifest invalid");
    }
    expect(CARGO_KEYS).toHaveLength(5);
  });

  it("refuses a Cargo member whose declared kind is not cargo", () => {
    const node = captureNativePackTool("node", process.execPath);
    const encoded = serializeWindowsPackToolchain(Object.freeze({
      cargo: { ...node, kind: "cargo" as const },
      node, pnpm: { ...node, kind: "pnpm" as const },
      powershell: { ...node, kind: "powershell" as const },
      schemaVersion: "moe-windows-pack-toolchain/1",
    }));
    const parsed = JSON.parse(encoded) as Record<string, Record<string, unknown>>;
    parsed["cargo"]!["kind"] = "node";

    expect(() => parseWindowsPackToolchain(JSON.stringify(parsed)))
      .toThrow("PACK_STEP_FAILED: tool manifest invalid");
  });

  it.runIf(process.platform === "win32")(
    "refuses every counterfeit Cargo at the packaging toolchain layer", () => {
      const repositoryRoot = repository();
      const linkRoot = join(temporary("moe-pack-cargo-link-"), "toolchains",
        CARGO_PIN.toolchain);
      mkdirSync(linkRoot, { recursive: true });
      symlinkSync(dirname(realpathSync(pinnedCargoExecutable())), join(linkRoot, "bin"),
        "junction");
      const symlinked = join(linkRoot, "bin", "cargo.exe");
      const cases = Object.freeze([
        Object.freeze({
          executable: join(temporary("moe-pack-cargo-missing-"), "toolchains",
            CARGO_PIN.toolchain, "bin", "cargo.exe"),
          name: "missing",
        }),
        Object.freeze({ executable: cargoFixture(), name: "wrong-digest" }),
        Object.freeze({
          executable: cargoFixture(CARGO_PIN.toolchain, "cargo.exe",
            "counterfeit cargo bytes\n", repositoryRoot),
          name: "in-repository",
        }),
        Object.freeze({
          executable: cargoFixture(CARGO_PIN.toolchain, "cargo-copy.exe"), name: "wrong-name",
        }),
        Object.freeze({
          executable: cargoFixture("stable-x86_64-pc-windows-msvc"), name: "wrong-toolchain",
        }),
        Object.freeze({ executable: symlinked, name: "symlinked" }),
        Object.freeze({ executable: "cargo.exe", name: "relative" }),
      ]);

      expect(cases.length).toBeGreaterThan(0);
      for (const scenario of cases) {
        cargoRefusal(() => resolveWithCargo(scenario.executable));
      }
      expect(cases).toHaveLength(7);
    },
    120_000,
  );

  it.runIf(process.platform === "win32")(
    "refuses when no pinned Cargo location is carried at all", () => {
      const repo = repository();
      const seam = cargoDependencies(pinnedCargoExecutable());
      const { cargoExecutable: _dropped, ...withoutCargo } = seam.dependencies;

      cargoRefusal(() => resolveWindowsPackToolchain(repo, {
        ...process.env, npm_execpath: seam.shim, RUSTUP_HOME: "", USERPROFILE: "",
      }, withoutCargo));
    },
  );
});
