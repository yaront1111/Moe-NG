import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureNativePackTool, capturePackFileIdentity,
} from "./pack-command.js";
import {
  leaseEntriesForFiles, leaseEntriesForTool, mergeWindowsLeaseEntries,
  runWindowsLeasedProcess, WINDOWS_PROCESS_LEASE_SCHEMA,
} from "./pack-windows-process-lease.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe.runIf(process.platform === "win32")("Windows process lease", () => {
  it("holds exact input and executable handles for the complete child job", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-process-lease-"));
    roots.push(root);
    const input = join(root, "input.txt");
    const output = join(root, "output.txt");
    writeFileSync(input, "admitted\n");
    const node = captureNativePackTool("node", process.execPath);
    const powershell = captureNativePackTool(
      "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );

    const result = runWindowsLeasedProcess(powershell, Object.freeze({
      args: Object.freeze([
        "-e", "require('node:fs').writeFileSync(process.argv[2],require('node:fs').readFileSync(process.argv[1]))",
        input, output,
      ]),
      cwd: root,
      executable: process.execPath,
      locks: mergeWindowsLeaseEntries(
        leaseEntriesForTool(node), leaseEntriesForFiles([capturePackFileIdentity(input)]),
      ),
      schemaVersion: WINDOWS_PROCESS_LEASE_SCHEMA,
      timeoutMs: 30_000,
    }), process.env);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("admitted\n");
  });

  it("reports a legitimate child exit 125 instead of calling it a helper refusal", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-process-lease-child-125-"));
    roots.push(root);
    const input = join(root, "input.txt");
    writeFileSync(input, "admitted\n");
    const node = captureNativePackTool("node", process.execPath);
    const powershell = captureNativePackTool(
      "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );

    const result = runWindowsLeasedProcess(powershell, Object.freeze({
      args: Object.freeze(["-e", "process.exit(125)"]), cwd: root,
      executable: process.execPath,
      locks: mergeWindowsLeaseEntries(
        leaseEntriesForTool(node), leaseEntriesForFiles([capturePackFileIdentity(input)]),
      ),
      schemaVersion: WINDOWS_PROCESS_LEASE_SCHEMA,
      timeoutMs: 30_000,
    }), process.env);

    expect(result.error).toBeUndefined();
    expect(result.kind).toBe("child-exit");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(125);
  });

  it("returns a candidate digest observed by the helper after the child job drains", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-process-lease-observation-"));
    roots.push(root);
    const marker = join(root, ".moe-windows-candidate-owner");
    const control = join(root, ".moe-pack-toolchain-control.json");
    const dist = join(root, "dist");
    const archive = join(dist, "moe-windows.zip");
    writeFileSync(marker, "owner-token");
    writeFileSync(control, "control");
    const node = captureNativePackTool("node", process.execPath);
    const powershell = captureNativePackTool(
      "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );

    const result = runWindowsLeasedProcess(powershell, Object.freeze({
      args: Object.freeze(["-e", [
        "const fs=require('node:fs')", "const path=require('node:path')",
        "fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true})",
        "fs.writeFileSync(process.argv[1],'candidate-bytes\\n')",
      ].join(";") , archive]),
      cwd: root,
      executable: process.execPath,
      locks: mergeWindowsLeaseEntries(
        leaseEntriesForTool(node), leaseEntriesForFiles([
          capturePackFileIdentity(control), capturePackFileIdentity(marker),
        ]),
      ),
      observation: Object.freeze({ archive, control, dist, marker, maxBytes: 1024 * 1024, root }),
      schemaVersion: WINDOWS_PROCESS_LEASE_SCHEMA,
      timeoutMs: 30_000,
    }), process.env);

    expect(result.kind).toBe("child-exit");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.observation).toEqual({
      sha256: "128312f0000cc73eb1a094f93c10956794a89320741a1e43b9a6332b38c9fccb",
      size: 16,
    });
    expect(readFileSync(archive, "utf8")).toBe("candidate-bytes\n");
  });

  it("blocks overwrite, replacement, and ancestor rename for leased input", () => {
    const parent = mkdtempSync(join(tmpdir(), "moe-process-lease-mutations-"));
    roots.push(parent);
    const root = join(parent, "source");
    const moved = join(parent, "moved-source");
    const input = join(root, "input.txt");
    const replacement = join(root, "replacement.txt");
    mkdirSync(root);
    writeFileSync(input, "admitted\n");
    writeFileSync(replacement, "attacker\n");
    const node = captureNativePackTool("node", process.execPath);
    const powershell = captureNativePackTool(
      "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    const script = [
      "const fs=require('node:fs')", "let admitted=0",
      "try{fs.writeFileSync(process.argv[1],'attacker\\n')}catch{admitted++}",
      "try{fs.renameSync(process.argv[2],process.argv[1])}catch{admitted++}",
      "try{fs.renameSync(process.argv[3],process.argv[4])}catch{admitted++}",
      "process.exit(admitted===3?0:77)",
    ].join(";");

    const result = runWindowsLeasedProcess(powershell, Object.freeze({
      args: Object.freeze(["-e", script, input, replacement, root, moved]), cwd: root,
      executable: process.execPath,
      locks: mergeWindowsLeaseEntries(
        leaseEntriesForTool(node), leaseEntriesForFiles([capturePackFileIdentity(input)]),
      ),
      schemaVersion: WINDOWS_PROCESS_LEASE_SCHEMA,
      timeoutMs: 30_000,
    }), process.env);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(readFileSync(input, "utf8")).toBe("admitted\n");
    expect(readFileSync(replacement, "utf8")).toBe("attacker\n");
    expect(existsSync(moved)).toBe(false);
  });

  it("kills detached descendants before releasing leased handles", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe-process-lease-descendant-"));
    roots.push(root);
    const input = join(root, "input.txt");
    const escaped = join(root, "escaped.txt");
    writeFileSync(input, "admitted\n");
    const node = captureNativePackTool("node", process.execPath);
    const powershell = captureNativePackTool(
      "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    const script = [
      "const cp=require('node:child_process')",
      "const child=cp.spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'escaped'),750)\",process.argv[1]],{detached:true,stdio:'ignore'})",
      "child.unref()",
    ].join(";");

    const result = runWindowsLeasedProcess(powershell, Object.freeze({
      args: Object.freeze(["-e", script, escaped]), cwd: root,
      executable: process.execPath,
      locks: mergeWindowsLeaseEntries(
        leaseEntriesForTool(node), leaseEntriesForFiles([capturePackFileIdentity(input)]),
      ),
      schemaVersion: WINDOWS_PROCESS_LEASE_SCHEMA,
      timeoutMs: 30_000,
    }), process.env);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(existsSync(escaped)).toBe(false);
  });

  it("refuses when another process already has a tracked file open for writing", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe-process-lease-conflict-"));
    roots.push(root);
    const input = join(root, "input.txt");
    writeFileSync(input, "admitted\n");
    const node = captureNativePackTool("node", process.execPath);
    const powershell = captureNativePackTool(
      "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    const powershellPath = powershell.executable.path;
    const holder = spawn(powershellPath, ["-NoProfile", "-NonInteractive", "-Command",
      "$f=New-Object IO.FileStream($env:MOE_HOLDER_PATH,[IO.FileMode]::Open,"
      + "[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read);"
      + "[Console]::Out.WriteLine('READY');[Console]::Out.Flush();"
      + "[Console]::In.ReadLine() | Out-Null;$f.Dispose()",
    ], {
      env: { ...process.env, MOE_HOLDER_PATH: input },
      shell: false, stdio: "pipe", windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", () => resolve());
      holder.once("exit", (code) => reject(new Error(
        `writer exited ${String(code)}: ${String(holder.stderr.read() ?? "")}`,
      )));
    });
    try {
      const result = runWindowsLeasedProcess(powershell, Object.freeze({
        args: Object.freeze(["-e", "process.exit(0)"]), cwd: root,
        executable: process.execPath,
        locks: mergeWindowsLeaseEntries(
          leaseEntriesForTool(node), leaseEntriesForFiles([capturePackFileIdentity(input)]),
        ),
        schemaVersion: WINDOWS_PROCESS_LEASE_SCHEMA,
        timeoutMs: 30_000,
      }), process.env);
      expect(result.kind).toBe("helper-refusal");
      expect(result.status).toBeNull();
      expect(result.stderr).toContain("PACK_WINDOWS_LEASE_FAILED");
    } finally {
      holder.stdin.end("release\n");
      if (holder.exitCode === null) {
        await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
      }
    }
  }, 20_000);
});
