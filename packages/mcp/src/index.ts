export const MOE_MCP_PACKAGE_VERSION = "moe-mcp/0" as const;

export {
  MOE_SESSION_CREDENTIAL_ENV,
  connectStdioTransport,
  createStdioMcpServer,
  decodeAndDispatch,
  readBootstrapCredential,
} from "./stdio/stdio-server.js";
export type { StdioServerOptions } from "./stdio/stdio-server.js";
export type { StdioAuthOutcome, StdioDispatchPort } from "./stdio/stdio-dispatch-port.js";
export {
  ADAPTER_SUPPLIED_COMMAND_FIELDS,
  ADAPTER_SUPPLIED_QUERY_FIELDS,
  MCP_TOOL_ALLOWLIST_EMPTY,
  MCP_TOOL_ALLOWLIST_UNKNOWN_KIND,
  STDIO_TOOL_ENTRIES,
  STDIO_TOOL_INDEX,
  STDIO_TOOL_LABEL_PATTERN,
  allowlistedToolEntries,
  generateStdioToolEntries,
  toolLabelForKind,
} from "./stdio/stdio-tool-schemas.js";
export type {
  StdioObjectSchema,
  StdioPropertySchema,
  StdioTool,
  StdioToolEntry,
  StdioToolSurface,
} from "./stdio/stdio-tool-schemas.js";
export { createHttpMcpAdapter } from "./http/http-server.js";
export type {
  HttpAdapterOptions,
  HttpAuthOutcome,
  HttpDispatchContext,
  HttpDispatchPort,
  HttpMcpAdapter,
} from "./http/http-server.js";
export type { HttpSessionPort } from "./http/http-session.js";
/**
 * Published so a host can tell a PARTIAL adapter shutdown from a clean one: `close()` rejects
 * with `HttpShutdownError` naming the sessions whose daemon-side binding was not released. A
 * code nobody outside this package can import would leave that fact undiscriminable.
 */
export {
  HTTP_SHUTDOWN_LAYER,
  HTTP_SHUTDOWN_REFUSAL_CODES,
  HttpShutdownError,
} from "./http/http-shutdown.js";
export type { HttpShutdownRefusalCode } from "./http/http-shutdown.js";
