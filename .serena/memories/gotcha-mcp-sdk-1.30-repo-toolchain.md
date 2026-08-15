# Gotcha: @modelcontextprotocol/sdk 1.30.0 with this repo's toolchain

All empirically proven against TypeScript 7.0.2 / @types/node 24.13.3 / vitest 4.1.10 / pnpm 11.0.8.

## tsconfig MUST set skipLibCheck
The SDK's .d.ts references the global `HeadersInit`, which @types/node 24.13.3 does not declare.
Without `"skipLibCheck": true` in the consuming package's tsconfig, `tsc` fails with TS2304.
`packages/mcp/tsconfig.json` sets it; it is the only deviation from the packages/contracts tsconfig
besides `tsBuildInfoFile`. Scoped to that package, so it does not weaken checking elsewhere.

## Import subpaths DO resolve despite a broken-looking wildcard
package.json maps `"./*": {"types": "./dist/esm/*.d.ts", "import": "./dist/esm/*"}`. For
`@modelcontextprotocol/sdk/types.js` that literally computes `./dist/esm/types.js.d.ts`, which does
not exist — but NodeNext resolution still lands correctly. These four all typecheck:
- `@modelcontextprotocol/sdk/server/index.js`
- `@modelcontextprotocol/sdk/client/index.js`
- `@modelcontextprotocol/sdk/types.js`
- `@modelcontextprotocol/sdk/inMemory.js`
Verify with a throwaway probe file before assuming a NEW subpath works.

## Use the low-level Server, never McpServer, for generated JSON Schema
`McpServer`'s `inputSchema` type is zod-only (`AnySchema` in zod-compat.d.ts). Feeding it a generated
JSON Schema requires adding a zod dependency and re-deriving the schema, which drifts.
`Server` + `setRequestHandler(ListToolsRequestSchema | CallToolRequestSchema, ...)` serves frozen
plain JSON Schema objects verbatim with ZERO zod. Requires `capabilities: { tools: {} }`.
`ToolSchema.inputSchema` is `z.ZodObject<{type, properties?, required?}>` with a catchall, so
`additionalProperties: false` rides through as a catchall key.

## Thrown errors become JSON-RPC errors predictably
`shared/protocol.js:398-401` uses a thrown error's `code` when `Number.isSafeInteger(code)` and
forwards `data` verbatim. So `throw new McpError(registryCode, stableCode, runtimeError)` produces
exactly the wire error you want, and `protocol.js:459` rebuilds it client-side with code+data intact.
Anything else thrown has its `error.message` copied into the response — WRAP port/IO calls or host
paths and connection strings leak to the client.

## CODE COLLISION with the frozen runtime registry
SDK `ErrorCode.RequestTimeout` is -32001, the same number the registry binds to UNAUTHENTICATED.
Clients cannot distinguish an auth refusal from an SDK timeout by JSON-RPC code alone; they must read
`error.data.code`. `ErrorCode.InvalidParams` -32602 happens to agree with INPUT_INVALID.

## InMemoryTransport passes JSON-RPC objects BY REFERENCE
No serialization happens, so malformed wire bytes are UNREPRESENTABLE through a protocol roundtrip.
Do not claim a roundtrip test covers a decoder's malformed-bytes branch — drive the decode function
directly with hostile bytes instead.
Byte identity IS still genuinely testable over InMemoryTransport when the bytes ride as an opaque
string inside a text content block.

## pnpm install
Succeeds with ONLY the SDK declared — zod is dual-listed dep+peer and self-satisfies, which matters
because the workspace sets `autoInstallPeers: false` and `strictPeerDependencies: true`.
92 transitive entries, +770 lockfile lines, zero build scripts, no pnpm-11 approval prompt.
