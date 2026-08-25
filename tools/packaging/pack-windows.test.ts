import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { snapshotPackTree } from "./pack-output.js";
import { captureNativePackTool } from "./pack-command.js";

import {
  invalidateWindowsArtifact,
  publishWindowsArchive,
} from "./pack-windows.js";

const roots: string[] = [];
const windowsPowerShell = process.platform === "win32" ? captureNativePackTool(
  "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
) : undefined;

function archiveRoster(snapshot: ReturnType<typeof snapshotPackTree>) {
  return snapshot.entries.map((entry) => Object.freeze({ ...entry, type: "file" as const }));
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-pack-broker-"));
  roots.push(root);
  return root;
}

function writePhysicalZipEntry(
  archivePath: string,
  entryPath: string,
  contents: string,
  externalAttributes: number,
): void {
  if (windowsPowerShell === undefined) throw new Error("PowerShell unavailable");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.IO.Compression",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip=[System.IO.Compression.ZipFile]::Open($env:MOE_TEST_ZIP_PATH,"
      + "[System.IO.Compression.ZipArchiveMode]::Create)",
    "try { $entry=$zip.CreateEntry($env:MOE_TEST_ZIP_ENTRY); "
      + "$entry.ExternalAttributes=[int]$env:MOE_TEST_ZIP_ATTRIBUTES; "
      + "$bytes=[Convert]::FromBase64String($env:MOE_TEST_ZIP_CONTENTS); "
      + "$stream=$entry.Open(); try { $stream.Write($bytes,0,$bytes.Length) } "
      + "finally { $stream.Dispose() } } finally { $zip.Dispose() }",
  ].join("; ");
  const result = spawnSync(windowsPowerShell.executable.path, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", script,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      MOE_TEST_ZIP_ATTRIBUTES: String(externalAttributes | 0),
      MOE_TEST_ZIP_CONTENTS: Buffer.from(contents, "utf8").toString("base64"),
      MOE_TEST_ZIP_ENTRY: entryPath,
      MOE_TEST_ZIP_PATH: archivePath,
    },
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`physical ZIP fixture failed: ${result.stderr}`);
  }
}

function expectPhysicalMetadataRefusal(externalAttributes: number, nonce: string): void {
  if (windowsPowerShell === undefined) throw new Error("PowerShell unavailable");
  const repoRoot = temporaryRoot();
  const workRoot = temporaryRoot();
  const staging = join(workRoot, "staging");
  const contents = "@echo off\n";
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "moe.cmd"), contents);
  const snapshot = snapshotPackTree(staging);
  expect(snapshot.entries[0]?.mode).toBe(0o666);
  let extracted = false;

  expect(() => publishWindowsArchive({
    createArchive: (_source, archive) => {
      writePhysicalZipEntry(archive, "moe.cmd", contents, externalAttributes);
    },
    extractArchive: () => { extracted = true; },
    log: () => {},
    mintNonce: () => nonce,
    outputRoot: repoRoot,
    powershell: windowsPowerShell,
    snapshot,
    staging,
    temporaryRoot: workRoot,
  })).toThrow(expect.objectContaining({
    code: "PACK_OUTPUT_SNAPSHOT_DRIFT", layer: "PACKAGING_OUTPUT",
  }));
  expect(extracted).toBe(false);
  expect(existsSync(join(repoRoot, "dist", "moe-windows.zip"))).toBe(false);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Windows artifact publication safety", () => {
  it("refuses a prior public zip without deleting or replacing its bytes", () => {
    const repoRoot = temporaryRoot();
    const zip = join(repoRoot, "dist", "moe-windows.zip");
    mkdirSync(dirname(zip), { recursive: true });
    writeFileSync(zip, "stale artifact");

    expect(() => invalidateWindowsArtifact(repoRoot)).toThrow(expect.objectContaining({
      code: "PACK_OUTPUT_PUBLICATION_CONFLICT", layer: "PACKAGING_OUTPUT",
    }));
    expect(readFileSync(zip, "utf8")).toBe("stale artifact");
  });

  it("removes a partial temporary zip when compression fails before publication", () => {
    const repoRoot = temporaryRoot();
    const workRoot = temporaryRoot();
    const staging = join(workRoot, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "moe.cmd"), "@echo off\n");
    const snapshot = snapshotPackTree(staging);

    expect(() => publishWindowsArchive({
      createArchive: (_source, archive) => {
        writeFileSync(archive, "partial zip bytes");
        throw new Error("compressor crashed after writing bytes");
      },
      log: () => {},
      mintNonce: () => "partial-test",
      outputRoot: repoRoot,
      snapshot,
      staging,
      temporaryRoot: workRoot,
    })).toThrow("compressor crashed after writing bytes");

    expect(existsSync(join(repoRoot, "dist", "moe-windows.zip"))).toBe(false);
    expect(readdirSync(join(repoRoot, "dist")).sort()).toEqual([]);
  });

  it("refuses staging mutation after inventory and publishes no public archive", () => {
    const repoRoot = temporaryRoot();
    const workRoot = temporaryRoot();
    const staging = join(workRoot, "staging");
    mkdirSync(join(staging, "apps"), { recursive: true });
    writeFileSync(join(staging, "apps", "daemon.js"), "admitted\n");
    const snapshot = snapshotPackTree(staging);

    expect(() => publishWindowsArchive({
      createArchive: (source, archive) => {
        writeFileSync(join(source, ".env"), "SECRET=1\n");
        writeFileSync(archive, "archive bytes");
      },
      extractArchive: (_archive, destination) => {
        cpSync(staging, destination, { recursive: true });
      },
      inspectArchive: () => archiveRoster(snapshot),
      log: () => {},
      mintNonce: () => "mutation-test",
      outputRoot: repoRoot,
      snapshot,
      staging,
      temporaryRoot: workRoot,
    })).toThrow(expect.objectContaining({
      code: "PACK_OUTPUT_SNAPSHOT_DRIFT", layer: "PACKAGING_OUTPUT",
    }));
    expect(existsSync(join(repoRoot, "dist", "moe-windows.zip"))).toBe(false);
  });

  it("refuses an archive's forged expansion roster before extraction", () => {
    const repoRoot = temporaryRoot();
    const workRoot = temporaryRoot();
    const staging = join(workRoot, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "moe.cmd"), "@echo off\n");
    const snapshot = snapshotPackTree(staging);
    let extracted = false;

    expect(() => publishWindowsArchive({
      createArchive: (_source, archive) => { writeFileSync(archive, "small archive"); },
      extractArchive: () => { extracted = true; },
      inspectArchive: () => [{
        mode: 0o666, path: "moe.cmd", size: Number.MAX_SAFE_INTEGER, type: "file",
      }],
      log: () => {},
      mintNonce: () => "zip-bomb-test",
      outputRoot: repoRoot,
      snapshot,
      staging,
      temporaryRoot: workRoot,
    })).toThrow(expect.objectContaining({ code: "PACK_OUTPUT_SNAPSHOT_DRIFT" }));

    expect(extracted).toBe(false);
    expect(existsSync(join(repoRoot, "dist", "moe-windows.zip"))).toBe(false);
  });

  it("refuses a symlink or reparse archive entry before extraction", () => {
    const repoRoot = temporaryRoot();
    const workRoot = temporaryRoot();
    const staging = join(workRoot, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "moe.cmd"), "@echo off\n");
    const snapshot = snapshotPackTree(staging);
    let extracted = false;

    expect(() => publishWindowsArchive({
      createArchive: (_source, archive) => { writeFileSync(archive, "small archive"); },
      extractArchive: () => { extracted = true; },
      inspectArchive: () => snapshot.entries.map((entry) => ({
        ...entry, type: "unsupported" as const,
      })),
      log: () => {},
      mintNonce: () => "entry-type-test",
      outputRoot: repoRoot,
      snapshot,
      staging,
      temporaryRoot: workRoot,
    })).toThrow(expect.objectContaining({ code: "PACK_OUTPUT_SNAPSHOT_DRIFT" }));

    expect(extracted).toBe(false);
    expect(existsSync(join(repoRoot, "dist", "moe-windows.zip"))).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "physically refuses an explicit Unix zero-mode entry before extraction",
    () => {
      expectPhysicalMetadataRefusal(0x8000 << 16, "physical-zero-mode-test");
    },
  );

  it.runIf(process.platform === "win32")(
    "physically refuses a Unix symlink entry before extraction",
    () => {
      expectPhysicalMetadataRefusal(
        (0xa000 | 0o666) << 16,
        "physical-symlink-test",
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "physically refuses a DOS reparse entry before extraction",
    () => {
      expectPhysicalMetadataRefusal(
        ((0x8000 | 0o666) << 16) | 0x400,
        "physical-reparse-test",
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "physically refuses a non-regular Unix entry before extraction",
    () => {
      expectPhysicalMetadataRefusal(
        (0x1000 | 0o666) << 16,
        "physical-non-regular-test",
      );
    },
  );

  it("reopens an archive and publishes only the exact admitted roster and bytes", () => {
    const repoRoot = temporaryRoot();
    const workRoot = temporaryRoot();
    const staging = join(workRoot, "staging");
    mkdirSync(join(staging, "apps"), { recursive: true });
    writeFileSync(join(staging, "apps", "daemon.js"), "admitted\n");
    const snapshot = snapshotPackTree(staging);
    let reopenCount = 0;

    const zip = publishWindowsArchive({
      createArchive: (_source, archive) => { writeFileSync(archive, "archive bytes"); },
      extractArchive: (_archive, destination) => {
        reopenCount += 1;
        cpSync(staging, destination, { recursive: true });
      },
      inspectArchive: () => archiveRoster(snapshot),
      log: () => {},
      mintNonce: () => "positive-test",
      outputRoot: repoRoot,
      snapshot,
      staging,
      temporaryRoot: workRoot,
    });

    expect(zip).toBe(join(repoRoot, "dist", "moe-windows.zip"));
    expect(readFileSync(zip, "utf8")).toBe("archive bytes");
    expect(reopenCount).toBeGreaterThanOrEqual(2);
  });

  it("removes a final archive whose bytes change after the public preflight", () => {
    const repoRoot = temporaryRoot();
    const workRoot = temporaryRoot();
    const staging = join(workRoot, "staging");
    mkdirSync(join(staging, "apps"), { recursive: true });
    writeFileSync(join(staging, "apps", "daemon.js"), "admitted\n");
    const snapshot = snapshotPackTree(staging);
    let reopenCount = 0;

    expect(() => publishWindowsArchive({
      createArchive: (_source, archive) => { writeFileSync(archive, "trusted-archive"); },
      extractArchive: (archive, destination) => {
        reopenCount += 1;
        mkdirSync(join(destination, "apps"), { recursive: true });
        const trusted = readFileSync(archive, "utf8") === "trusted-archive";
        writeFileSync(join(destination, "apps", "daemon.js"),
          trusted ? "admitted\n" : "substituted\n");
        if (reopenCount === 3) writeFileSync(archive, "substituted-archive");
      },
      inspectArchive: () => archiveRoster(snapshot),
      log: () => {},
      mintNonce: () => "substitution-test",
      outputRoot: repoRoot,
      snapshot,
      staging,
      temporaryRoot: workRoot,
    })).toThrow(expect.objectContaining({ code: "PACK_OUTPUT_SNAPSHOT_DRIFT" }));

    expect(reopenCount).toBe(3);
    expect(existsSync(join(repoRoot, "dist", "moe-windows.zip"))).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "physically creates, reopens and verifies the PowerShell archive",
    () => {
      const repoRoot = temporaryRoot();
      const workRoot = temporaryRoot();
      const staging = join(workRoot, "staging");
      mkdirSync(join(staging, "apps"), { recursive: true });
      writeFileSync(join(staging, "LICENSE"), "license\n");
      writeFileSync(join(staging, "apps", "daemon.js"), "physical archive\n");
      const snapshot = snapshotPackTree(staging);

      const zip = publishWindowsArchive({
        log: () => {},
        mintNonce: () => "physical-test",
        outputRoot: repoRoot,
        powershell: captureNativePackTool(
          "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ),
        snapshot,
        staging,
        temporaryRoot: workRoot,
      });

      expect(existsSync(zip)).toBe(true);
      expect(readFileSync(zip).byteLength).toBeGreaterThan(0);
    },
  );

});
