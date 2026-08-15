# @moe/mcp HTTP implementation can exist but remain unreachable

As measured 2026-08-09, `packages/mcp/src/http/http-server.ts` implements the official Streamable HTTP adapter and `http-session.ts` implements the session port, but `packages/mcp/package.json` exposes only the package root and `src/index.ts` exports only stdio symbols.

A daemon consumer obeying the public-root rail therefore cannot call HTTP without a root-surface prerequisite. Re-measure these exact symbols before any host plan:
- `createHttpMcpAdapter`
- `HttpAdapterOptions`
- `HttpMcpAdapter`
- `HttpDispatchPort`
- `HttpSessionPort`

Do not deep-import `@moe/mcp/src/http/**`; publish the existing production surface and pin it in the MCP root/runtime entrypoint test first.
