import type { DiagnosticEmitter } from "@moe/contracts";
import type {
  McpDispatchFault, McpDispatchFaultObserver, McpSessionFault, McpSessionFaultObserver,
} from "@moe/mcp";

/**
 * The event a tool call that THREW host-side lands under, on every MCP entry: the wrapper's
 * loopback host, the `moe-mcp-http` bin and the per-seat `moe-mcp-stdio` bin all report
 * through this one function, so an operator greps one name.
 */
export const MCP_DISPATCH_THREW = "MCP_DISPATCH_THREW";

/** The HTTP session screen's port threw while validating a bearer: 500 to the client, this here. */
export const MCP_SESSION_SCREEN_THREW = "MCP_SESSION_SCREEN_THREW";

/**
 * Turns `@moe/mcp`'s dispatch-fault observer into a diagnostics record. The seat sees exactly
 * `UNKNOWN_ERROR`; everything the containment swallowed — the runtime kind, the stage, the
 * throw's name, message, errno code, causes and bounded stack — lands here at `error` level,
 * which the console sink prints at its default `warn` threshold and the file sink keeps.
 *
 * Flattened into FIELDS rather than handed over as `error`: the fault carries the throw
 * already described, and re-describing a description would read as a thrown `Object`. Fields
 * pass through the codec's secret scrub like everything else on the record.
 */
export function mcpDispatchFaultReporter(emitter: DiagnosticEmitter): McpDispatchFaultObserver {
  return (fault: McpDispatchFault): void => {
    emitter.error(MCP_DISPATCH_THREW, {
      fields: {
        stage: fault.stage,
        surface: fault.surface,
        thrownCauses: fault.thrown.causes.join(" <- "),
        thrownCode: fault.thrown.code,
        thrownMessage: fault.thrown.message,
        thrownName: fault.thrown.name,
        thrownStack: fault.thrown.stack,
        toolKind: fault.toolKind,
        transport: fault.transport,
      },
    });
  };
}

/**
 * The session-screen twin. A credential store that is locked or closed refuses EVERY request on
 * the endpoint with UNKNOWN_ERROR, and before this the only sign was a seat that could not
 * connect; the record names the throw so the operator sees the store, not the seat.
 */
export function mcpSessionFaultReporter(emitter: DiagnosticEmitter): McpSessionFaultObserver {
  return (fault: McpSessionFault): void => {
    emitter.error(MCP_SESSION_SCREEN_THREW, {
      fields: {
        stage: fault.stage,
        thrownCauses: fault.thrown.causes.join(" <- "),
        thrownCode: fault.thrown.code,
        thrownMessage: fault.thrown.message,
        thrownName: fault.thrown.name,
        thrownStack: fault.thrown.stack,
        transport: fault.transport,
      },
    });
  };
}
