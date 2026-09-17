import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";

/**
 * THE HOST-BOOT WITNESS beside a recorded child pid.
 *
 * A pid identifies a process only within the boot that issued it. The staffing fence records
 * the CHILD's pid and probes it with `kill(pid, 0)` so that a SIGKILLed wrapper's orphan still
 * refuses staffing — and a pid the OS has since handed to a stranger refuses the same way.
 * Within one boot that is bounded by the stranger's life. Across a reboot it is not: the child
 * is certainly gone, nothing retires the row (the recording process's exit handler died with it
 * and the boot reclaim keeps an alive-reading pid), and on Windows the recycled pid routinely
 * lands on a system process alive until the NEXT reboot. The item reads staffed for days with
 * nothing running, and CHILD_LIVE charges no attempt, so nothing escalates either.
 *
 * So the row also carries which boot wrote it, and a reader asks first whether the host has
 * rebooted since. Two witnesses, either suffices, neither consults a clock:
 *
 *   - the BOOT IDENTITY changed: Linux regenerates /proc/sys/kernel/random/boot_id per boot,
 *     and Windows advances the prefetcher's BootId counter per boot session — including a
 *     Shutdown under Fast Startup, which resumes the KERNEL session (the tick count carries on)
 *     while every user process was killed and every pid reissued; the uptime cannot see that.
 *   - the UPTIME went backwards: monotonic within a boot, so a host up for less time than the
 *     row records has booted since. It covers a host that offers no identity.
 *
 * NO WALL-CLOCK ARM. An earlier witness compared the boot instant each side implied (instant
 * minus uptime) against a tolerance. That fails OPEN in the one direction the fence guards: a
 * running Windows host STEPS its clock whenever w32time's offset exceeds its phase limit, and a
 * VM resumed from a pause re-syncs by the whole pause, so the implied instant moves past any
 * tolerance on the SAME boot — and both readers would then admit a second agent beside the
 * orphan the fence exists to catch. Only the clock-free witnesses remain.
 *
 * "Cannot tell" — a row without the facts, a port that throws, an identity the host cannot
 * read — is never a reboot: the caller then falls back to the probe, which fails closed. The
 * residual is same-boot pid reuse, which refuses for the stranger's lifetime, and a host that
 * offers no identity and is up longer than the row records, which the probe decides.
 */

/** Milliseconds this host has been up. Injected so tests never depend on the host. */
export type HostUptimePort = () => number;

/** The identity of the host's current boot session; null where the host offers none. */
export type HostBootIdPort = () => string | null;

export interface HostBootPorts {
  readonly bootId: HostBootIdPort;
  readonly uptimeMs: HostUptimePort;
}

/** What one ADMITTED row says about the boot that wrote it; a fact is null when unmeasurable then. */
export interface RecordedHostBoot {
  readonly hostBootId: string | null;
  readonly hostUptimeMs: number | null;
}

/** The facts a row records: only what could be measured, so a key is present or absent. */
export interface HostBootFacts {
  readonly hostBootId?: string;
  readonly hostUptimeMs?: number;
}

export const hostUptimeNow: HostUptimePort = () => uptime() * 1000;

const LINUX_BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const WINDOWS_BOOT_ID_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager"
  + "\\Memory Management\\PrefetchParameters";
const WINDOWS_BOOT_ID_VALUE = "BootId";
/** The one line of a `reg query ... /v BootId` listing that carries the value. */
const WINDOWS_BOOT_ID_LINE = /^\s*BootId\s+REG_DWORD\s+(0x[0-9a-f]+)\s*$/im;
const WINDOWS_REG_TIMEOUT_MS = 10_000;

/** The BootId a `reg query` listing carries, or null for a listing that carries none. */
export function windowsBootIdOf(listing: string): string | null {
  return WINDOWS_BOOT_ID_LINE.exec(listing)?.[1] ?? null;
}

/**
 * Reads the boot identity this platform keeps. Throws where the platform keeps one and the
 * read fails — "cannot tell", which `measureHostBootId` turns into null — and answers null,
 * without touching the host, on a platform this module does not know.
 */
export function readHostBootId(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "linux") {
    const id = readFileSync(LINUX_BOOT_ID_FILE, "utf8").trim();
    return id.length > 0 ? id : null;
  }
  if (platform === "win32") {
    return windowsBootIdOf(execFileSync(
      "reg", ["query", WINDOWS_BOOT_ID_KEY, "/v", WINDOWS_BOOT_ID_VALUE],
      { encoding: "utf8", timeout: WINDOWS_REG_TIMEOUT_MS, windowsHide: true },
    ));
  }
  return null;
}

let bootIdOfThisProcess: string | null | undefined;

/**
 * The host's boot identity, read ONCE per process: no process outlives its boot session, so
 * the answer cannot change under it, and a registry spawn per admission would be waste. A read
 * that fails is remembered as "none" for the same reason — the uptime witness still stands.
 */
export const hostBootIdNow: HostBootIdPort = () => {
  if (bootIdOfThisProcess === undefined) bootIdOfThisProcess = measureHostBootId(readHostBootId);
  return bootIdOfThisProcess;
};

/** The ports a fence or reclaim config names, each defaulting to the host's own reading. */
export function hostBootPortsOf(
  config: { readonly hostBootId?: HostBootIdPort; readonly hostUptimeMs?: HostUptimePort },
): HostBootPorts {
  return Object.freeze({
    bootId: config.hostBootId ?? hostBootIdNow,
    uptimeMs: config.hostUptimeMs ?? hostUptimeNow,
  });
}

/** The port's answer as a usable uptime, or null when it throws or answers nonsense. */
export function measureHostUptime(port: HostUptimePort): number | null {
  try {
    const value = port();
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** The port's answer as a usable identity, or null when it throws or answers nothing. */
export function measureHostBootId(port: HostBootIdPort): string | null {
  try {
    const value = port();
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** What a row records about its boot: only what could be measured, never a guess. */
export function measureHostBoot(host: HostBootPorts): HostBootFacts {
  const facts: { hostBootId?: string; hostUptimeMs?: number } = {};
  const hostBootId = measureHostBootId(host.bootId);
  if (hostBootId !== null) facts.hostBootId = hostBootId;
  const hostUptimeMs = measureHostUptime(host.uptimeMs);
  if (hostUptimeMs !== null) facts.hostUptimeMs = hostUptimeMs;
  return facts;
}

/** The boot facts a row's parsed payload carries; null for a row written with neither. */
export function recordedHostBootOf(facts: Record<string, unknown>): RecordedHostBoot | null {
  const id = facts["hostBootId"];
  const up = facts["hostUptimeMs"];
  const hostBootId = typeof id === "string" && id.length > 0 ? id : null;
  const hostUptimeMs = typeof up === "number" && Number.isFinite(up) && up >= 0 ? up : null;
  return hostBootId === null && hostUptimeMs === null ? null : { hostBootId, hostUptimeMs };
}

/**
 * Whether the host has CERTAINLY rebooted since `recorded` was written — in which case the
 * recorded pid cannot address the recorded child, whatever `kill(pid, 0)` says about it.
 * Either witness suffices. A matching identity does not veto a shorter uptime: a host whose
 * identity failed to advance still cannot be running a process older than its boot.
 */
export function hostRebootedSince(recorded: RecordedHostBoot | null, host: HostBootPorts): boolean {
  if (recorded === null) return false;
  if (recorded.hostBootId !== null) {
    const bootIdNow = measureHostBootId(host.bootId);
    if (bootIdNow !== null && bootIdNow !== recorded.hostBootId) return true;
  }
  if (recorded.hostUptimeMs !== null) {
    const uptimeNow = measureHostUptime(host.uptimeMs);
    if (uptimeNow !== null && uptimeNow < recorded.hostUptimeMs) return true;
  }
  return false;
}
