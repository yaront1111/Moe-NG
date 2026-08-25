import { createHash } from "node:crypto";
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureNativePackTool, parseWindowsPackToolchain, resolvePnpmPackTool,
  resolvePowerShellPackTool, resolveWindowsPackToolchain, runPackStep,
  serializeWindowsPackToolchain,
  type WindowsPackToolchain,
} from "./pack-command.js";
import * as packCommand from "./pack-command.js";

const roots: string[] = [];

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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
  const packageRoot = join(root, "node_modules", "pnpm");
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
  const shim = write(root, "node_modules/.bin/pnpm.cmd", "@exit /b 99\r\n");
  return Object.freeze({ entry, mutable, packageRoot, root, shim });
}

function normalizedTreeSha256(root: string): string {
  const entries: Array<Readonly<{
    kind: "directory" | "file"; path: string; sha256: string; size: number;
  }>> = [{ kind: "directory", path: ".", sha256: "", size: 0 }];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push(Object.freeze({
          kind: "directory", path: relative(root, path).replaceAll("\\", "/"),
          sha256: "", size: 0,
        }));
        pending.push(path);
      }
      else if (entry.isFile()) {
        const body = readFileSync(path);
        entries.push(Object.freeze({
          kind: "file",
          path: relative(root, path).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(body).digest("hex"),
          size: lstatSync(path).size,
        }));
      }
    }
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const hash = createHash("sha256");
  for (const entry of entries) {
    for (const field of [entry.kind, entry.path, String(entry.size), entry.sha256]) {
      hash.update(field, "utf8");
      hash.update("\0", "utf8");
    }
  }
  return hash.digest("hex");
}

function actionPin(action: ReturnType<typeof actionPnpm>): Readonly<{
  readonly expectedPnpmPackageTreeSha256: string;
}> {
  return Object.freeze({ expectedPnpmPackageTreeSha256: normalizedTreeSha256(action.packageRoot) });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
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
      expectedNativePnpmTreeSha256: normalizedTreeSha256(dist),
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
});
