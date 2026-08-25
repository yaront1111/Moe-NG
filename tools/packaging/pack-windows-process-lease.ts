import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";

import {
  assertPackToolIdentity, type PackFileIdentity, type PackToolLaunch,
} from "./pack-tool-identity.js";
import {
  WINDOWS_PROCESS_LEASE_COMMAND, WINDOWS_PROCESS_LEASE_CSHARP,
} from "./pack-windows-process-lease-source.js";

export const WINDOWS_PROCESS_LEASE_SCHEMA = "moe-windows-process-lease/2" as const;
const MAX_LEASE_ENTRIES = 30_000;

export interface WindowsLeaseEntry {
  readonly dev: string;
  readonly ino: string;
  readonly kind: "directory" | "file";
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface WindowsProcessLeaseRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly executable: string;
  readonly locks: readonly WindowsLeaseEntry[];
  readonly observation?: WindowsProcessLeaseObservationRequest;
  readonly schemaVersion: typeof WINDOWS_PROCESS_LEASE_SCHEMA;
  readonly timeoutMs: number;
}

export interface WindowsProcessLeaseObservationRequest {
  readonly archive: string;
  readonly control: string;
  readonly dist: string;
  readonly marker: string;
  readonly maxBytes: number;
  readonly root: string;
}

export interface WindowsProcessLeaseObservation {
  readonly sha256: string;
  readonly size: number;
}

export interface WindowsLeasedProcessResult {
  readonly error?: unknown;
  readonly kind: "child-exit" | "helper-refusal";
  readonly observation?: WindowsProcessLeaseObservation;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const CONTROL_SCHEMA = "moe-windows-process-lease/2";

function decodeControlReceipt(
  stdout: string, outerStatus: number | null, controlToken: string, expectsObservation: boolean,
): Readonly<{
  kind: "child-exit" | "helper-refusal";
  observation?: WindowsProcessLeaseObservation;
  status: number | null;
  stdout: string;
}> {
  if (outerStatus !== 0) {
    return Object.freeze({ kind: "helper-refusal", status: null, stdout });
  }
  const marker = `\u001e${CONTROL_SCHEMA}:${controlToken}:`;
  const markerOffset = stdout.lastIndexOf(marker);
  if (markerOffset < 0 || stdout.indexOf(marker) !== markerOffset) {
    return Object.freeze({ kind: "helper-refusal", status: null, stdout });
  }
  const receipt = stdout.slice(markerOffset + marker.length);
  const match = /^([0-9]{1,10}):(-|[0-9]{1,10}):(-|[0-9a-f]{64})\r?\n?$/u.exec(receipt);
  if (match === null) {
    return Object.freeze({ kind: "helper-refusal", status: null, stdout });
  }
  const status = Number(match[1]);
  if (!Number.isSafeInteger(status) || status < 0 || status > 0xffff_ffff) {
    return Object.freeze({ kind: "helper-refusal", status: null, stdout });
  }
  const hasObservation = match[2] !== "-" && match[3] !== "-";
  if ((match[2] === "-") !== (match[3] === "-")
    || (expectsObservation && status === 0) !== hasObservation
    || (!expectsObservation && hasObservation)) {
    return Object.freeze({ kind: "helper-refusal", status: null, stdout });
  }
  let observation: WindowsProcessLeaseObservation | undefined;
  if (hasObservation) {
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 1) {
      return Object.freeze({ kind: "helper-refusal", status: null, stdout });
    }
    observation = Object.freeze({ sha256: match[3]!, size });
  }
  return Object.freeze({
    kind: "child-exit", ...(observation === undefined ? {} : { observation }),
    status, stdout: stdout.slice(0, markerOffset),
  });
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function directoryEntry(rawPath: string): WindowsLeaseEntry {
  try {
    const path = resolve(rawPath);
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(path), path)) {
      throw new Error();
    }
    return Object.freeze({
      dev: stat.dev.toString(), ino: stat.ino.toString(), kind: "directory",
      path, sha256: "", size: 0,
    });
  } catch {
    throw new Error("PACK_WINDOWS_LEASE_FAILED");
  }
}

export function captureWindowsLeaseDirectory(path: string): WindowsLeaseEntry {
  return directoryEntry(path);
}

function fileEntry(identity: PackFileIdentity): WindowsLeaseEntry {
  return Object.freeze({
    dev: identity.dev, ino: identity.ino, kind: "file", path: identity.path,
    sha256: identity.sha256, size: identity.size,
  });
}

function addEntry(
  entries: Map<string, WindowsLeaseEntry>, entry: WindowsLeaseEntry,
): void {
  const key = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
  const prior = entries.get(key);
  if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(entry)) {
    throw new Error("PACK_WINDOWS_LEASE_FAILED");
  }
  entries.set(key, entry);
  if (entries.size > MAX_LEASE_ENTRIES) throw new Error("PACK_WINDOWS_LEASE_FAILED");
}

function addAncestors(entries: Map<string, WindowsLeaseEntry>, rawPath: string): void {
  let directory = dirname(rawPath);
  const root = parse(directory).root;
  for (;;) {
    addEntry(entries, directoryEntry(directory));
    if (samePath(directory, root)) break;
    const parent = dirname(directory);
    if (samePath(parent, directory)) throw new Error("PACK_WINDOWS_LEASE_FAILED");
    directory = parent;
  }
}

export function leaseDirectoryAncestors(rawPath: string): readonly WindowsLeaseEntry[] {
  const entries = new Map<string, WindowsLeaseEntry>();
  addAncestors(entries, rawPath);
  return Object.freeze([...entries.values()]);
}

export function leaseEntriesForTool(tool: PackToolLaunch): readonly WindowsLeaseEntry[] {
  const entries = new Map<string, WindowsLeaseEntry>();
  const files = [tool.executable, ...tool.witnesses];
  for (const identity of files) {
    addEntry(entries, fileEntry(identity));
    addAncestors(entries, identity.path);
  }
  if (tool.tree !== undefined) {
    for (const entry of tool.tree.entries) {
      const path = entry.path === "." ? tool.tree.root
        : resolve(tool.tree.root, ...entry.path.split("/"));
      addEntry(entries, entry.kind === "file" ? Object.freeze({
        dev: entry.dev, ino: entry.ino, kind: "file", path,
        sha256: entry.sha256, size: entry.size,
      }) : directoryEntry(path));
    }
    addAncestors(entries, tool.tree.root);
  }
  return Object.freeze([...entries.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function leaseEntriesForFiles(
  identities: readonly PackFileIdentity[],
): readonly WindowsLeaseEntry[] {
  const entries = new Map<string, WindowsLeaseEntry>();
  for (const identity of identities) {
    addEntry(entries, fileEntry(identity));
    addAncestors(entries, identity.path);
  }
  return Object.freeze([...entries.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function mergeWindowsLeaseEntries(
  ...groups: readonly (readonly WindowsLeaseEntry[])[]
): readonly WindowsLeaseEntry[] {
  const entries = new Map<string, WindowsLeaseEntry>();
  for (const group of groups) for (const entry of group) addEntry(entries, entry);
  return Object.freeze([...entries.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function runWindowsLeasedProcess(
  powershell: PackToolLaunch,
  request: WindowsProcessLeaseRequest,
  environment: NodeJS.ProcessEnv,
): WindowsLeasedProcessResult {
  if (process.platform !== "win32" || powershell.kind !== "powershell"
    || request.schemaVersion !== WINDOWS_PROCESS_LEASE_SCHEMA
    || !isAbsolute(request.executable) || !isAbsolute(request.cwd)
    || request.locks.length === 0 || request.locks.length > MAX_LEASE_ENTRIES
    || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1
    || request.timeoutMs > 30 * 60 * 1000) throw new Error("PACK_WINDOWS_LEASE_FAILED");
  assertPackToolIdentity(powershell);
  const requestText = JSON.stringify({ ...request, observation: request.observation ?? null });
  const digest = createHash("sha256").update(requestText, "utf8").digest("hex");
  const controlToken = randomBytes(32).toString("hex");
  const input = JSON.stringify({
    controlToken, digest, request: requestText, source: WINDOWS_PROCESS_LEASE_CSHARP,
  });
  const result = spawnSync(powershell.executable.path, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", WINDOWS_PROCESS_LEASE_COMMAND,
  ], {
    cwd: request.cwd,
    encoding: "utf8",
    env: environment,
    input,
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    stdio: "pipe",
    timeout: request.timeoutMs + 120_000,
    windowsHide: true,
  });
  assertPackToolIdentity(powershell);
  const decoded = decodeControlReceipt(
    result.stdout ?? "", result.status, controlToken, request.observation !== undefined,
  );
  return Object.freeze({
    ...(result.error === undefined ? {} : { error: result.error }),
    kind: decoded.kind, ...(decoded.observation === undefined
      ? {} : { observation: decoded.observation }), status: decoded.status,
    stderr: result.stderr ?? "", stdout: decoded.stdout,
  });
}
