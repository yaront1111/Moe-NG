/**
 * The Windows pack SENTINEL: one ignored `packages/contracts/.env` driven through
 * the production `packWindowsFromCommit` composition, so the tracked-object
 * materialization, the inventory admission and the real PowerShell archive are
 * each observed on the path an operator actually runs — not on a fixture that
 * models them.
 *
 * Secret BYTES are never read, logged or asserted here. Only the fixed literal's
 * ABSENCE is checked, and only against captured log lines and the archive bytes;
 * every refusal detail is a PATH.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureNativePackTool } from "./pack-command.js";
import {
  REQUIRED_STAGED_PATHS, inspectStagedTree, type PackInventoryResult,
} from "./pack-inventory.js";
import { snapshotPackTree } from "./pack-output.js";
import { publishWindowsArchive } from "./pack-windows.js";
import {
  packWindowsFromCommit, type WindowsPackCommitDependencies,
} from "./pack-windows-main.js";

const SECRET_LITERAL = "do-not-package-7f3c1e";
const SECRET_PATH = "packages/contracts/.env";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
/** PowerShell zip create/reopen/extract costs seconds; the 5000 ms default would red. */
const ARM_TIMEOUT = 120_000;

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
const tarExecutable = executableFromPath("tar");
const tarVersion = spawnSync(tarExecutable, ["--version"], {
  cwd: dirname(tarExecutable), encoding: "utf8", shell: false, windowsHide: true,
});
const tarFlavor = String(tarVersion.stdout).startsWith("bsdtar ") ? "bsdtar" : "gnu";
const windowsPowerShell = process.platform === "win32"
  ? captureNativePackTool("powershell", POWERSHELL) : undefined;

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync(gitExecutable, [...args], {
    cwd, encoding: "utf8", shell: false, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return result.stdout.trim();
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  roots.push(root);
  return root;
}

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const target = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function walkPosix(root: string, prefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walkPosix(join(root, entry.name), path));
    else found.push(path);
  }
  return found;
}

/** Staged membership, forward-slash and sorted, exactly as the inventory wants it. */
function stagedPaths(root: string): string[] {
  return walkPosix(root, "").sort();
}

interface SentinelRepository {
  readonly repositoryRoot: string;
  readonly sourceSha: string;
  readonly trackedRoster: readonly string[];
}

/**
 * `REQUIRED_STAGED_PATHS` builds the fixture so the inventory has nothing else to
 * complain about; it is NEVER an assertion oracle. Arm B's refusal list stays
 * exact, so a roster change reds this suite on purpose.
 */
function createSentinelRepository(prefix: string, trackSecret: boolean): SentinelRepository {
  const repositoryRoot = temporaryRoot(prefix);
  git(["init", "--quiet"], repositoryRoot);
  git(["config", "user.email", "sentinel@example.invalid"], repositoryRoot);
  git(["config", "user.name", "Pack Sentinel Test"], repositoryRoot);
  git(["config", "core.autocrlf", "false"], repositoryRoot);
  writeFixtureFile(repositoryRoot, "package.json", "{\"private\":true}\n");
  writeFixtureFile(repositoryRoot, ".gitignore", `${SECRET_PATH}\n`);
  for (const required of REQUIRED_STAGED_PATHS) {
    writeFixtureFile(repositoryRoot, required, `staged ${required}\n`);
  }
  git(["add", "--", "."], repositoryRoot);
  if (trackSecret) {
    writeFixtureFile(repositoryRoot, SECRET_PATH, `MOE_SENTINEL_SECRET=${SECRET_LITERAL}\n`);
    git(["add", "--force", "--", SECRET_PATH], repositoryRoot);
  }
  git(["commit", "--quiet", "-m", "sentinel source"], repositoryRoot);
  const sourceSha = git(["rev-parse", "HEAD"], repositoryRoot);
  const trackedRoster = Object.freeze(
    git(["ls-tree", "-r", "--name-only", "HEAD"], repositoryRoot).split(/\r?\n/u).sort(),
  );
  // Written AFTER the commit so `.gitignore` keeps it untracked: only the
  // inventory can see this file, which is what makes Arm B a divergence arm.
  if (!trackSecret) {
    writeFixtureFile(repositoryRoot, SECRET_PATH, `MOE_SENTINEL_SECRET=${SECRET_LITERAL}\n`);
  }
  return { repositoryRoot, sourceSha, trackedRoster };
}

interface SentinelObservation {
  logLines: string[];
  owners: string[];
  packCalls: number;
  paths: string[];
  publishCalls: number;
  receiptSha: string;
  secretMaterialized: boolean[];
  verdicts: PackInventoryResult[];
}

function observation(): SentinelObservation {
  return {
    logLines: [], owners: [], packCalls: 0, paths: [], publishCalls: 0,
    receiptSha: "", secretMaterialized: [], verdicts: [],
  };
}

type SentinelPack = NonNullable<WindowsPackCommitDependencies["pack"]>;
type SentinelPublish = NonNullable<WindowsPackCommitDependencies["publish"]>;

/**
 * Staging, inventory admission and archive creation stay three separate calls, so
 * a refusal names the layer that produced it. `from: "workspace"` deliberately
 * takes its staging membership from the live tree: an IGNORED file cannot reach
 * `pack-source-integrity.ts`, whose scan is over the `ls-tree` roster, so the
 * inventory is the only mechanism that can refuse it.
 */
function stageAndPublish(
  from: "materialization" | "workspace",
  repositoryRoot: string,
  observed: SentinelObservation,
): SentinelPack {
  return (options) => {
    observed.packCalls += 1;
    expect(options.sourceRoot).not.toBe(repositoryRoot);
    observed.secretMaterialized.push(
      existsSync(join(options.sourceRoot, ...SECRET_PATH.split("/"))),
    );
    const owner = mkdtempSync(join(realpathSync(tmpdir()), "moe-sentinel-owner-"));
    observed.owners.push(owner);
    const staging = join(owner, "staging");
    try {
      if (from === "materialization") cpSync(options.sourceRoot, staging, { recursive: true });
      else {
        cpSync(repositoryRoot, staging, {
          filter: (source) => basename(source) !== ".git", recursive: true,
        });
      }
      const paths = stagedPaths(staging);
      observed.paths.push(...paths);
      const verdict = inspectStagedTree({
        danglingImports: [], devDependencies: [], devDependencyImports: [],
        expectedBridges: [], paths,
      });
      observed.verdicts.push(verdict);
      if (!verdict.ok) {
        for (const refusal of verdict.refusals) options.log(refusal.message);
        return 1;
      }
      publishWindowsArchive({
        log: options.log,
        outputRoot: options.outputRoot,
        ...(windowsPowerShell === undefined ? {} : { powershell: windowsPowerShell }),
        snapshot: snapshotPackTree(staging, paths),
        staging,
        temporaryRoot: owner,
      });
      return 0;
    } finally {
      rmSync(owner, { force: true, recursive: true });
    }
  };
}

function capturePublication(observed: SentinelObservation): SentinelPublish {
  return (candidateRoot, receipt, outputRoot) => {
    observed.publishCalls += 1;
    expect(receipt.size).toBeGreaterThan(0);
    observed.receiptSha = receipt.sha256;
    mkdirSync(join(outputRoot, "dist"), { recursive: true });
    cpSync(join(candidateRoot, "dist", "moe-windows.zip"),
      join(outputRoot, "dist", "moe-windows.zip"));
  };
}

/** Quotes a path for a PowerShell single-quoted literal; `'` is escaped by doubling. */
function powerShellLiteral(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

/** An INDEPENDENT reader: PowerShell we spawn ourselves, not a packaging port. */
function expandArchive(zip: string): string[] {
  const destination = temporaryRoot("moe-sentinel-extract-");
  const run = spawnSync(POWERSHELL, [
    "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; "
    + `Expand-Archive -LiteralPath ${powerShellLiteral(zip)} `
    + `-DestinationPath ${powerShellLiteral(destination)} -Force`,
  ], { encoding: "utf8", shell: false, windowsHide: true });
  if (run.status !== 0) throw new Error(String(run.stderr));
  return stagedPaths(destination);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe.skipIf(process.platform !== "win32")("task-0ed20856 Windows pack sentinel", () => {
  it("ships the tracked roster and never the ignored secret", () => {
    const fixture = createSentinelRepository("moe-sentinel-happy-", false);
    expect(fixture.trackedRoster).toHaveLength(14);
    expect(fixture.trackedRoster).not.toContain(SECRET_PATH);
    const outputRoot = temporaryRoot("moe-sentinel-public-");
    const observed = observation();

    const result = packWindowsFromCommit({
      log: (line) => observed.logLines.push(line),
      outputRoot, repositoryRoot: fixture.repositoryRoot, sourceSha: fixture.sourceSha,
    }, {
      gitExecutable,
      pack: stageAndPublish("materialization", fixture.repositoryRoot, observed),
      publish: capturePublication(observed),
      tarExecutable, tarFlavor,
    });

    expect(result).toBe(0);
    expect(observed.packCalls).toBe(1);
    expect(observed.publishCalls).toBe(1);
    expect(observed.secretMaterialized).toEqual([false]);
    expect(observed.paths).toEqual([...fixture.trackedRoster]);
    expect(observed.paths).not.toContain(SECRET_PATH);

    const zip = join(outputRoot, "dist", "moe-windows.zip");
    const bytes = readFileSync(zip);
    expect(expandArchive(zip)).toEqual([...fixture.trackedRoster]);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(observed.receiptSha);
    expect(bytes.includes(Buffer.from(SECRET_LITERAL, "utf8"))).toBe(false);
    expect(observed.logLines.some((line) => line.includes(SECRET_LITERAL))).toBe(false);
    expect(observed.owners.map((owner) => existsSync(owner))).toEqual([false]);
  }, ARM_TIMEOUT);

  it("refuses an ignored secret at PACKAGING_INVENTORY while the source layer stays silent", () => {
    const fixture = createSentinelRepository("moe-sentinel-inventory-", false);
    expect(fixture.trackedRoster).not.toContain(SECRET_PATH);
    const outputRoot = temporaryRoot("moe-sentinel-refused-");
    const observed = observation();
    let result = -1;

    // NOT `toThrow`: the packaging-source layer cannot see an ignored file, so a
    // throw here would mean some other fence answered first.
    expect(() => {
      result = packWindowsFromCommit({
        log: (line) => observed.logLines.push(line),
        outputRoot, repositoryRoot: fixture.repositoryRoot, sourceSha: fixture.sourceSha,
      }, {
        gitExecutable,
        pack: stageAndPublish("workspace", fixture.repositoryRoot, observed),
        publish: capturePublication(observed),
        tarExecutable, tarFlavor,
      });
    }).not.toThrow();

    expect(observed.packCalls).toBe(1);
    expect(observed.paths).toContain(SECRET_PATH);
    const verdict = observed.verdicts.at(0);
    expect(verdict?.ok).toBe(false);
    const refusals = verdict === undefined || verdict.ok ? [] : verdict.refusals;
    expect(refusals.map((refusal) => ({
      code: refusal.code, detail: refusal.detail, layer: refusal.layer,
    }))).toEqual([{
      code: "PACK_SENSITIVE_PATH_PRESENT",
      detail: "packages/contracts/.env",
      layer: "PACKAGING_INVENTORY",
    }]);
    expect(refusals.at(0)?.message).toBe("PACK_SENSITIVE_PATH_PRESENT: packages/contracts/.env");
    expect(result).toBe(1);
    expect(observed.publishCalls).toBe(0);
    expect(existsSync(join(outputRoot, "dist"))).toBe(false);
    expect(observed.logLines.some((line) => line.includes(SECRET_LITERAL))).toBe(false);
  }, ARM_TIMEOUT);

  it("refuses a TRACKED secret at PACKAGING_SOURCE before the packer runs", () => {
    const fixture = createSentinelRepository("moe-sentinel-tracked-", true);
    expect(fixture.trackedRoster).toContain(SECRET_PATH);
    const outputRoot = temporaryRoot("moe-sentinel-blocked-");
    const observed = observation();

    expect(() => packWindowsFromCommit({
      log: (line) => observed.logLines.push(line),
      outputRoot, repositoryRoot: fixture.repositoryRoot, sourceSha: fixture.sourceSha,
    }, {
      gitExecutable,
      pack: stageAndPublish("materialization", fixture.repositoryRoot, observed),
      publish: capturePublication(observed),
      tarExecutable, tarFlavor,
    })).toThrow(expect.objectContaining({
      code: "PACK_SOURCE_SENSITIVE_PATH", layer: "PACKAGING_SOURCE",
    }));

    expect(observed.packCalls).toBe(0);
    expect(observed.publishCalls).toBe(0);
    expect(readdirSync(outputRoot)).toEqual([]);
    expect(observed.logLines.some((line) => line.includes(SECRET_LITERAL))).toBe(false);
  }, ARM_TIMEOUT);
});
