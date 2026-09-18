import type { RunOnceReport, SpawnReport } from "./agent-spawn-contract.js";

/**
 * The wrapper's per-pass log lines, moved out of `agent-wrapper-main.ts` (that file stood at
 * 397 lines against the 400-line split rail). `write` receives whole lines, newline included,
 * exactly as the binary hands them to `process.stdout.write`.
 *
 * Two kinds of line. ACTIVITY (a start, a refusal, a setup failure) is printed every time it
 * is reported. A STEADY STATE (nothing to staff, a paused provider, an exhausted item) is
 * printed once per distinct state, not once per interval: the continuous loop would otherwise
 * print the same line every few seconds. Exhaustion is a steady state and not activity:
 * `runPass` reports every exhausted READY item on every pass (an honest per-pass observation),
 * and printed as an entry that was one identical line per exhausted item per `intervalMs`
 * (15 s default) into a wrapper.log with no rotation, for as long as the item sat READY;
 * because the pass was "not idle", the idle dedupe never engaged. Activity resets the memory,
 * so the first quiet pass after a start says so again.
 */

/** Mirrors the literal `runPass` mints (agent-wrapper.ts); wrapper-pass-log.test.ts pins the pair. */
const EXHAUSTED_OUTCOME = "STAFFING_ATTEMPTS_EXHAUSTED";

function activityLine(entry: SpawnReport): string {
  // Name the refusing layer: two layers can refuse a start, and the code
  // alone does not say which one answered.
  const refused = entry.refusal === null ? "" : ` (${entry.refusal.layer})`;
  const detail = entry.refusal !== null && "detail" in entry.refusal && typeof entry.refusal.detail === "string"
    ? `: ${entry.refusal.detail}` : "";
  return `[wrapper] ${entry.workItemId}: ${entry.outcome}${refused}${detail}\n`;
}

function steadyLine(report: RunOnceReport, exhausted: readonly SpawnReport[]): string {
  let waiting = "";
  if (report.repositoryWaiting !== undefined && report.repositoryWaiting.length > 0) {
    const items = report.repositoryWaiting.map((entry) => `${entry.workItemId}: ${entry.code}`
      + `${entry.detail === undefined ? "" : ` (${entry.detail})`}; automatic retry after ${new Date(entry.retryAt).toISOString()}`)
      .sort().join(", ");
    waiting = `[wrapper] repository waiting: ${items} (active ${String(report.active)})\n`;
  }
  if (exhausted.length > 0) {
    const items = exhausted.map((entry) => entry.workItemId).sort().join(", ");
    return `${waiting}[wrapper] staffing exhausted: ${items} (${EXHAUSTED_OUTCOME}, active ${String(report.active)})\n`;
  }
  if (waiting !== "") return waiting;
  // Say so: a silent pass reads as a hung wrapper to an operator watching it.
  // A parked fleet is not an idle one: say which provider and until when.
  return report.paused === undefined
    ? `[wrapper] nothing to staff (surface ${report.surfaceOutcome}, active ${String(report.active)})\n`
    : `[wrapper] provider paused: ${report.paused.provider} until ${report.paused.resetAt}`
      + ` (active ${String(report.active)})\n`;
}

/**
 * A latched wrapper, said EVERY pass and never deduped. The latch is a containment, not an
 * idle state: nothing will be staffed until the process restarts, and an operator watching a
 * board that has gone quiet needs the line that says why on every interval, not once in the
 * scrollback under "nothing to staff".
 */
function haltedLine(report: RunOnceReport): string {
  return `[wrapper] HALTED: staffing stopped after an authority cleanup failed; no seat will be`
    + ` staffed until this wrapper is restarted. failures: ${report.halted ?? ""}`
    + ` (active ${String(report.active)})\n`;
}

export function createPassLogger(
  write: (line: string) => void,
): (report: RunOnceReport) => void {
  let lastSteady = "";
  return (report: RunOnceReport): void => {
    if (report.halted !== undefined) {
      write(haltedLine(report));
      return;
    }
    const exhausted: SpawnReport[] = [];
    let activity = false;
    for (const entry of report.spawned) {
      if (entry.outcome === EXHAUSTED_OUTCOME) {
        exhausted.push(entry);
        continue;
      }
      write(activityLine(entry));
      activity = true;
    }
    if (activity && exhausted.length === 0 && (report.repositoryWaiting?.length ?? 0) === 0) {
      lastSteady = "";
      return;
    }
    const steady = steadyLine(report, exhausted);
    if (steady !== lastSteady) write(steady);
    lastSteady = steady;
  };
}
