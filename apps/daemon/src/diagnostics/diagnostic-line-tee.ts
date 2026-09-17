import type { DiagnosticEmitter, DiagnosticLevel } from "@moe/contracts";

/**
 * MAKES AN EXISTING LINE LOG DURABLE WITHOUT CHANGING WHAT THE OPERATOR SEES.
 *
 * This daemon is threaded with `log: (line: string) => void` callbacks, and their lines are the
 * only account of what a seat, a pass or a reclaim actually did. Every one of them went to a
 * console and nowhere else: when the terminal scrolled, or the wrapper was started by a
 * supervisor that discards its output, the account was gone.
 *
 * The tee is deliberately the smallest possible change at each call site — the same
 * `(line) => void` shape, passing the same bytes to the same stream — so wiring it cannot alter
 * the console output that operators and the existing tests both depend on. The line is carried
 * whole into the record rather than parsed: guessing structure out of a sentence would invent
 * facts, and the sentence is what somebody already wrote for a human to read.
 */

export interface DiagnosticLineTeeOptions {
  readonly emitter: DiagnosticEmitter;
  /** The stable event code every line from this call site is filed under. */
  readonly event: string;
  readonly level?: DiagnosticLevel;
  /** The original sink, called with the original bytes, first. */
  readonly write: (line: string) => void;
}

export function teeDiagnosticLine(
  options: DiagnosticLineTeeOptions,
): (line: string) => void {
  const level = options.level ?? "info";
  return (line: string): void => {
    // The console FIRST and unconditionally. A diagnostic plane that delayed or replaced the
    // operator's own output would be a regression however well it recorded things.
    options.write(line);
    // Trailing newlines belong to the stream convention, not to the record.
    options.emitter[level](options.event, { fields: { line: line.replace(/\s+$/u, "") } });
  };
}
