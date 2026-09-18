<!-- instruction-contract: bridge -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` first — the canonical, tool-neutral policy contract. Then read
the `CLAUDE.md` of the folder you are changing: every package, app, adapter,
tool and test lane has one, holding that folder's seams, invariants, gotchas
and test commands.

`moe.<name>` in project prompts means MCP tool `mcp__moe__moe_<name>` (server
`moe`); batch-load deferred schemas in one ToolSearch `select`. The Moe wrapper
injects role instructions per session — follow them without freezing them here.

## Commands — pnpm workspace, Node >=24.16 <25

- `pnpm typecheck` — every package (`-r --no-bail` to see past the first).
- `pnpm test` — root suite: `adapters packages tests tools`, **not** `apps/**`.
- `pnpm --filter @moe/daemon test`, `… @moe/control-room test` — the app suites.
- One daemon file needs its own root and config:
  `pnpm --filter @moe/daemon exec vitest run --root . --config package.json <path>`
- `pnpm test:security`, `test:fault`, `test:migration`, `test:e2e`, `test:e2e:browser`.

A fresh worktree has no Windows Job broker: native lanes fail
`PROCESS_BOUNDARY_BROKER_UNRESOLVED` until you build it with the cargo line
pinned in `packages/runner/src/platform/windows/windows-broker-path.ts`.

## Gotchas

- Every new `.ts` under `apps/daemon` and `packages/*` needs a sibling one-line
  `.js` bridge (`export * from "./thing.ts";`). Only the runtime graph sees one
  missing, and one absent bridge reds a dozen unrelated suites.
- Census tests are hand-mirrored on purpose. Re-measure and move the pin; never
  widen a matcher or delete an arm.
- This checkout is shared with other sessions: `git diff HEAD -- <file>` before
  staging, never `git add -A`.
- A test that spawns a daemon must get its own `MOE_PROJECT_ROOT`.
