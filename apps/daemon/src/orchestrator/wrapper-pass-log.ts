import type { RunOnceReport } from "./agent-spawn-contract.js";

/**
 * The wrapper's per-pass log lines, moved out of `agent-wrapper-main.ts` verbatim: that file
 * stood at 397 lines against the 400-line split rail, and the command-plane wiring could not
 * land until something moved. `write` receives whole lines, newline included, exactly as the
 * binary hands them to `process.stdout.write`; the logger holds the once-per-distinct-state
 * memory the loop used to keep in `lastIdle`.
 */
export function createPassLogger(
  write: (line: string) => void,
): (report: RunOnceReport) => void {
  let lastIdle = "";
  return (report: RunOnceReport): void => {
    for (const entry of report.spawned) {
      // Name the refusing layer: two layers can refuse a start, and the code
      // alone does not say which one answered.
      const refused = entry.refusal === null ? "" : ` (${entry.refusal.layer})`;
      write(`[wrapper] ${entry.workItemId}: ${entry.outcome}${refused}\n`);
    }
    if (report.spawned.length === 0) {
      // Say so: a silent pass reads as a hung wrapper to an operator watching it.
      // Once per distinct idle state, not once per interval — the continuous
      // loop would otherwise print the same line every few seconds.
      // A parked fleet is not an idle one: say which provider and until when.
      const idle = report.paused === undefined
        ? `[wrapper] nothing to staff (surface ${report.surfaceOutcome}, active ${String(report.active)})\n`
        : `[wrapper] provider paused: ${report.paused.provider} until ${report.paused.resetAt}`
          + ` (active ${String(report.active)})\n`;
      if (idle !== lastIdle) write(idle);
      lastIdle = idle;
    } else {
      lastIdle = "";
    }
  };
}
