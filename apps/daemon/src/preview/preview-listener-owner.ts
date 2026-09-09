import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { win32 } from "node:path";

const pidOf = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** Every observed listener must belong to the live child tree. Unknown ancestry refuses. */
export function listenerPidsOwned(root: number, listeners: readonly number[], parents: ReadonlyMap<number, number>): boolean {
  if (!pidOf(root) || listeners.length === 0 || !parents.has(root)) return false;
  return listeners.every(listener => {
    const seen = new Set<number>(); let pid = listener;
    while (pidOf(pid) && !seen.has(pid)) {
      if (pid === root) return true;
      seen.add(pid); pid = parents.get(pid) ?? 0;
    }
    return false;
  });
}

function command(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, [...args], {
    shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8",
  }, (error, stdout) => error === null ? resolve(stdout) : reject(error)));
}

async function windowsOwns(root: number, port: number, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const systemRoot = Object.entries(environment).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) return false;
  // Fixed script, with only a validated integer interpolated. No process command lines or environment values are read.
  const script = `$ErrorActionPreference='Stop';$listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess);$parents=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId);@{listeners=$listeners;parents=$parents}|ConvertTo-Json -Compress -Depth 3`;
  const parsed: unknown = JSON.parse(await command(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script]));
  if (typeof parsed !== "object" || parsed === null) return false;
  const data = parsed as { listeners?: unknown; parents?: unknown };
  if (!Array.isArray(data.listeners) || !data.listeners.every(pidOf) || !Array.isArray(data.parents)) return false;
  const parents = new Map<number, number>();
  for (const row of data.parents) {
    if (typeof row !== "object" || row === null) return false;
    const { ProcessId: pid, ParentProcessId: parent } = row as Record<string, unknown>;
    if (pidOf(pid) && typeof parent === "number") parents.set(pid, parent);
  }
  return listenerPidsOwned(root, data.listeners, parents);
}

async function linuxOwns(root: number, port: number): Promise<boolean> {
  const inodes = new Set<string>();
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let content: string;
    try { content = await readFile(path, "utf8"); } catch { if (path.endsWith("6")) continue; throw new Error("LISTENER_UNKNOWN"); }
    for (const line of content.trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields[3] === "0A" && Number.parseInt(fields[1]?.split(":")[1] ?? "", 16) === port && fields[9]) inodes.add(fields[9]);
    }
  }
  if (inodes.size === 0) return false;
  const parents = new Map<number, number>();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(entry), Number(fields[1]));
    } catch { /* Exited processes provide no ownership. */ }
  }
  const covered = new Set<string>();
  for (const pid of parents.keys()) {
    if (!listenerPidsOwned(root, [pid], parents)) continue;
    try {
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        try {
          const match = /^socket:\[(\d+)\]$/u.exec(await readlink(`/proc/${pid}/fd/${fd}`));
          if (match?.[1] !== undefined && inodes.has(match[1])) covered.add(match[1]);
        } catch { /* Closing descriptors provide no ownership. */ }
      }
    } catch { /* Unknown descriptor tables provide no ownership. */ }
  }
  return covered.size === inodes.size;
}

async function macOwns(root: number, port: number): Promise<boolean> {
  const [listening, processRows] = await Promise.all([
    command("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "p"]),
    command("/bin/ps", ["-axo", "pid=,ppid="]),
  ]);
  const listeners = listening.split("\n").filter(line => /^p\d+$/u.test(line)).map(line => Number(line.slice(1)));
  const parents = new Map<number, number>();
  for (const line of processRows.split("\n")) {
    const pair = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (pair !== null) parents.set(Number(pair[1]), Number(pair[2]));
  }
  return listenerPidsOwned(root, listeners, parents);
}

/** OS observations, never output text from the product. A failed inventory stays unready. */
export async function previewOwnsListener(root: number, port: number, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): Promise<boolean> {
  if (!pidOf(root) || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    if (platform === "win32") return await windowsOwns(root, port, environment);
    if (platform === "linux") return await linuxOwns(root, port);
    if (platform === "darwin") return await macOwns(root, port);
    return false;
  } catch { return false; }
}
