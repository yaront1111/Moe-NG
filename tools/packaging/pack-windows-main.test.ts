import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  reportWindowsPackChildRefusal,
  resolvePackExecutable,
} from "./pack-windows-main.js";
import {
  PACK_TOOLCHAIN_SCHEMA, resolveProtectedWindowsPackExecutable,
} from "./pack-command.js";
import { withPrivateWindowsCandidate } from "./pack-windows-candidate.js";
import { captureNativePackTool } from "./pack-tool-identity.js";
import { canonicalWindowsReleaseValue } from "../../scripts/release/windows-pack-observation-contract.mjs";
import {
  canonicalWindowsPackObservationBytes,
  createWindowsPackObservation,
} from "../../scripts/release/windows-pack-observation.mjs";
import { publishWindowsPackObservationOutput } from "../../scripts/release/windows-pack-observation-output.mjs";
import { verifyWindowsRelease } from "../../scripts/release/verify-windows-release.mjs";

const roots: string[] = [];

interface TestCommand {
  readonly args: readonly string[];
  readonly executable: string;
}

function commandFromPath(name: string): TestCommand {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidateRoot = directory.replace(/^"|"$/gu, "");
    if (!isAbsolute(candidateRoot)) continue;
    // Extensionless setup-pnpm shims are shell scripts and cannot be passed directly to
    // CreateProcess with shell:false. Windows therefore accepts only a native executable here.
    for (const candidate of process.platform === "win32" ? [`${name}.exe`] : [name]) {
      try {
        const resolved = realpathSync(join(candidateRoot, candidate));
        if (statSync(resolved).isFile()) return { args: [], executable: resolved };
      } catch { /* keep searching */ }
    }
    if (process.platform === "win32" && name === "pnpm") {
      try {
        const entry = realpathSync(join(candidateRoot, "..", "pnpm", "bin", "pnpm.cjs"));
        if (statSync(entry).isFile()) return { args: [entry], executable: process.execPath };
      } catch { /* keep searching */ }
    }
  }
  throw new Error(`missing test executable: ${name}`);
}

const gitExecutable = commandFromPath("git").executable;
const pnpmCommand = commandFromPath("pnpm");
const tarExecutable = commandFromPath("tar").executable;
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
  it("surfaces a bounded structured refusal for a failed materialized child", () => {
    const lines: string[] = [];
    const oversized = `${"x".repeat(4_095)}🙂secret-tail`;

    expect(reportWindowsPackChildRefusal(lines.push.bind(lines), {
      status: 17, stderr: oversized,
    })).toBe(17);
    expect(lines).toHaveLength(1);
    const refusal = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(refusal).toEqual({
      code: "PACK_SOURCE_IMMUTABILITY_FAILED",
      layer: "PACKAGING_SOURCE",
      ok: false,
      status: 17,
      stderr: "x".repeat(4_095),
      stderrTruncated: true,
    });
    expect(Buffer.byteLength(String(refusal["stderr"]), "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("refuses to report a successful or invalid child status as a refusal", () => {
    for (const status of [0, -1, 0x1_0000_0000, Number.NaN]) {
      expect(() => reportWindowsPackChildRefusal(() => {}, { status, stderr: "" }))
        .toThrow(expect.objectContaining({
          code: "PACK_SOURCE_IMMUTABILITY_FAILED", layer: "PACKAGING_SOURCE",
        }));
    }
  });

  it.runIf(process.platform === "win32")(
    "wires the bounded refusal report into the real materialized-child boundary", () => {
      const repositoryRoot = mkdtempSync(join(tmpdir(), "moe-pack-child-refusal-"));
      const outputRoot = mkdtempSync(join(tmpdir(), "moe-pack-child-refusal-output-"));
      roots.push(repositoryRoot, outputRoot);
      git(["init", "--quiet"], repositoryRoot);
      git(["config", "user.email", "pack-child@example.invalid"], repositoryRoot);
      git(["config", "user.name", "Pack Child Test"], repositoryRoot);
      git(["config", "core.autocrlf", "false"], repositoryRoot);
      const entry = join(repositoryRoot, "tools", "packaging", "pack-windows-materialized-main.ts");
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, [
        `process.stderr.write(${JSON.stringify("x".repeat(5_000))});`,
        "process.exitCode = 17;", "",
      ].join("\n"));
      git(["add", "--", "tools/packaging/pack-windows-materialized-main.ts"], repositoryRoot);
      git(["commit", "--quiet", "-m", "refusing materialized child"], repositoryRoot);
      const sourceSha = git(["rev-parse", "HEAD"], repositoryRoot);
      const node = captureNativePackTool("node", process.execPath);
      const lines: string[] = [];

      const status = packWindowsFromCommit({
        log: (line) => lines.push(line), outputRoot, repositoryRoot, sourceSha,
      }, {
        gitExecutable, tarExecutable, tarFlavor,
        toolchain: Object.freeze({
          node, pnpm: captureNativePackTool("pnpm", process.execPath),
          powershell: captureNativePackTool(
            "powershell", resolveProtectedWindowsPackExecutable("powershell"),
          ),
          schemaVersion: PACK_TOOLCHAIN_SCHEMA,
        }),
      });

      expect(status).toBe(17);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1] ?? "")).toEqual({
        code: "PACK_SOURCE_IMMUTABILITY_FAILED", layer: "PACKAGING_SOURCE", ok: false,
        status: 17, stderr: "x".repeat(4_096), stderrTruncated: true,
      });
      expect(lines).not.toContain("x".repeat(5_000));
      expect(existsSync(join(outputRoot, "dist", "moe-windows.zip"))).toBe(false);
    },
  );

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
  }, 120_000);

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

    const run = spawnSync(pnpmCommand.executable, [
      ...pnpmCommand.args, "run", "pack:windows", "--", "--allow-dirty",
    ], {
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
    const repositoryRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-pack-path-root-")));
    const trustedRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-pack-path-tool-")));
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
    const repositoryRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-windows-pack-runtime-")));
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
    const repositoryRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-windows-pack-entry-")));
    const outputRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-windows-pack-output-")));
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

  it("admits the same commit-anchored private candidate through Windows release authority", async () => {
    const repositoryRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-windows-pack-authority-")));
    const outputRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-windows-pack-authority-output-")));
    roots.push(repositoryRoot, outputRoot);
    git(["init", "--quiet"], repositoryRoot);
    git(["config", "user.email", "pack-authority@example.invalid"], repositoryRoot);
    git(["config", "user.name", "Pack Authority Test"], repositoryRoot);
    git(["config", "core.autocrlf", "false"], repositoryRoot);
    mkdirSync(join(repositoryRoot, ".moe"), { recursive: true });
    writeFileSync(join(repositoryRoot, "package.json"), "{\"private\":true}\n");
    writeFileSync(join(repositoryRoot, ".moe", "runtime-state.json"), "{\"state\":\"ephemeral\"}\n");
    git(["add", "--", "package.json"], repositoryRoot);
    git(["add", "--force", "--", ".moe/runtime-state.json"], repositoryRoot);
    git(["commit", "--quiet", "-m", "candidate with runtime state"], repositoryRoot);
    const sourceSha = git(["rev-parse", "HEAD"], repositoryRoot);
    expect(git(["ls-tree", "-r", "--name-only", sourceSha], repositoryRoot).split("\n"))
      .toContain(".moe/runtime-state.json");
    const candidateBytes = Buffer.from("PK\u0003\u0004commit-anchored-candidate", "utf8");
    const candidateSha256 = createHash("sha256").update(candidateBytes).digest("hex");
    let privateCandidateRoot = "";
    let publishedReceipt: Readonly<{ readonly sha256: string; readonly size: number }> | undefined;

    const status = packWindowsFromCommit({
      log: () => {}, outputRoot, repositoryRoot, sourceSha,
    }, {
      gitExecutable,
      pack: (options) => {
        expect(options.sourceSha).toBe(sourceSha);
        expect(existsSync(join(options.sourceRoot, ".moe"))).toBe(false);
        mkdirSync(join(options.outputRoot, "dist"), { recursive: true });
        writeFileSync(join(options.outputRoot, "dist", "moe-windows.zip"), candidateBytes);
        return 0;
      },
      publish: (privateRoot, receipt, publicRoot) => {
        privateCandidateRoot = privateRoot;
        publishedReceipt = receipt;
        mkdirSync(join(publicRoot, "dist"), { recursive: true });
        cpSync(join(privateRoot, "dist", "moe-windows.zip"),
          join(publicRoot, "dist", "moe-windows.zip"));
      },
      tarExecutable,
      tarFlavor,
    });

    expect(status).toBe(0);
    expect(publishedReceipt).toEqual({ sha256: candidateSha256, size: candidateBytes.byteLength });
    expect(privateCandidateRoot).not.toBe("");
    expect(existsSync(privateCandidateRoot)).toBe(false);

    const dist = join(outputRoot, "dist");
    const zip = join(dist, "moe-windows.zip");
    const evidence = join(dist, "moe-windows.zip.release-evidence.json");
    const receipt = join(dist, "moe-windows.zip.provenance.json");
    const bundle = join(dist, "moe-windows.zip.attestation.json");
    writeFileSync(evidence, canonicalWindowsReleaseValue({
      audit: {}, buildCount: 2, builds: [], componentCount: 6, doctor: {}, licenses: {},
      operation: "RECORDED", os: [], publicationAuthorized: false, releaseVerdict: "UNKNOWN",
      sbom: {}, source: { objectFormat: sourceSha.length === 40 ? "sha1" : "sha256", sourceSha },
      templateCount: 3, tools: {},
    }));

    const observation = await createWindowsPackObservation({
      artifactPath: zip,
      cwd: outputRoot,
      releaseEvidencePath: evidence,
      runnerArch: "X64",
      runnerImageOS: "win22",
      runnerImageVersion: "20260830.1",
      sourceSha,
    });
    expect(observation).toMatchObject({
      artifact: { byteLength: candidateBytes.byteLength, sha256: candidateSha256 },
      publicationAuthorized: false,
      sourceSha,
    });
    await publishWindowsPackObservationOutput({
      artifactPath: zip,
      bytes: canonicalWindowsPackObservationBytes(observation),
      cwd: outputRoot,
      outputPath: receipt,
    });
    writeFileSync(bundle, "{}\n");

    const repository = "yaront1111/Moe-NG";
    const signerWorkflow = `${repository}/.github/workflows/reusable-windows-release.yml`;
    const sourceRef = "refs/heads/main";
    const calls: Array<Readonly<{ readonly args: readonly string[]; readonly file: string }>> = [];
    const result = await verifyWindowsRelease([
      "--zip", zip, "--receipt", receipt, "--bundle", bundle,
      "--release-evidence", evidence, "--repository", repository,
      "--signer-workflow", signerWorkflow, "--signer-digest", sourceSha,
      "--source-digest", sourceSha, "--source-ref", sourceRef, "--deny-self-hosted-runners",
    ], { execute: async (file: string, args: string[]) => {
      calls.push({ args: Object.freeze([...args]), file });
      const argument = (name: string): string => {
        const index = args.indexOf(name);
        const value = index < 0 ? undefined : args[index + 1];
        if (value === undefined) throw new Error(`missing verifier argument ${name}`);
        return value;
      };
      const signer = `https://github.com/${argument("--signer-workflow")}@${argument("--source-ref")}`;
      return { exitCode: 0, stderr: "", stdout: JSON.stringify([{
        verificationResult: { signature: { certificate: {
          buildConfigDigest: argument("--source-digest"),
          buildConfigURI: `https://github.com/${argument("--repo")}/.github/workflows/windows-release-candidate.yml@${argument("--source-ref")}`,
          buildSignerDigest: argument("--signer-digest"), buildSignerURI: signer,
          buildTrigger: "workflow_dispatch", runnerEnvironment: "github-hosted",
          sourceRepositoryDigest: argument("--source-digest"),
          sourceRepositoryRef: argument("--source-ref"),
          sourceRepositoryURI: `https://github.com/${argument("--repo")}`,
          subjectAlternativeName: signer,
        } } },
      }]) };
    } });

    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({
      artifact: { sha256: candidateSha256 }, mode: "CI_ATTESTED", ok: true,
      publicationAuthorized: false, sourceSha,
    });
  });

  it("publishes the private candidate only after tracked source re-verification", () => {
    const repositoryRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-windows-pack-publish-")));
    const outputRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-windows-pack-public-")));
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
    const repositoryRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-windows-pack-mutation-")));
    const outputRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-windows-pack-refusal-")));
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
