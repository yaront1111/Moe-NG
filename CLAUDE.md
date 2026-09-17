<!-- instruction-contract: bridge -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` first: it is the canonical, tool-neutral policy contract
(verification commands, git discipline, shared-tree ownership, fail-closed
truth, source and test rails). This file adds Claude-specific bootstrap plus
the commands and architecture that take several files to piece together.

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

## Commands

pnpm workspace (pnpm 11, Node >=24.16 <25). `pnpm typecheck` runs every
package's own `tsc --project tsconfig.json`.

| Task | Command |
| --- | --- |
| Whole repo typecheck | `pnpm typecheck` (all packages; `-r --no-bail` to see every package's errors, not just the first) |
| Root suite | `pnpm test` — discovers `adapters/**`, `packages/**`, `tests/**`, `tools/**`, **not** `apps/**` |
| Daemon suite | `pnpm --filter @moe/daemon test` — its own vitest root/config; excludes the live-provider arm by negative `--testNamePattern` |
| Control room | `pnpm --filter @moe/control-room test`, `… build`, `… dev` |
| One root/package file | `pnpm vitest run packages/store/src/foo.test.ts` |
| One daemon file | `pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/review/foo.test.ts` |
| One control-room file | `pnpm --filter @moe/control-room exec vitest run src/v2/goals/foo.test.tsx` |
| Security / fault / migration lanes | `pnpm test:security`, `pnpm test:fault`, `pnpm test:migration` (each runs its own `tsc -p` first, then a lane-specific vitest config) |
| Foundation e2e (real daemon + wrapper processes) | `pnpm test:e2e` |
| Browser e2e (Playwright, needs a built control room) | `pnpm test:e2e:browser` |
| Packaging / import typechecks | `pnpm typecheck:packaging`, `pnpm typecheck:import` |
| Windows artifact | `pnpm pack:windows` |

Repo entry points: `pnpm start` (`moe-up`), `pnpm seed`, and the `@moe/daemon`
bins `moe`, `moe-daemon`, `moe-mcp-http`, `moe-mcp-stdio`, `moe-up`,
`moe-wrapper`.

A **fresh worktree has no Windows Job broker**, and the native drain, launch
and criterion tests fail `PROCESS_BOUNDARY_BROKER_UNRESOLVED` without it. Build
it with the pinned line (the same one `windows-broker-path.ts` documents):

```
cargo build --locked --release \
  --manifest-path packages/runner/src/platform/windows/native/Cargo.toml \
  --target-dir dist/windows-job-native -p moe-windows-job-broker
```

## Architecture

Dependency direction runs toward the contracts, never back:

`packages/contracts` (dependency-free types, limits, codecs) → `packages/core`
(reducers and authority kernels for goal, planning, policy, cutover, expansion),
`packages/scheduler` (graph validation, admission, leases, budgets, readiness,
supersession), `packages/store` (SQLite event store, command-decision ledger,
projections, subscriptions) → `packages/runner` (provider launch, Windows
process boundary, evidence, materialization, recovery inventory),
`packages/coordination`, `review`, `context`, `mcp`, `import`, `skills` →
`apps/daemon` (the bounded ingress that composes all of it) → `apps/control-room`
(the browser UI) and `adapters/jetbrains`.

**One durable spine.** Every write is a command decision committed to the
SQLite store at an `expectedVersion`, and every read is a fold over those
decisions. Handlers never mutate state directly: `daemon-command-registry.ts`
routes a kind to a handler, the handler admits or refuses, and what it commits
becomes the only truth later readers see. Refusals carry a stable code plus a
layer; unverifiable evidence stays `UNKNOWN` rather than being guessed.

**Offers, not endpoints.** The control room does not decide what is possible.
`/affordances/read` folds durable state into the offers a principal may take,
and the UI renders exactly those. A capability that is not offered cannot be
driven by clicking.

**Orchestration.** `apps/daemon/src/orchestrator` is the wrapper: it staffs
work items by spawning real provider seats (`claude -p`, Codex), fences them by
session and host boot, lands their commits, and — with `MOE_NODE_TREES=1` —
gives each node its own Git worktree that an integrator merges back.

**Review lineage is positional.** A node's review is rounds plus human
decisions (`escalation.decide` ALLOW_MORE_ATTEMPTS or REPLAN) plus an agent's
`qualification.replan`. Readers prove *position* over the committed decision
rows (`review-terminal-replan.ts`, `review-replan-position.ts`) rather than
testing whether a flag is set; the fold never clears a re-plan, so "a delta
exists" says nothing about the package an acceptance attests.

## Conventions that surprise newcomers

- **Every new `.ts` module under `apps/daemon`, `packages/*` and parts of
  `apps/control-room` needs a sibling one-line `.js` bridge**
  (`export * from "./thing.ts";`). Neither `tsc` nor vitest sees it missing;
  the daemon's runtime module graph does, and one absent bridge reds a dozen
  unrelated suites with `ERR_MODULE_NOT_FOUND`.
- **Census tests are load-bearing.** Rosters, counts and hand-written mirrors
  (`tests/security/**` TASK-LV layer census, `*-surface.test.ts`, command
  vocabulary counts, `tests/integration/release/release-version-surfaces.ts`,
  the e2e `journey-coverage` ledger) are deliberately duplicated by hand so a
  production change cannot move both sides at once. When one goes red, decide
  whether the pin should follow reality or the code is wrong, then re-measure
  rather than widening a matcher or deleting an arm.
- **This checkout is shared with other agent sessions.** It is never clean;
  `git add <file>` can sweep a peer's uncommitted hunk into your commit. Check
  `git diff HEAD -- <file>` before staging, and never `git add -A`.
- **Tests that spawn a daemon must hand it its own `MOE_PROJECT_ROOT`**, a
  git-initialised scratch directory. The activation receipt path writes store
  backups under `<projectRoot>/.moe-next/backups` and prunes them, so daemons
  sharing a root race each other.
