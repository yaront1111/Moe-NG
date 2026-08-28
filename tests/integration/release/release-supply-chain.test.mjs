import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const AUTHENTICATOR = join(ROOT, "tools", "packaging", "authenticate-node.ps1");
const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TAR = "C:\\Windows\\System32\\tar.exe";
const WHERE = "C:\\Windows\\System32\\where.exe";
const MARKER = "FORGED_PNPM_EXECUTED";

// Without this the refusal assertions are vacuous: "no ZIP, no marker" passes identically
// when the forgery was never reachable in the first place. Prove the substituted pnpm wins
// a PATH lookup and owns PNPM_HOME before asserting that the release path still refused it.
function assertForgeryIsReachable(forged, environment) {
  assert.equal(environment.PNPM_HOME, forged.binDirectory);
  const resolved = run(WHERE, ["pnpm"], { env: environment });
  requireSuccess(resolved, "resolve pnpm on the staged PATH");
  const first = resolved.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0);
  assert.equal(first, join(forged.binDirectory, "pnpm.cmd"),
    `forged pnpm did not win the PATH lookup: ${resolved.stdout}`);
}

function run(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: options.timeout ?? 60_000,
    windowsHide: true,
  });
}

function requireSuccess(result, label) {
  assert.equal(result.error, undefined, `${label}: ${String(result.error)}`);
  assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
}

function materializeRepository(workspace) {
  const archive = join(workspace, "repository.tar");
  const repository = join(workspace, "repository");
  mkdirSync(repository);
  requireSuccess(run(GIT, ["-C", ROOT, "archive", "--format=tar", "-o", archive, "HEAD"]),
    "archive HEAD");
  requireSuccess(run(TAR, ["-xf", archive, "-C", repository]), "extract HEAD");
  // Deliberately overwrite the archived authenticator with the WORKING copy. Once this file
  // is committed the archive already carries identical bytes, but a mutation drill edits the
  // worktree, and without this the drill would silently grade the unmutated HEAD copy.
  copyFileSync(AUTHENTICATOR,
    join(repository, "tools", "packaging", "authenticate-node.ps1"));
  requireSuccess(run(GIT, ["init", "--initial-branch", "main"], { cwd: repository }), "git init");
  requireSuccess(run(GIT, ["config", "core.autocrlf", "false"], { cwd: repository }),
    "disable autocrlf");
  requireSuccess(run(GIT, ["add", "--all"], { cwd: repository }), "git add fixture");
  requireSuccess(run(GIT, [
    "-c", "commit.gpgsign=false", "-c", "user.name=Moe Test",
    "-c", "user.email=moe-test.invalid", "commit", "-m", "fixture",
  ], { cwd: repository }), "git commit fixture");
  return repository;
}

function stageRunnerNode(workspace, pins) {
  const architecture = process.arch === "x64" ? "x64" : process.arch;
  const root = join(workspace, "tool-cache");
  const executable = join(root, "node", pins.nodeVersion.slice(1), architecture, "node.exe");
  mkdirSync(dirname(executable), { recursive: true });
  copyFileSync(process.execPath, executable);
  return { architecture, executable, root };
}

function stageForgedPnpm(workspace, version) {
  const destination = join(workspace, "forged-action-setup");
  const binDirectory = join(destination, "node_modules", ".bin");
  const packageRoot = join(destination, "node_modules", "pnpm");
  const entry = join(packageRoot, "bin", "pnpm.mjs");
  const markerPath = join(workspace, "forged-pnpm-ran.txt");
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(join(binDirectory, "pnpm.cmd"), "@echo off\r\n");
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({
    bin: { pnpm: "bin/pnpm.mjs" }, name: "pnpm", version,
  })}\n`);
  writeFileSync(entry, [
    "import { appendFileSync } from 'node:fs';",
    "const marker = ['FORGED', 'PNPM', 'EXECUTED'].join('_');",
    "appendFileSync(process.env.FORGED_PNPM_MARKER, `${marker}\\n`);",
    `if (process.argv.at(-1) === '--version') process.stdout.write('${version}\\n');`,
    "else process.exitCode = 86;",
    "",
  ].join("\n"));
  return { binDirectory, markerPath };
}

test("R3-12-F refuses forged pnpm before ZIP production or attacker execution", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, () => {
  assert.equal(existsSync(AUTHENTICATOR), true, "production Node authenticator is absent");
  const workspace = mkdtempSync(join(tmpdir(), "moe-r3-12f-"));
  try {
    const pins = JSON.parse(readFileSync(join(ROOT, "tools", "packaging", "toolchain-pins.json")));
    const repository = materializeRepository(workspace);
    const runnerNode = stageRunnerNode(workspace, pins);
    const forged = stageForgedPnpm(workspace, pins.pnpmVersion);
    const nodeCryptoDigest = createHash("sha256")
      .update(readFileSync(runnerNode.executable)).digest("hex");
    assert.equal(nodeCryptoDigest, pins.nodeSha256);
    const environment = {
      ...process.env,
      FORGED_PNPM_MARKER: forged.markerPath,
      PATH: `${forged.binDirectory};${process.env.PATH ?? ""}`,
      PNPM_HOME: forged.binDirectory,
      RUNNER_ARCH: runnerNode.architecture.toUpperCase(),
      RUNNER_TOOL_CACHE: runnerNode.root,
    };
    delete environment.npm_execpath;
    assertForgeryIsReachable(forged, environment);
    const result = run(POWERSHELL, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", join(repository, "tools", "packaging", "authenticate-node.ps1"),
      "-Entry", "tools/packaging/pack-windows-main.ts",
    ], { cwd: repository, env: environment, timeout: 120_000 });
    const output = `${result.stdout}${result.stderr}`;

    // Attacker-execution observables come first on purpose. A refusal-message equality that
    // ran first would red on message shape and mask whether the forged pnpm actually ran.
    assert.equal(existsSync(forged.markerPath), false,
      `forged pnpm executed: ${output}`);
    assert.equal(output.includes(MARKER), false, output);
    assert.equal(existsSync(join(repository, "dist", "moe-windows.zip")), false,
      `forged ZIP produced: ${output}`);
    assert.equal(result.status, 1, output);
    assert.equal(output.trim(), "PACK_STEP_FAILED: pnpm provenance invalid");
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});
