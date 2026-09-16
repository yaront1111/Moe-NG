import { execFile } from "node:child_process";
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
