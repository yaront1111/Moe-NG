import { describeThrown } from "@moe/contracts";
import type { DiagnosticThrown } from "@moe/contracts";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import { refuseUnknown } from "./adapter-refusals.js";

/**
 * THE OTHER HALF OF THE CONTAINMENT. Both transports turn anything the dispatch port throws
 * into the registry's `UNKNOWN_ERROR`, so a store's message never reaches an MCP client's
 * logs. Until this module that was the WHOLE story: the seat saw UNKNOWN_ERROR, the daemon saw
 * nothing, and a tool call that died on a locked database, a closed store or a bug in a handler
 * left no trace anywhere an operator could read. The observer carries what was thrown to the
 * HOST — the wrapper's diagnostics, a stderr line — and never into the McpError.
 */

/** Where inside one tool call the throw happened. */
export type McpDispatchFaultStage = "authenticate" | "dispatch" | "response-decode";

export type McpTransportName = "http" | "stdio";

/** The facts of the call site, known before anything threw. */
export interface McpDispatchFaultSite {
  readonly stage: McpDispatchFaultStage;
  readonly surface: "command" | "query";
  /** The VERBATIM dotted runtime kind, never the tool label. */
  readonly toolKind: string;
  readonly transport: McpTransportName;
}

export interface McpDispatchFault extends McpDispatchFaultSite {
  /** The throw, described host-side: name, message, errno code, bounded stack, causes. */
  readonly thrown: DiagnosticThrown;
}

export type McpDispatchFaultObserver = (fault: McpDispatchFault) => void;

/**
 * The containment both `decodeAndDispatch` implementations share. A refusal the port RETURNED
 * is already an `McpError` and passes through untouched — it is a verdict, not a fault, and it
 * is not reported. Anything else is reported to the observer, then refused as UNKNOWN_ERROR.
 *
 * The observer is called INSIDE its own try: an observer that throws must not turn a contained
 * refusal into an uncontained one, so its failure is swallowed and the refusal stands.
 */
export function containDispatchThrow(
  error: unknown,
  site: McpDispatchFaultSite,
  observe: McpDispatchFaultObserver | undefined,
): never {
  if (error instanceof McpError) throw error;
  if (observe !== undefined) {
    try {
      observe({ ...site, thrown: describeThrown(error) });
    } catch {
      // The refusal below is the contract; a broken observer does not get to change it.
    }
  }
  refuseUnknown();
}
