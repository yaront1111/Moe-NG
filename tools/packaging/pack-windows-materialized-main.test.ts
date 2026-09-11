import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as packCommand from "./pack-command.js";
import * as packArchive from "./pack-windows-archive.js";
import { captureNativePackTool, PACK_TOOLCHAIN_SCHEMA, serializeWindowsPackToolchain } from "./pack-command.js";
import type { PackStepRunner, WindowsPackToolchain } from "./pack-command.js";
import { runMaterializedWindowsPack } from "./pack-windows-materialized-main.js";
import { packWindows } from "./pack-windows.js";
import type { PackOptions } from "./pack-windows.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "moe-materialized-broker-"));
  roots.push(root);
  const sourceRoot = join(root, "tracked-source");
  mkdirSync(sourceRoot);
  const tool = captureNativePackTool("node", process.execPath);
  const toolchain: WindowsPackToolchain = Object.freeze({
    cargo: Object.freeze({ ...tool, kind: "cargo" }), node: tool,
    pnpm: Object.freeze({ ...tool, kind: "pnpm" }),
    powershell: Object.freeze({ ...tool, kind: "powershell" }), schemaVersion: PACK_TOOLCHAIN_SCHEMA,
  });
  const manifest = serializeWindowsPackToolchain(toolchain);
  const manifestPath = join(root, "toolchain.json");
  writeFileSync(manifestPath, manifest);
  const outputRoot = join(root, "publication");
  const sourceSha = "a".repeat(40);
  const argv = ["--output-root", outputRoot, "--source-sha", sourceSha,
    "--toolchain-manifest", manifestPath,
    "--toolchain-digest", createHash("sha256").update(manifest).digest("hex")];
  const built = join(sourceRoot, "dist", "windows-job-native", "release", "moe-windows-job-broker.exe");
  const artifactRoot = join(root, "artifact");
  const staged = join(artifactRoot, "packages", "runner", "bin", "moe-windows-job-broker.exe");
  return { argv, artifactRoot, built, outputRoot, sourceRoot, sourceSha, staged, toolchain };
}

describe("materialized Windows broker prerequisite", () => {
  it("includes the exact built broker in the real packing pipeline's archive snapshot", () => {
    const test = fixture();
    mkdirSync(test.outputRoot);
    const fixtureVersion = "9.8.7";
    writeFileSync(join(test.sourceRoot, "package.json"), JSON.stringify({ version: fixtureVersion }));
    writeFileSync(join(test.sourceRoot, "LICENSE"), "synthetic fixture license");
    const bytes = "synthetic built broker for archive snapshot";
    let targetRoot = "";
    const runStep: PackStepRunner = (tool, args) => {
      if (tool.kind === "cargo") {
        targetRoot = args[6] ?? "";
        mkdirSync(join(targetRoot, "release"), { recursive: true });
        writeFileSync(join(targetRoot, "release", "moe-windows-job-broker.exe"), bytes);
      } else if (args.includes("build")) {
        const assets = join(test.sourceRoot, "apps", "control-room", "dist");
        mkdirSync(assets, { recursive: true });
        writeFileSync(join(assets, "index.html"), "<title>fixture</title>");
      } else if (args.includes("deploy")) {
        const deploy = args.at(-1) ?? "";
        const runner = join(deploy, "node_modules", "@moe", "runner");
        mkdirSync(runner, { recursive: true });
        writeFileSync(join(runner, "package.json"), JSON.stringify({ name: "@moe/runner", version: fixtureVersion }));
        writeFileSync(join(deploy, "package.json"), JSON.stringify({ name: "@moe/daemon", version: fixtureVersion }));
        for (const file of ["cli/moe-cli-main.ts", "daemon-main.ts",
          "orchestrator/agent-wrapper-main.ts", "orchestrator/moe-up-main.ts"]) {
          const path = join(deploy, "src", file);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, "export {};\n");
        }
      }
    };
    vi.spyOn(packCommand, "runPackStep").mockImplementation(runStep);
    let artifactStaging = "";
    const publish = vi.spyOn(packArchive, "publishWindowsArchive").mockImplementation((request) => {
      artifactStaging = request.staging;
      expect(request.snapshot.entries.find((entry) => entry.path === "packages/runner/bin/moe-windows-job-broker.exe"))
        .toMatchObject({ sha256: createHash("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes) });
      expect(readFileSync(join(request.staging, "packages", "runner", "bin", "moe-windows-job-broker.exe"), "utf8"))
        .toBe(bytes);
      mkdirSync(join(request.outputRoot, "dist"), { recursive: true });
      const archive = join(request.outputRoot, "dist", "moe-windows.zip");
      writeFileSync(archive, "synthetic archive publication");
      return archive;
    });
    expect(runMaterializedWindowsPack(test.argv, {
      log: () => {}, runStep, sourceRoot: test.sourceRoot,
    })).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(existsSync(targetRoot)).toBe(false);
    expect(existsSync(artifactStaging)).toBe(false);
    expect(existsSync(join(test.sourceRoot, "packages"))).toBe(false);
    expect(existsSync(join(test.sourceRoot, "dist"))).toBe(false);
    expect(readdirSync(test.outputRoot)).toEqual(["dist"]);
  });

  it("builds through the admitted leased Cargo tool before staging and packing a fresh source tree", () => {
    const test = fixture();
    const order: string[] = [];
    let targetRoot = "";
    const runStep = vi.fn<PackStepRunner>((tool, args, cwd, _log, environment, lease) => {
      order.push("build");
      expect(tool).toEqual(test.toolchain.cargo);
      expect(lease).toEqual(test.toolchain.powershell);
      expect(environment).toBe(process.env);
      expect(cwd).toBe(test.sourceRoot);
      targetRoot = args[6] ?? "";
      expect(isAbsolute(targetRoot)).toBe(true);
      expect(relative(test.sourceRoot, targetRoot)).toMatch(/^\.\./u);
      expect(relative(test.outputRoot, targetRoot)).toMatch(/^\.\./u);
      expect(args).toEqual(["build", "--locked", "--release", "--manifest-path",
        "packages/runner/src/platform/windows/native/Cargo.toml", "--target-dir",
        targetRoot, "-p", "moe-windows-job-broker"]);
      expect(existsSync(test.staged)).toBe(false);
      const built = join(targetRoot, "release", "moe-windows-job-broker.exe");
      mkdirSync(dirname(built), { recursive: true });
      writeFileSync(built, "synthetic broker from this locked build");
    });
    const pack = vi.fn((options: PackOptions) => {
      order.push("pack");
      options.stageBroker?.(test.artifactRoot);
      expect(readFileSync(test.staged, "utf8")).toBe("synthetic broker from this locked build");
      expect(options).toMatchObject({
        outputRoot: test.outputRoot, sourceRoot: test.sourceRoot, sourceSha: test.sourceSha,
        toolchain: test.toolchain,
      });
      return 0;
    });
    expect(runMaterializedWindowsPack(test.argv, {
      log: () => {}, pack, runStep, sourceRoot: test.sourceRoot,
    })).toBe(0);
    expect(order).toEqual(["build", "pack"]);
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(pack).toHaveBeenCalledTimes(1);
    expect(existsSync(targetRoot)).toBe(false);
    expect(existsSync(join(test.sourceRoot, "dist"))).toBe(false);
    expect(existsSync(join(test.sourceRoot, "packages"))).toBe(false);
    expect(readdirSync(test.sourceRoot)).toEqual([]);
    expect(existsSync(test.outputRoot)).toBe(false);
  });

  it("refuses a failed locked build before staging even when stale output exists", () => {
    const test = fixture();
    mkdirSync(dirname(test.built), { recursive: true });
    writeFileSync(test.built, "stale broker output");
    const failed = new Error("PACK_STEP_FAILED: cargo failed");
    const pack = vi.fn(() => 0);
    let targetRoot = "";
    const runStep = vi.fn<PackStepRunner>((_tool, args) => {
      targetRoot = args[6] ?? "";
      mkdirSync(targetRoot);
      writeFileSync(join(targetRoot, "partial-output"), "unfinished build");
      throw failed;
    });
    expect(() => runMaterializedWindowsPack(test.argv, {
      log: () => {}, pack, runStep, sourceRoot: test.sourceRoot,
    })).toThrow(failed);
    expect(existsSync(test.staged)).toBe(false);
    expect(targetRoot).not.toBe("");
    expect(existsSync(targetRoot)).toBe(false);
    expect(readFileSync(test.built, "utf8")).toBe("stale broker output");
    expect(pack).not.toHaveBeenCalled();
  });

  it("still refuses a successful command that produces no broker", () => {
    const test = fixture();
    const pack = vi.fn(() => 0);
    const runStep = vi.fn<PackStepRunner>(() => {});
    expect(() => runMaterializedWindowsPack(test.argv, {
      log: () => {}, pack, runStep, sourceRoot: test.sourceRoot,
    })).toThrow(expect.objectContaining({
      code: "PACK_STEP_FAILED", layer: "PACKAGING_BROKER", reason: "BROKER_SOURCE_UNUSABLE",
    }));
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(pack).not.toHaveBeenCalled();
  });

  it("refuses broker substitution during packaging and removes the native scratch", () => {
    const test = fixture();
    let targetRoot = "";
    const runStep: PackStepRunner = (_tool, args) => {
      targetRoot = args[6] ?? "";
      mkdirSync(join(targetRoot, "release"), { recursive: true });
      writeFileSync(join(targetRoot, "release", "moe-windows-job-broker.exe"), "broker-alpha");
    };
    const pack = vi.fn((options: PackOptions) => {
      const pinned = join(dirname(targetRoot), "packages", "runner", "bin", "moe-windows-job-broker.exe");
      writeFileSync(pinned, "broker-omega");
      options.stageBroker?.(test.artifactRoot);
      return 0;
    });
    expect(() => runMaterializedWindowsPack(test.argv, {
      log: () => {}, pack, runStep, sourceRoot: test.sourceRoot,
    })).toThrow(expect.objectContaining({
      code: "PACK_STEP_FAILED", layer: "PACKAGING_BROKER", reason: "BROKER_DIGEST_MISMATCH",
    }));
    expect(existsSync(targetRoot)).toBe(false);
    expect(readdirSync(test.sourceRoot)).toEqual([]);
    expect(existsSync(test.outputRoot)).toBe(false);
  });

  it("refuses a direct pack call without broker staging before any build or publication", () => {
    const test = fixture();
    expect(() => packWindows({
      log: () => {}, outputRoot: test.outputRoot, sourceRoot: test.sourceRoot,
      sourceSha: test.sourceSha, toolchain: test.toolchain,
    })).toThrow("PACK_STEP_FAILED: broker staging unavailable");
    expect(existsSync(test.outputRoot)).toBe(false);
    expect(readdirSync(test.sourceRoot)).toEqual([]);
  });
});
