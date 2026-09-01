import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureNativePackTool } from "./pack-command.js";
import {
  createPrivateWindowsCandidate, observePrivateWindowsCandidate,
  publishPrivateWindowsCandidate, removePrivateWindowsCandidate,
} from "./pack-windows-candidate.js";
import { WINDOWS_PUBLICATION_CSHARP } from "./pack-windows-publication-source.js";

const roots: string[] = [];
const powershell = process.platform === "win32" ? captureNativePackTool(
  "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
) : undefined;

const HOLD_DIRECTORY_WRITER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MoeDirectoryWriter {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Open(string path) {
    return CreateFileW(path, 0x40000000, 0x7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
  }
  public static void Close(IntPtr handle) { CloseHandle(handle); }
}
'@
$handle = [MoeDirectoryWriter]::Open($env:MOE_TEST_DIRECTORY)
if ($handle -eq [IntPtr](-1)) {
  [Console]::Error.WriteLine([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 2
}
[IO.File]::WriteAllText($env:MOE_TEST_READY, 'ready')
[Console]::In.ReadLine() | Out-Null
[MoeDirectoryWriter]::Close($handle)
`;

const BARRIER_PUBLISHER = String.raw`
import { existsSync, writeFileSync } from "node:fs";

const request = JSON.parse(process.env.MOE_TEST_PUBLISH_REQUEST);
const { captureNativePackTool } = await import(process.env.MOE_TEST_PACK_COMMAND_MODULE);
const { publishPrivateWindowsCandidate } = await import(process.env.MOE_TEST_CANDIDATE_MODULE);
const powershell = captureNativePackTool("powershell", request.powershell);
writeFileSync(process.env.MOE_TEST_READY, "ready", { flag: "wx" });
while (!existsSync(process.env.MOE_TEST_RELEASE)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
try {
  const path = publishPrivateWindowsCandidate(
    request.candidate, request.expected, request.outputRoot, powershell, process.env,
  );
  process.stdout.write(JSON.stringify({ kind: "published", path, publisher: request.publisher }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    code: error && typeof error === "object" && "code" in error ? error.code : null,
    kind: "refused",
    layer: error && typeof error === "object" && "layer" in error ? error.layer : null,
    publisher: request.publisher,
  }));
}
`;

const HOLD_CANDIDATE_READER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MoeCandidateReader {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Open(string path) {
    return CreateFileW(path, 0x80000000, 0x7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
  }
  public static void Close(IntPtr handle) { CloseHandle(handle); }
}
'@
$handle = [MoeCandidateReader]::Open($env:MOE_TEST_ARCHIVE)
if ($handle -eq [IntPtr](-1)) {
  [Console]::Error.WriteLine([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 2
}
[IO.File]::WriteAllText($env:MOE_TEST_READY, 'ready')
Start-Sleep -Milliseconds 3000
[MoeCandidateReader]::Close($handle)
`;

interface PublisherReceipt {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

type PublisherOutcome = Readonly<
  | { readonly kind: "published"; readonly path: string; readonly publisher: string }
  | {
    readonly code: unknown;
    readonly kind: "refused";
    readonly layer: unknown;
    readonly publisher: string;
  }
>;

function startBarrierPublisher(
  publisher: string,
  candidate: ReturnType<typeof createPrivateWindowsCandidate>,
  expected: ReturnType<typeof observePrivateWindowsCandidate>,
  outputRoot: string,
  ready: string,
  release: string,
) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", BARRIER_PUBLISHER], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOE_TEST_CANDIDATE_MODULE: new URL("./pack-windows-candidate.js", import.meta.url).href,
      MOE_TEST_PACK_COMMAND_MODULE: new URL("./pack-command.js", import.meta.url).href,
      MOE_TEST_PUBLISH_REQUEST: JSON.stringify({
        candidate, expected, outputRoot, powershell: powershell!.executable.path, publisher,
      }),
      MOE_TEST_READY: ready,
      MOE_TEST_RELEASE: release,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const completed = new Promise<PublisherReceipt>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => { resolve({ status, stderr, stdout }); });
  });
  return Object.freeze({ child, completed });
}

async function waitForPath(path: string, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe.runIf(process.platform === "win32")("private Windows candidate publication", () => {
  it("seals the empty output namespace before relaxing write sharing", () => {
    const strictOpen = "outputDist = OpenDirectory(request.outputDistIdentity, false, false);";
    const guardCreate = "temporary = CreateTemporary(temporaryPath);";
    const relaxedOpen = "outputDist = OpenDirectory(request.outputDistIdentity, false, true);";
    expect(WINDOWS_PUBLICATION_CSHARP.indexOf(strictOpen)).toBeGreaterThan(0);
    expect(WINDOWS_PUBLICATION_CSHARP.indexOf(guardCreate))
      .toBeGreaterThan(WINDOWS_PUBLICATION_CSHARP.indexOf(strictOpen));
    expect(WINDOWS_PUBLICATION_CSHARP.indexOf(relaxedOpen))
      .toBeGreaterThan(WINDOWS_PUBLICATION_CSHARP.indexOf(guardCreate));
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("VerifyPublished(finalPath, temporary");
    expect(WINDOWS_PUBLICATION_CSHARP)
      .toContain("RenameNoReplace(temporary, IntPtr.Zero, finalPath);");
    expect(WINDOWS_PUBLICATION_CSHARP)
      .toContain("int bufferSize = nameOffset + 4 + name.Length;");
    expect(WINDOWS_PUBLICATION_CSHARP).not.toContain("Environment.Exit(0)");
    expect(WINDOWS_PUBLICATION_CSHARP)
      .toContain("[MarshalAs(UnmanagedType.U1)] public bool DeleteFile;");
    expect(WINDOWS_PUBLICATION_CSHARP)
      .not.toContain("[MarshalAs(UnmanagedType.Bool)] public bool DeleteFile;");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("const int FILE_DISPOSITION_INFO_EX_CLASS = 21;");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("public uint Flags;");
    expect(WINDOWS_PUBLICATION_CSHARP)
      .toContain("DISPOSITION_DELETE | DISPOSITION_POSIX_SEMANTICS");
    expect(WINDOWS_PUBLICATION_CSHARP)
      .toContain("if (TryDeletePosix(handle, out extendedError)) return;");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("const int DELETE_ATTEMPTS = 400;");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("error.NativeErrorCode != ERROR_DIR_NOT_EMPTY");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("DeleteDirectoryOnClose(candidateDist)");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("DeleteDirectoryOnClose(candidateRoot)");
    expect(WINDOWS_PUBLICATION_CSHARP)
      .toContain('"MOE_WINDOWS_PUBLICATION_FAILURE|" + stage + "|" + NativeError(error)');
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("const int VERIFY_ATTEMPTS = 100;");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("error == ERROR_FILE_NOT_FOUND");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("error == ERROR_SHARING_VIOLATION");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("error == ERROR_LOCK_VIOLATION");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain("Thread.Sleep(25);");
    expect(WINDOWS_PUBLICATION_CSHARP).toContain('stage = "verify";');
  });

  it("deletes the private candidate before an atomic no-replace commit", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "moe-candidate-publication-"));
    roots.push(outputRoot);
    const candidate = createPrivateWindowsCandidate();
    mkdirSync(join(candidate.root, "dist"));
    writeFileSync(join(candidate.root, "dist", "moe-windows.zip"), "trusted archive\n");
    const expected = observePrivateWindowsCandidate(candidate);

    const published = publishPrivateWindowsCandidate(
      candidate, expected, outputRoot, powershell!, process.env,
    );

    expect(published).toBe(join(outputRoot, "dist", "moe-windows.zip"));
    expect(readFileSync(published, "utf8")).toBe("trusted archive\n");
    expect(existsSync(candidate.root)).toBe(false);
  }, 30_000);

  it("waits for a bounded shared reader before committing", async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "moe-candidate-reader-output-"));
    const barrierRoot = mkdtempSync(join(tmpdir(), "moe-candidate-reader-barrier-"));
    const candidate = createPrivateWindowsCandidate();
    roots.push(outputRoot, barrierRoot, candidate.root);
    mkdirSync(join(candidate.root, "dist"));
    const archive = join(candidate.root, "dist", "moe-windows.zip");
    writeFileSync(archive, "reader-held archive\n");
    const expected = observePrivateWindowsCandidate(candidate);
    const ready = join(barrierRoot, "reader.ready");
    const reader = spawn(powershell!.executable.path, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", HOLD_CANDIDATE_READER,
    ], {
      env: { ...process.env, MOE_TEST_ARCHIVE: archive, MOE_TEST_READY: ready },
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    });
    let readerStderr = "";
    reader.stderr.setEncoding("utf8");
    reader.stderr.on("data", (chunk: string) => { readerStderr += chunk; });
    const exited = new Promise<number | null>((resolve) => reader.once("exit", resolve));

    let published: string;
    try {
      await waitForPath(ready);
      published = publishPrivateWindowsCandidate(
        candidate, expected, outputRoot, powershell!, process.env,
      );
    } finally {
      expect(await exited).toBe(0);
    }
    expect(readerStderr).toBe("");
    expect(readFileSync(published, "utf8")).toBe("reader-held archive\n");
    expect(existsSync(candidate.root)).toBe(false);
  }, 30_000);

  it("never replaces an incumbent public archive", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "moe-candidate-conflict-"));
    roots.push(outputRoot);
    mkdirSync(join(outputRoot, "dist"));
    const incumbent = join(outputRoot, "dist", "moe-windows.zip");
    writeFileSync(incumbent, "incumbent\n");
    const candidate = createPrivateWindowsCandidate();
    mkdirSync(join(candidate.root, "dist"));
    writeFileSync(join(candidate.root, "dist", "moe-windows.zip"), "candidate\n");
    const expected = observePrivateWindowsCandidate(candidate);

    try {
      expect(() => publishPrivateWindowsCandidate(
        candidate, expected, outputRoot, powershell!, process.env,
      )).toThrow(expect.objectContaining({ code: "PACK_OUTPUT_PUBLICATION_CONFLICT" }));
      expect(readFileSync(incumbent, "utf8")).toBe("incumbent\n");
      expect(existsSync(candidate.root)).toBe(true);
    } finally {
      removePrivateWindowsCandidate(candidate);
    }
  });

  it("refuses a candidate replaced after the authenticated observation", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "moe-candidate-substitution-"));
    roots.push(outputRoot);
    const candidate = createPrivateWindowsCandidate();
    const archive = join(candidate.root, "dist", "moe-windows.zip");
    mkdirSync(join(candidate.root, "dist"));
    writeFileSync(archive, "helper-observed\n");
    const expected = observePrivateWindowsCandidate(candidate);
    writeFileSync(archive, "attacker-replacement\n");

    try {
      expect(() => publishPrivateWindowsCandidate(
        candidate, expected, outputRoot, powershell!, process.env,
      )).toThrow(expect.objectContaining({ code: "PACK_OUTPUT_SNAPSHOT_DRIFT" }));
      expect(existsSync(join(outputRoot, "dist", "moe-windows.zip"))).toBe(false);
      expect(existsSync(candidate.root)).toBe(true);
    } finally {
      removePrivateWindowsCandidate(candidate);
    }
  });

  it("allows exactly one barrier-synchronized publisher to commit without torn bytes", async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "moe-candidate-race-output-"));
    const barrierRoot = mkdtempSync(join(tmpdir(), "moe-candidate-race-barrier-"));
    roots.push(outputRoot, barrierRoot);
    const outputDist = join(outputRoot, "dist");
    mkdirSync(outputDist);
    const release = join(barrierRoot, "release");
    const firstReady = join(barrierRoot, "first.ready");
    const secondReady = join(barrierRoot, "second.ready");
    const firstBytes = "first-publisher-archive\n";
    const secondBytes = "SECOND-PUBLISHER-WITH-DIFFERENT-LENGTH\n";
    const firstCandidate = createPrivateWindowsCandidate();
    const secondCandidate = createPrivateWindowsCandidate();
    roots.push(firstCandidate.root, secondCandidate.root);
    mkdirSync(join(firstCandidate.root, "dist"));
    mkdirSync(join(secondCandidate.root, "dist"));
    writeFileSync(join(firstCandidate.root, "dist", "moe-windows.zip"), firstBytes);
    writeFileSync(join(secondCandidate.root, "dist", "moe-windows.zip"), secondBytes);
    const firstExpected = observePrivateWindowsCandidate(firstCandidate);
    const secondExpected = observePrivateWindowsCandidate(secondCandidate);
    const first = startBarrierPublisher(
      "first", firstCandidate, firstExpected, outputRoot, firstReady, release,
    );
    const second = startBarrierPublisher(
      "second", secondCandidate, secondExpected, outputRoot, secondReady, release,
    );
    const publishers = [first, second];

    try {
      await Promise.all([waitForPath(firstReady, 400), waitForPath(secondReady, 400)]);
      expect(readdirSync(outputDist)).toEqual([]);
      writeFileSync(release, "release", { flag: "wx" });
      const receipts = await Promise.all(publishers.map(({ completed }) => completed));
      expect(receipts.map(({ status }) => status)).toEqual([0, 0]);
      expect(receipts.map(({ stderr }) => stderr)).toEqual(["", ""]);
      const outcomes = receipts.map(({ stdout }) => JSON.parse(stdout) as PublisherOutcome);
      expect(outcomes.map(({ publisher }) => publisher).sort()).toEqual(["first", "second"]);
      const published = outcomes.filter((outcome) => outcome.kind === "published");
      const refused = outcomes.filter((outcome) => outcome.kind === "refused");
      expect(published).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ kind: "refused", layer: "PACKAGING_OUTPUT" });
      expect([
        "PACK_OUTPUT_PUBLICATION_CONFLICT", "PACK_OUTPUT_ATOMIC_PUBLICATION_UNAVAILABLE",
      ]).toContain(refused[0]?.code);
      const final = join(outputDist, "moe-windows.zip");
      expect(published[0]?.path).toBe(final);
      const winningBytes = published[0]?.publisher === "first" ? firstBytes
        : published[0]?.publisher === "second" ? secondBytes : undefined;
      expect(winningBytes).not.toBeUndefined();
      expect(readFileSync(final, "utf8")).toBe(winningBytes);
      expect(readdirSync(outputDist).sort()).toEqual(["moe-windows.zip"]);
    } finally {
      if (!existsSync(release)) writeFileSync(release, "release", { flag: "wx" });
      for (const publisher of publishers) {
        if (publisher.child.exitCode === null && publisher.child.signalCode === null) {
          publisher.child.kill();
        }
      }
      await Promise.allSettled(publishers.map(({ completed }) => completed));
    }
  }, 30_000);

  it("refuses publication while another process holds the empty output directory writable", async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "moe-candidate-writer-"));
    roots.push(outputRoot);
    const outputDist = join(outputRoot, "dist");
    mkdirSync(outputDist);
    const ready = join(outputRoot, "writer.ready");
    const holder = spawn(powershell!.executable.path, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", HOLD_DIRECTORY_WRITER,
    ], {
      env: { ...process.env, MOE_TEST_DIRECTORY: outputDist, MOE_TEST_READY: ready },
      stdio: ["pipe", "ignore", "pipe"], windowsHide: true,
    });
    let holderStderr = "";
    holder.stderr.setEncoding("utf8");
    holder.stderr.on("data", (chunk: string) => { holderStderr += chunk; });
    const exited = new Promise<number | null>((resolve) => holder.once("exit", resolve));
    const candidate = createPrivateWindowsCandidate();
    mkdirSync(join(candidate.root, "dist"));
    writeFileSync(join(candidate.root, "dist", "moe-windows.zip"), "candidate\n");
    const expected = observePrivateWindowsCandidate(candidate);
    try {
      await waitForPath(ready);
      let refusal: unknown;
      try {
        publishPrivateWindowsCandidate(candidate, expected, outputRoot, powershell!, process.env);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toEqual(expect.objectContaining({
        cause: expect.objectContaining({
          message: expect.stringMatching(
            /^PACK_WINDOWS_PUBLICATION_FAILED:output-open:WIN32_(?:5|32|33)$/,
          ),
        }),
        code: "PACK_OUTPUT_ATOMIC_PUBLICATION_UNAVAILABLE",
        layer: "PACKAGING_OUTPUT",
      }));
      expect(existsSync(join(outputDist, "moe-windows.zip"))).toBe(false);
      expect(existsSync(candidate.root)).toBe(true);
    } finally {
      holder.stdin.end("done\n");
      const status = await exited;
      if (status !== 0) throw new Error(`directory writer failed (${String(status)}): ${holderStderr}`);
      removePrivateWindowsCandidate(candidate);
    }
  }, 15_000);
});
