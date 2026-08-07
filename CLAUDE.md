<!-- instruction-contract: bridge -->

# Claude bootstrap

Read `AGENTS.md` first. It is the canonical durable policy source for this
repository; this file contains only Claude-specific bootstrap guidance.

## Tool resolution

- In project prompts, `moe.<name>` is shorthand for MCP tool
  `mcp__moe__moe_<name>` on server `moe`.
- Serena tools are provided by server `serena`.
- When tool schemas are deferred, batch-load every required schema in one
  ToolSearch `select` call rather than guessing tool names.

## Session context

The Moe wrapper injects role and runtime instructions for each session. Follow
that injected context without copying or freezing it into this bridge. Consult
relevant Serena memories for prior task knowledge before changing code.
