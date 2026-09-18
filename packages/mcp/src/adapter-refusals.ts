import { createRuntimeError } from "@moe/contracts";
import type { RuntimeError } from "@moe/contracts";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * The refusal and serialisation helpers both transports share, byte for byte. They were
 * duplicated in `stdio-server.ts` and `http-tool-bridge.ts` until the dispatch-fault observer
 * made each file too long; the parity suite still byte-compares the envelopes each port
 * receives, so a drift in `serialize` reds there.
 */

/** Every adapter-side refusal routes through the registry, never through invented codes. */
export function refuse(error: RuntimeError): never {
  throw new McpError(error.transport.mcpCode, error.code, error);
}

export function refuseInvalidInput(): never {
  refuse(createRuntimeError({ code: "INPUT_INVALID" }));
}

/**
 * A broken daemon boundary is never reflected back: anything the port throws becomes the stable
 * `UNKNOWN_ERROR`, so host paths, connection strings and stack text in an arbitrary `Error`
 * message cannot reach an MCP client's logs. What was thrown goes HOST-SIDE instead, through
 * `containDispatchThrow` in `dispatch-fault.ts`.
 */
export function refuseUnknown(): never {
  refuse(createRuntimeError({ code: "UNKNOWN_ERROR" }));
}

export function serialize(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    refuseInvalidInput();
  }
  if (text === undefined) refuseInvalidInput();
  return text;
}
