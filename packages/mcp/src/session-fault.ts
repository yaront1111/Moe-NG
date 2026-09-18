import { describeThrown } from "@moe/contracts";
import type { DiagnosticThrown } from "@moe/contracts";

/**
 * The session screen's counterpart to `dispatch-fault.ts`, kept SDK-free on purpose:
 * `http-session.ts` depends on `@moe/contracts` and nothing else, and the security lane
 * deep-imports it, so the observer it reports to must not drag the MCP SDK into its graph.
 *
 * A session port that THROWS while validating a bearer has rendered no verdict. The screen
 * refuses UNKNOWN_ERROR — never AUTHENTICATION_FAILED, whose recovery would send the client to
 * re-open a session for a fault a fresh credential cannot cure — and until this module that
 * refusal was the whole story: a credential store that was locked or closed refused every
 * request on the endpoint, 500 after 500, and the daemon's own log said nothing.
 */

export interface McpSessionFault {
  readonly stage: "validate-bearer";
  /** The throw, described host-side: name, message, errno code, bounded stack, causes. */
  readonly thrown: DiagnosticThrown;
  readonly transport: "http";
}

export type McpSessionFaultObserver = (fault: McpSessionFault) => void;

/**
 * Never throws: the refusal is decided before this runs, and an observer that throws must not
 * turn a contained UNKNOWN_ERROR into an uncontained one.
 */
export function observeSessionFault(
  observe: McpSessionFaultObserver | undefined,
  error: unknown,
): void {
  if (observe === undefined) return;
  try {
    observe({ stage: "validate-bearer", thrown: describeThrown(error), transport: "http" });
  } catch {
    // The refusal stands; a broken observer does not get to change it.
  }
}
