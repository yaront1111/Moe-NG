/**
 * THE ENTRY for the LIVE legacy quiesce (task-e60b874b). BUILT, NOT RUN.
 *
 * A GREEN `pnpm test:migration` PROVES THE HARNESS AND THESE MODULES WORK. IT IS
 * NOT EVIDENCE THE LEGACY SYSTEM WAS QUIESCED, AND IT MAY NOT BE PRESENTED AS
 * SUCH IN ANY COMPLETION REPORT (rail 2). No test file imports this module. It
 * is inert on import and runs only when executed directly, by hand, in step 8.
 *
 * THE EXECUTION ORDER BELOW IS A SAFETY PROPERTY, NOT A RUNBOOK, which is why it
 * is encoded here. The population includes the daemon serving this board (PID
 * 25536 at step-1 measurement), so the process running this loop does not
 * survive it, and the durable record is written BEFORE the first stop: evidence
 * held only in the memory of a process you are about to kill is not evidence.
 * NOTHING HERE ROLLS ANYTHING BACK — restoring legacy is not in this row's scope.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { compareCutoverManifests } from "../cutover/cutover-compare.js";
import { captureCutoverManifest } from "../cutover/cutover-manifest.js";
import { quiesceItem, type LiveQuiescePorts, type StopAttempt } from "./live-quiesce-actor.js";
// prettier-ignore
import { buildLiveEvidence, writeLiveEvidence, type GoQuiesceAuthority, type StopMoment } from "./live-quiesce-evidence.js";
// prettier-ignore
import { buildLiveInventory, type LiveQuiesceInventoryInput, type LiveQuiesceItem } from "./live-quiesce-inventory.js";

/** Quoted from comment-14cf36f3b61a49269e5cb4fa42187a3d. Step 8 re-reads it first: a stale gate is a stop. */
export const RECORDED_AUTHORITY: GoQuiesceAuthority = {
  principal: "the human operator of this board (Yaron), the project owner",
  moment: "2026-08-24T10:26Z",
  commentId: "comment-14cf36f3b61a49269e5cb4fa42187a3d",
};

const run = (file: string, args: readonly string[]): { code: number; out: string } => {
  try {
    const out = execFileSync(file, [...args], { encoding: "utf8", windowsHide: true });
    return { code: 0, out };
  } catch (error: unknown) {
    const shaped = error as { status?: number; stdout?: string; message?: string };
    return { code: shaped.status ?? 1, out: shaped.stdout ?? shaped.message ?? "" };
  }
};

const attempt = (command: string, code: number, out: string, layer: string): StopAttempt =>
  code === 0
    ? { accepted: true, command, exitCode: code }
    : { accepted: false, command, refusedByLayer: layer, detail: out.trim() };

/**
 * Real ports for this host. PROCESS and ACCESS_PATH stop through taskkill on the
 * owning pid; SCHEDULED_START through schtasks. HANDLE and WATCHER REFUSE by
 * construction — step 1 measured that this host offers no read-only way to
 * enumerate either (handle.exe absent, no ETW-free watcher enumeration), and a
 * kind nobody can observe must never be reported as stopped.
 */
export const WINDOWS_PORTS: LiveQuiescePorts = {
  stop: (item): StopAttempt => {
    if (item.kind === "HANDLE" || item.kind === "WATCHER") {
      const why = `${item.kind} has no observable stop on this host; refusing rather than claiming one`;
      return { accepted: false, command: `<none for ${item.kind}>`, refusedByLayer: "host-discovery", detail: why };
    }
    if (item.kind === "SCHEDULED_START") {
      const { code, out } = run("schtasks", ["/Change", "/TN", item.id, "/DISABLE"]);
      return attempt(`schtasks /Change /TN ${item.id} /DISABLE`, code, out, "task-scheduler");
    }
    const { code, out } = run("taskkill", ["/PID", item.id, "/T", "/F"]);
    return attempt(`taskkill /PID ${item.id} /T /F`, code, out, "windows-process");
  },
  observe: (item) => {
    if (item.kind === "SCHEDULED_START") {
      const { out } = run("schtasks", ["/Query", "/TN", item.id, "/FO", "LIST"]);
      return { live: /Status:\s*Ready/i.test(out), detail: out.trim().slice(0, 240) };
    }
    const { out } = run("tasklist", ["/FI", `PID eq ${item.id}`, "/FO", "CSV", "/NH"]);
    return { live: out.includes(`"${item.id}"`), detail: out.trim().slice(0, 240) };
  },
};

export interface LiveQuiesceRunConfig {
  readonly hostFingerprint: string;
  readonly legacyRoot: string;
  readonly durablePath: string;
  readonly inventory: LiveQuiesceInventoryInput;
  readonly ports: LiveQuiescePorts;
  readonly now: () => string;
}

/**
 * Steps 1-7 of the encoded order. The caller supplies a freshly re-measured
 * inventory: acting on step 1's recorded list would be acting on a stale one.
 */
export const runLiveQuiesce = (config: LiveQuiesceRunConfig): string => {
  const built = buildLiveInventory(config.inventory);
  if (!built.ok) {
    return `REFUSED ${built.code} (${built.layer}): ${built.detail}`;
  }

  const before = captureCutoverManifest(config.legacyRoot);
  if (!("ok" in before) || !before.ok) {
    return `REFUSED before-manifest: ${JSON.stringify(before)}`;
  }

  // ORDER POINT 4 — the pre-stop record lands on disk before a single stop.
  const pre = `PRE-STOP RECORD ${config.now()}\n${JSON.stringify(built.inventory, null, 2)}\n`;
  writeFileSync(config.durablePath, pre, "utf8");

  // ORDER POINT 5 — one at a time, appended AS IT HAPPENS. The loop assumes the
  // process dies partway through, because the seat serving the board is in here.
  const results = [];
  const stoppedAt: StopMoment[] = [];
  for (const item of built.inventory.items as readonly LiveQuiesceItem[]) {
    const result = quiesceItem(item, config.ports);
    results.push(result);
    stoppedAt.push({ itemId: item.id, moment: config.now() });
    appendFileSync(config.durablePath, `${JSON.stringify(result)}\n`, "utf8");
  }

  // ORDER POINT 6 — only if this process still lives to do it.
  const after = captureCutoverManifest(config.legacyRoot);
  if (!("ok" in after) || !after.ok) {
    return `PARTIAL: stops recorded, after-manifest unavailable: ${JSON.stringify(after)}`;
  }

  const evidence = buildLiveEvidence({
    runMode: "LIVE",
    hostFingerprint: config.hostFingerprint,
    authority: RECORDED_AUTHORITY,
    inventory: built.inventory,
    results,
    manifestComparison: compareCutoverManifests(before.manifest, after.manifest),
    stoppedAt,
  });
  if (!evidence.ok) {
    return `REFUSED ${evidence.code} (${evidence.layer}): ${evidence.detail}`;
  }

  const written = writeLiveEvidence(evidence.evidence, config.durablePath, {
    writeFile: (path, body) => writeFileSync(path, body, "utf8"),
  });
  return written.ok
    ? `${evidence.evidence.outcome} — ${written.byteLength} bytes at ${written.path}`
    : `REFUSED ${written.code}: ${written.detail}`;
};

/** Inert on import; refuses a bare invocation, because a run needs a measured inventory. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error("call runLiveQuiesce from a step-8 driver with a fresh inventory, never bare.");
}
