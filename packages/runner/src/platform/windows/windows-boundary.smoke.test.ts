import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { openWindowsProcessBoundary } from "./windows-boundary.js";
import { findWorkspaceRoot } from "./windows-broker-path.js";
import { type WindowsProcessBoundary } from "./windows-boundary-session.js";
import { type WindowsProcessIdentity } from "./windows-process-contract.js";

const CASES = Object.freeze(["close", "cancel", "timeout"] as const);
const REPORT_BOUND_MS = 15_000;
const DEATH_BOUND_MS = 10_000;
/**
 * The timeout case's own budget, and it has to outlast the liveness PROOFS that
 * run inside it: the case reports both identities and then spawns powershell
 * three times to prove parent, grandchild and the PID-reuse guard, all before
 * the boundary is allowed to fire. At the former 1_500ms that work lost the
 * race under the full 299-file parallel run — the parent read GONE at the first
 * query (repo gate, 2026-08-19) — while passing 10/10 in isolation. 12s is
 * bounded, still proves the timeout path, and cannot be outrun by three process
 * spawns.
 */
const TIMEOUT_TRIGGER_MS = 12_000;
const WINDOWS_HOST = process.platform === "win32";

interface ReportedPair {
  readonly parent: WindowsProcessIdentity;
  readonly grandchild: WindowsProcessIdentity;
}

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function releaseBinary(name: string): string {
  const root = findWorkspaceRoot(process.cwd());
  if (root === null) throw new Error("the smoke could not locate the workspace root");
  return join(root, "dist", "windows-job-native", "release", `${name}.exe`);
}

function parseIdentity(line: string, expectedName: string): WindowsProcessIdentity {
  const [name, pidText, creationText, extra] = line.trim().split(/\s+/u);
  if (name !== expectedName || extra !== undefined) {
    throw new Error(`the smoke report has no exact ${expectedName} identity`);
  }
  const pid = Number(pidText);
  const creationTime = BigInt(creationText ?? "0");
  if (!Number.isSafeInteger(pid) || pid <= 0 || creationTime <= 0n) {
    throw new Error(`the smoke report's ${expectedName} identity is unusable`);
  }
  return Object.freeze({ pid, creationTime });
}

async function awaitReport(path: string): Promise<ReportedPair> {
  const deadline = Date.now() + REPORT_BOUND_MS;
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(path, "utf8").trim().split(/\r?\n/u);
      if (lines.length === 2) {
        return {
          parent: parseIdentity(lines[0] ?? "", "parent"),
          grandchild: parseIdentity(lines[1] ?? "", "grandchild"),
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error("the detached provider did not publish both identities in time");
}

const LIVENESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { $p = Get-Process -Id ([int]$env:MOE_PID) -ErrorAction Stop }
catch { Write-Output 'GONE'; exit 0 }
try { $observed = [int64]$p.StartTime.ToUniversalTime().ToFileTimeUtc() }
catch { Write-Output 'GONE'; exit 0 }
if ($observed -ne [int64]$env:MOE_CREATION) { Write-Output 'GONE'; exit 0 }
try { if ($p.HasExited) { 'GONE' } else { 'RUNNING' } }
catch { 'GONE' }
`;

function liveness(identity: WindowsProcessIdentity): "RUNNING" | "GONE" {
  const queried = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", LIVENESS_SCRIPT],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MOE_PID: String(identity.pid),
        MOE_CREATION: String(identity.creationTime),
      },
      shell: false,
      windowsHide: true,
    },
  );
  if (queried.status !== 0) {
    throw new Error(`the identity liveness query failed: ${queried.stderr.trim()}`);
  }
  const answer = queried.stdout.trim();
  if (answer !== "RUNNING" && answer !== "GONE") {
    throw new Error(`the identity liveness query returned ${JSON.stringify(answer)}`);
  }
  return answer;
}

async function awaitGone(identity: WindowsProcessIdentity): Promise<void> {
  const deadline = Date.now() + DEATH_BOUND_MS;
  while (Date.now() < deadline) {
    if (liveness(identity) === "GONE") return;
    await delay(25);
  }
  throw new Error(`process ${identity.pid} did not die within the smoke bound`);
}

function openCase(report: string, trigger: (typeof CASES)[number]): WindowsProcessBoundary {
  const provider = releaseBinary("detached_spawner");
  const opened = openWindowsProcessBoundary(
    { executable: provider, argv: [report], cwd: dirname(provider), environment: {} },
    { timeoutMs: trigger === "timeout" ? TIMEOUT_TRIGGER_MS : 30_000 },
  );
  if (!("completed" in opened)) {
    throw new Error(`the real boundary refused at ${opened.layer}/${opened.code}`);
  }
  return opened;
}

async function triggerStop(
  boundary: WindowsProcessBoundary,
  trigger: (typeof CASES)[number],
): Promise<void> {
  const outcome = trigger === "close"
    ? await boundary.close()
    : await (trigger === "cancel" ? (boundary.cancel(), boundary.completed) : boundary.completed);
  if (outcome.truthClass === "UNKNOWN") {
    throw new Error(`the ${trigger} outcome was ${outcome.layer}/${outcome.code}: ${outcome.message}`);
  }
  expect(outcome.truthClass).toBe("PROVEN");
}

describe.skipIf(!WINDOWS_HOST)("the TypeScript facade drives real Job containment", () => {
  it.each(CASES)("kills parent and detached grandchild through %s", async (trigger) => {
    const directory = mkdtempSync(join(dirname(releaseBinary("detached_spawner")), "facade-smoke-"));
    const reportPath = join(directory, "identities.txt");
    let boundary: WindowsProcessBoundary | null = null;
    try {
      boundary = openCase(reportPath, trigger);
      const reported = await awaitReport(reportPath);
      await expect(boundary.started).resolves.toEqual(reported.parent);
      expect(liveness(reported.parent)).toBe("RUNNING");
      expect(liveness(reported.grandchild)).toBe("RUNNING");
      // This is the PID-reuse guard: the same live PID with another creation
      // time is NOT the process the report named.
      expect(liveness({
        pid: reported.parent.pid,
        creationTime: reported.parent.creationTime + 1n,
      })).toBe("GONE");

      await triggerStop(boundary, trigger);
      await awaitGone(reported.parent);
      await awaitGone(reported.grandchild);
    } finally {
      if (boundary !== null) await boundary.close();
      // The provider tree just exited in this directory; Windows can still hold
      // it, so the removal retries rather than failing the case in teardown.
      rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
    }
    // TIMEOUT_TRIGGER_MS plus both DEATH_BOUND_MS waits must fit inside this.
  }, 60_000);
});

it("generates exactly the close, cancel and timeout cases", () => {
  expect(CASES).toEqual(["close", "cancel", "timeout"]);
  expect(CASES.length).toBe(3);
});

it.skipIf(WINDOWS_HOST)("refuses the real boundary before resolution off Windows", () => {
  const outcome = openWindowsProcessBoundary({
    executable: "C:\\provider\\provider.exe",
    argv: [],
    cwd: "C:\\work",
    environment: {},
  });

  expect("completed" in outcome).toBe(false);
  if ("completed" in outcome) throw new Error("a non-Windows host opened a process boundary");
  expect(outcome).toMatchObject({
    truthClass: "UNKNOWN",
    code: "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED",
    layer: "WINDOWS_PROCESS_REQUEST",
  });
});
