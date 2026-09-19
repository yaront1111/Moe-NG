import { execFile, execFileSync } from "node:child_process";
import { win32 } from "node:path";

/**
 * The pid of the Windows Job broker that owns this runtime's Job, or null when it cannot be
 * named (addendum 2026-09-16). The stack is `moe start` -> moe-windows-job-broker.exe -> stack
 * host -> this wrapper, so the broker is the wrapper's grandparent; its Job holds the stack host,
 * the wrapper, every seat and every verifier. It is accepted only when that process really runs
 * the broker image: a wrapper started any other way (a checkout, a test) names no broker, and no
 * later controller infers anything from a runtime it cannot name.
 */
export const RUNTIME_BROKER_IMAGE = "moe-windows-job-broker.exe";

export type RuntimeCommand = (file: string, args: readonly string[]) => Promise<string>;

/** The last `pid|image path` line, when that image is the broker; anything else is null. */
export function parseRuntimeBroker(output: string): number | null {
  const line = output.trim().split(/\r?\n/u).at(-1)?.trim() ?? "";
  const match = /^(\d{1,10})\|(.+)$/u.exec(line);
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return win32.basename(match[2]!).toLowerCase() === RUNTIME_BROKER_IMAGE ? pid : null;
}

function powershell(): string {
  return win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const runPowerShell: RuntimeCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], {
    encoding: "utf8", timeout: 30_000, windowsHide: true,
    env: Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP"]
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
  }, (error, stdout) => { if (error === null) resolve(stdout); else reject(error); });
});

export type ImageListCommand = (file: string, args: readonly string[]) => string;

const runTasklist: ImageListCommand = (file, args) => execFileSync(file, [...args], {
  encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
});

/**
 * Whether the process at `pid` still runs the broker image; null when the OS could not say.
 * `tasklist` and not the CIM query above: this is asked synchronously, once per pass, only while
 * a hold is BLOCKED, and a PowerShell start costs seconds. A pid that names no task, or another
 * image, is NOT the broker: Windows gave the dead broker's pid to something else (UnAI
 * 2026-09-19, pid 42564 became the next runtime's launcher).
 */
export function brokerImageAt(pid: number, run: ImageListCommand = runTasklist,
  platform: NodeJS.Platform = process.platform): boolean | null {
  if (platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const file = win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tasklist.exe");
    const rows = run(file, ["/FI", `PID eq ${String(pid)}`, "/FO", "CSV", "/NH"]).split(/\r?\n/u)
      .map((line) => /^"([^"]+)","(\d+)"/u.exec(line.trim())).filter((row) => row !== null && Number(row[2]) === pid);
    return rows.some((row) => row![1]!.toLowerCase() === RUNTIME_BROKER_IMAGE);
  } catch { return null; }
}

export async function resolveRuntimeBrokerPid(parentPid: number, run: RuntimeCommand = runPowerShell,
  platform: NodeJS.Platform = process.platform): Promise<number | null> {
  if (platform !== "win32" || !Number.isSafeInteger(parentPid) || parentPid <= 0) return null;
  const script = `$stackHost=Get-CimInstance Win32_Process -Filter "ProcessId=${String(parentPid)}"; `
    + "if($stackHost){$broker=Get-CimInstance Win32_Process -Filter \"ProcessId=$($stackHost.ParentProcessId)\"; "
    + "if($broker){[Console]::Out.WriteLine(\"$($broker.ProcessId)|$($broker.ExecutablePath)\")}}";
  try {
    return parseRuntimeBroker(await run(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]));
  } catch { return null; }
}
