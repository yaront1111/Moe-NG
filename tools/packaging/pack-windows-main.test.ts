import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPackRuntimeMatchesCommit,
  packChildEnvironment,
  packWindowsFromCommit,
  resolvePackExecutable,
} from "./pack-windows-main.js";
import { withPrivateWindowsCandidate } from "./pack-windows-candidate.js";

const roots: string[] = [];

function executableFromPath(name: string): string {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidateRoot = directory.replace(/^"|"$/gu, "");
    if (!isAbsolute(candidateRoot)) continue;
    for (const candidate of process.platform === "win32" ? [`${name}.exe`, name] : [name]) {
      try {
        const resolved = realpathSync(join(candidateRoot, candidate));
        if (statSync(resolved).isFile()) return resolved;
      } catch { /* keep searching */ }
    }
  }
  throw new Error(`missing test executable: ${name}`);
}

const gitExecutable = executableFromPath("git");
const pnpmExecutable = executableFromPath("pnpm");
const tarExecutable = executableFromPath("tar");
const tarVersion = spawnSync(tarExecutable, ["--version"], {
  cwd: dirname(tarExecutable), encoding: "utf8", shell: false, windowsHide: true,
});
const tarFlavor = String(tarVersion.stdout).startsWith("bsdtar ") ? "bsdtar" : "gnu";

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync(gitExecutable, [...args], {
    cwd, encoding: "utf8", shell: false, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return result.stdout.trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("the production Windows pack source composition", () => {
  it.runIf(process.platform === "win32")("ignores PATH shadows for protected Git and tar", () => {
    const repositoryRoot = join(import.meta.dirname, "..", "..");
    const priorPath = process.env["PATH"];
    process.env["PATH"] = join(repositoryRoot, "attacker-bin");
    try {
      expect(resolvePackExecutable(repositoryRoot, "git")).toBe(
        realpathSync("C:\\Program Files\\Git\\cmd\\git.exe"),
      );
      expect(resolvePackExecutable(repositoryRoot, "tar")).toBe(
        realpathSync("C:\\Windows\\System32\\tar.exe"),
      );
    } finally {
      if (priorPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = priorPath;
    }
  });

  it("preserves even an undefined synchronous consumer failure", () => {
    let caught = false;
    try {
      withPrivateWindowsCandidate(() => { throw undefined; });
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }
    expect(caught).toBe(true);
  });

  it("routes the real package script through the exact-commit entrypoint", () => {
    const repositoryRoot = join(import.meta.dirname, "..", "..");
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      readonly scripts?: Readonly<Record<string, unknown>>;
    };
    expect(manifest.scripts?.["pack:windows"]).toBe(
      "node tools/packaging/pack-windows-main.ts",
    );

    const run = spawnSync(pnpmExecutable, ["run", "pack:windows", "--", "--allow-dirty"], {
      cwd: repositoryRoot, encoding: "utf8", shell: false, windowsHide: true,
    });
    expect(run.status).toBe(1);
    expect(`${String(run.stdout)}${String(run.stderr)}`).toContain("PACK_SOURCE_INPUT_INVALID");
  });

  it("removes Git, archive and Node preload authority from every child", () => {
    const environment = {
      GIT_CONFIG_GLOBAL: "attacker.gitconfig",
      git_config_count: "1",
      NODE_OPTIONS: "--require=attacker.cjs",
      Node_Path: "attacker-modules-mixed-case",
      NODE_PATH: "attacker-modules",
      node_repl_external_module: "attacker-repl.cjs",
      PATH: "trusted-path",
      TAR_OPTIONS: "--checkpoint-action=exec=attacker",
      tar_options: "--use-compress-program=attacker",
    };

    expect(packChildEnvironment(environment)).toEqual({});
    expect(environment.NODE_OPTIONS).toBe("--require=attacker.cjs");
  });

  it("removes shell startup and package-manager config authority case-insensitively", () => {
    const environment = {
      BASH_ENV: "attacker-bash-env",
      CI: "true",
      ComSpec: "attacker-windows-shell.exe",
      env: "attacker-posix-env",
      NPM_CONFIG_USERCONFIG: "attacker-npmrc",
      npm_config_script_shell: "attacker-npm-shell",
      PATH: "trusted-path",
      PnPm_CoNfIg_ScRiPt_ShElL: "attacker-pnpm-shell",
      pnpm_config_globalconfig: "attacker-pnpmrc",
      shell: "attacker-posix-shell",
      SystemRoot: "C:\\Windows",
      ZdOtDiR: "attacker-zdotdir",
    };

    expect(packChildEnvironment(environment)).toEqual({
      CI: "true",
      SystemRoot: "C:\\Windows",
    });
  });

  it("removes Vite-exposed values before the production control-room build", () => {
    const environment = {
      SystemRoot: "C:\\Windows",
      VITE_MOE_LIVE_CREDENTIAL: "must-not-enter-the-bundle",
      vite_moe_live_csrf: "mixed-case-secret",
      Vite_Public_Value: "still-build-time-input",
    };

    expect(packChildEnvironment(environment)).toEqual({
      SystemRoot: "C:\\Windows",
    });
    expect(environment.VITE_MOE_LIVE_CREDENTIAL).toBe("must-not-enter-the-bundle");
  });

  it("passes only minimal platform and toolchain variables to build children", () => {
    const environment = {
      ANTHROPIC_API_KEY: "provider-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-secret",
      CI: "true",
      GITHUB_TOKEN: "repository-secret",
      LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
      NUMBER_OF_PROCESSORS: "16",
      OPENAI_API_KEY: "model-secret",
      PATHEXT: ".EXE;.CMD",
      PROCESSOR_ARCHITECTURE: "AMD64",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\safe-temp",
      TMP: "C:\\safe-temp",
      USERPROFILE: "C:\\Users\\operator",
      windir: "C:\\Windows",
    };

    expect(packChildEnvironment(environment)).toEqual({
      CI: "true",
      NUMBER_OF_PROCESSORS: "16",
      PATHEXT: ".EXE;.CMD",
      PROCESSOR_ARCHITECTURE: "AMD64",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\safe-temp",
      TMP: "C:\\safe-temp",
      windir: "C:\\Windows",
    });
  });

  it("rebuilds PATH only from explicit directories outside the checkout", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "moe-pack-path-root-"));
    const trustedRoot = mkdtempSync(join(tmpdir(), "moe-pack-path-tool-"));
    roots.push(repositoryRoot, trustedRoot);
    const ignoredBin = join(repositoryRoot, "node_modules", ".bin");
    mkdirSync(ignoredBin, { recursive: true });

    const answer = packChildEnvironment({
      PATH: `${ignoredBin}${delimiter}${trustedRoot}`,
      SystemRoot: "C:\\Windows",
    }, repositoryRoot, [ignoredBin, trustedRoot]);

    expect(answer).toEqual({ PATH: realpathSync(trustedRoot), SystemRoot: "C:\\Windows" });
  });

  it("refuses tracked or untracked live packer drift from the labeled commit", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "moe-windows-pack-runtime-"));
    roots.push(repositoryRoot);
    git(["init", "--quiet"], repositoryRoot);
    git(["config", "user.email", "pack-runtime@example.invalid"], repositoryRoot);
    git(["config", "user.name", "Pack Runtime Test"], repositoryRoot);
    mkdirSync(join(repositoryRoot, "tools", "packaging"), { recursive: true });
    writeFileSync(join(repositoryRoot, "package.json"), "{\"private\":true}\n");
    writeFileSync(join(repositoryRoot, ".gitignore"), "tools/packaging/ignored.js\n");
    const entry = join(repositoryRoot, "tools", "packaging", "entry.ts");
    writeFileSync(entry, "export const clean = true;\n");
    git(["add", "--", ".gitignore", "package.json", "tools/packaging/entry.ts"], repositoryRoot);
    git(["commit", "--quiet", "-m", "tracked runtime"], repositoryRoot);
    const sourceSha = git(["rev-parse", "HEAD"], repositoryRoot);

    expect(() => assertPackRuntimeMatchesCommit(
      repositoryRoot, sourceSha, gitExecutable,
    )).not.toThrow();

    writeFileSync(entry, "export const dirty = true;\n");
    expect(() => assertPackRuntimeMatchesCommit(
      repositoryRoot, sourceSha, gitExecutable,
    )).toThrow(expect.objectContaining({
      code: "PACK_SOURCE_PACKER_DRIFT", layer: "PACKAGING_SOURCE",
    }));

    writeFileSync(entry, "export const clean = true;\n");
    writeFileSync(join(repositoryRoot, "tools", "packaging", "untracked.ts"), "export {};\n");
    expect(() => assertPackRuntimeMatchesCommit(
      repositoryRoot, sourceSha, gitExecutable,
    )).toThrow(expect.objectContaining({
      code: "PACK_SOURCE_PACKER_DRIFT", layer: "PACKAGING_SOURCE",
    }));

    rmSync(join(repositoryRoot, "tools", "packaging", "untracked.ts"));
    writeFileSync(join(repositoryRoot, "tools", "packaging", "ignored.js"), "export {}\n");
    expect(() => assertPackRuntimeMatchesCommit(
      repositoryRoot, sourceSha, gitExecutable,
    )).toThrow(expect.objectContaining({
      code: "PACK_SOURCE_PACKER_DRIFT", layer: "PACKAGING_SOURCE",
    }));
  });

  it("loads through physical runtime bridges and refuses obsolete dirty-pack arguments", () => {
    const run = spawnSync(process.execPath, [join(import.meta.dirname, "pack-windows-main.ts"), "--allow-dirty"], {
      cwd: dirname(import.meta.dirname), encoding: "utf8", shell: false, windowsHide: true,
    });
    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toBe("PACK_SOURCE_INPUT_INVALID");
    expect(run.stderr).toBe("");

    const materialized = spawnSync(process.execPath, [
      join(import.meta.dirname, "pack-windows-materialized-main.ts"), "--unexpected",
    ], {
      cwd: dirname(import.meta.dirname), encoding: "utf8", shell: false, windowsHide: true,
    });
    expect(materialized.status).toBe(1);
    expect(materialized.stdout.trim()).toBe("PACK_SOURCE_INPUT_INVALID");
    expect(materialized.stderr).toBe("");
  });

  it("builds only from the selected Git object tree and publishes outside its temporary owner", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "moe-windows-pack-entry-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "moe-windows-pack-output-"));
    roots.push(repositoryRoot, outputRoot);
    git(["init", "--quiet"], repositoryRoot);
    git(["config", "user.email", "pack-entry@example.invalid"], repositoryRoot);
    git(["config", "user.name", "Pack Entry Test"], repositoryRoot);
    git(["config", "core.autocrlf", "false"], repositoryRoot);
    mkdirSync(join(repositoryRoot, "packages", "contracts"), { recursive: true });
    writeFileSync(join(repositoryRoot, "package.json"), "{\"private\":true}\n");
    writeFileSync(join(repositoryRoot, ".gitignore"), "packages/contracts/.env\n");
    git(["add", "--", ".gitignore", "package.json"], repositoryRoot);
    git(["commit", "--quiet", "-m", "packable source"], repositoryRoot);
    const sourceSha = git(["rev-parse", "HEAD"], repositoryRoot);
    writeFileSync(join(repositoryRoot, "packages", "contracts", ".env"), "DO_NOT_PACKAGE=1\n");
    writeFileSync(join(repositoryRoot, "untracked.txt"), "DO_NOT_PACKAGE=1\n");
    let temporarySourceRoot = "";

    const result = packWindowsFromCommit({
      log: () => {}, outputRoot, repositoryRoot, sourceSha,
    }, {
      gitExecutable,
      pack: (options) => {
        temporarySourceRoot = options.sourceRoot;
        expect(options.outputRoot).not.toBe(outputRoot);
        expect(options.sourceSha).toBe(sourceSha);
        expect(options.sourceRoot).not.toBe(repositoryRoot);
        expect(existsSync(join(options.sourceRoot, "package.json"))).toBe(true);
        expect(existsSync(join(options.sourceRoot, "packages", "contracts", ".env"))).toBe(false);
        expect(existsSync(join(options.sourceRoot, "untracked.txt"))).toBe(false);
        return 23;
      },
      tarExecutable,
      tarFlavor,
    });

    expect(result).toBe(23);
    expect(temporarySourceRoot).not.toBe("");
    expect(existsSync(dirname(temporarySourceRoot))).toBe(false);
  });

  it("publishes the private candidate only after tracked source re-verification", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "moe-windows-pack-publish-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "moe-windows-pack-public-"));
    roots.push(repositoryRoot, outputRoot);
    git(["init", "--quiet"], repositoryRoot);
    git(["config", "user.email", "pack-publish@example.invalid"], repositoryRoot);
    git(["config", "user.name", "Pack Publish Test"], repositoryRoot);
    git(["config", "core.autocrlf", "false"], repositoryRoot);
    writeFileSync(join(repositoryRoot, "package.json"), "{\"private\":true}\n");
    git(["add", "--", "package.json"], repositoryRoot);
    git(["commit", "--quiet", "-m", "packable source"], repositoryRoot);
    const sourceSha = git(["rev-parse", "HEAD"], repositoryRoot);
    let candidateRoot = "";

    const result = packWindowsFromCommit({
      log: () => {}, outputRoot, repositoryRoot, sourceSha,
    }, {
      gitExecutable,
      pack: (options) => {
        candidateRoot = options.outputRoot;
        expect(candidateRoot).not.toBe(outputRoot);
        mkdirSync(join(candidateRoot, "dist"), { recursive: true });
        writeFileSync(join(candidateRoot, "dist", "moe-windows.zip"), "verified candidate\n");
        return 0;
      },
      publish: (privateRoot, receipt, publicRoot) => {
        expect(receipt.size).toBeGreaterThan(0);
        mkdirSync(join(publicRoot, "dist"), { recursive: true });
        cpSync(join(privateRoot, "dist", "moe-windows.zip"),
          join(publicRoot, "dist", "moe-windows.zip"));
      },
      tarExecutable,
      tarFlavor,
    });

    expect(result).toBe(0);
    expect(readFileSync(join(outputRoot, "dist", "moe-windows.zip"), "utf8"))
      .toBe("verified candidate\n");
    expect(candidateRoot).not.toBe("");
    expect(existsSync(candidateRoot)).toBe(false);
  });

  it("publishes no public archive when the consumer mutates tracked source", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "moe-windows-pack-mutation-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "moe-windows-pack-refusal-"));
    roots.push(repositoryRoot, outputRoot);
    git(["init", "--quiet"], repositoryRoot);
    git(["config", "user.email", "pack-mutation@example.invalid"], repositoryRoot);
    git(["config", "user.name", "Pack Mutation Test"], repositoryRoot);
    git(["config", "core.autocrlf", "false"], repositoryRoot);
    writeFileSync(join(repositoryRoot, "package.json"), "{\"private\":true}\n");
    git(["add", "--", "package.json"], repositoryRoot);
    git(["commit", "--quiet", "-m", "packable source"], repositoryRoot);
    const sourceSha = git(["rev-parse", "HEAD"], repositoryRoot);
    let candidateRoot = "";

    expect(() => packWindowsFromCommit({
      log: () => {}, outputRoot, repositoryRoot, sourceSha,
    }, {
      gitExecutable,
      pack: (options) => {
        candidateRoot = options.outputRoot;
        mkdirSync(join(candidateRoot, "dist"), { recursive: true });
        writeFileSync(join(candidateRoot, "dist", "moe-windows.zip"), "must not publish\n");
        writeFileSync(join(options.sourceRoot, "package.json"), "{\"attacker\":true}\n");
        return 0;
      },
      tarExecutable,
      tarFlavor,
    })).toThrow(expect.objectContaining({
      code: "PACK_SOURCE_CONTENT_MISMATCH", layer: "PACKAGING_SOURCE",
    }));

    expect(existsSync(join(outputRoot, "dist", "moe-windows.zip"))).toBe(false);
    expect(candidateRoot).not.toBe("");
    expect(existsSync(candidateRoot)).toBe(false);
  });
});
