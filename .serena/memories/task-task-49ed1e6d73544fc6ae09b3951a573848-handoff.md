# Foundation MCP dispatch host planning handoff

- Task `task-49ed1e6d73544fc6ae09b3951a573848` was claimed, re-measured, and reported BLOCKED rather than planned against missing package surfaces.
- Stated dependency `task-5e43a9e294ef48fdab23817c8c6cfc45` (Foundation daemon ingress surface) is still PLANNING. Its promised `apps/daemon/src/foundation/foundation-surface.{ts,js}` files are absent.
- All three owned host files are absent/clean.
- The MCP implementation itself is largely real: `packages/mcp/src/stdio/**` contains `createStdioMcpServer` and `StdioDispatchPort`; `packages/mcp/src/http/http-server.ts` contains official Streamable HTTP `createHttpMcpAdapter`, and `http-session.ts` contains `HttpSessionPort`.
- Cross-package reachability gap: `packages/mcp/package.json` exports only `.` to `src/index.ts`, and that root currently exports only stdio. Missing from the public root are at least `createHttpMcpAdapter`, `HttpAdapterOptions`, `HttpMcpAdapter`, `HttpDispatchPort`, and `HttpSessionPort`. The host task cannot deep-import them under its rails and does not own MCP source.
- Required remedy: create/amend a bounded prerequisite that publishes the existing HTTP adapter/type closure from `@moe/mcp` root and updates the MCP root/runtime surface test. The `moe-epic-breakdown` skill was not installed in either Codex/agent/memory skill roots, so this architect did not call `moe.create_task` in violation of the mandatory skill rule; the block was escalated to governors.
- Foreign shared-tree WIP already modifies paths later owned by this task: `apps/daemon/package.json` adds a start script and `pnpm-lock.yaml` contains unrelated Playwright changes. Future work must preserve/attribute those bytes and add only the exact `@moe/mcp` dependency delta.
- Resume only after the daemon ingress task is DONE and the HTTP MCP root surface exists; then re-probe both package roots before planning.
- Final real consumer/certifier remains Foundation canary `task-97554aa4293e40eab56c0b642e18513a`.
