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
  STDIO_TOOL_ENTRIES,
  STDIO_TOOL_INDEX,
  STDIO_TOOL_LABEL_PATTERN,
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
  HttpDispatchPort,
  HttpMcpAdapter,
} from "./http/http-server.js";
export type { HttpSessionPort } from "./http/http-session.js";
