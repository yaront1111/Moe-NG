<!-- instruction-contract: canonical -->

# Durable project instructions

## Purpose

This file is the canonical, tool-neutral instruction contract for this repository.
Provider-specific files must bridge here instead of duplicating project policy.
Keep transient assignments, runtime state, credentials, and generated prompts out of
durable source control.

## Architecture map

This repository is a pnpm workspace. Dependency direction flows toward the shared
contracts rather than from contracts into consumers.

- `packages/contracts`: dependency-free shared types, limits, and codecs.
- `packages/scheduler`: graph validation and zero-authority structural preview.
- `packages/store`: durable event and decision storage foundations.
- `packages/control-room-model`: truth-preserving presentation models.
- `packages/testkit`: development-only reference models and test support.
- `packages/core`, `runner`, `coordination`, `review`, `context`, `mcp`,
  `import`, `control-room-client`, `skills`, `benchmark`: further workspace
  packages — see the README "What runs today" list for one-line roles
  (`benchmark` is DEVELOPMENT_ONLY and parked to v0.2).
- `apps/daemon`: bounded ingress composing the workspace packages.
- `apps/control-room`: the board UI (fixtures by default; `?live=1` is
  development-only).
- `adapters/ide-contract`, `adapters/jetbrains`: implemented external
  integration boundaries; IDE/portability scope is parked to v0.2.

Keep authority, persistence, provider effects, and presentation concerns separated.
Link to deeper design documents instead of growing this file into a full design spec.

## Verification

Run the narrowest relevant command while developing, then the required repository
gate before delivery:

- `pnpm typecheck`
- `pnpm test` — discovers `packages/**` and `tests/**`.
- `pnpm verify:foundation`
- `pnpm verify:store`
- `pnpm --filter @moe/daemon test` — required for daemon tests because the root
  Vitest gate does not discover `apps/**`.

Never claim success without a fresh foreground run and its exit status.

## Git discipline

- Stage only explicit paths owned by the current task.
- Never use `git add -A` or `git add .`.
- Do not push, merge, reset, or stash as part of an implementation task.
- Do not create sibling worktrees.
- Preserve committed history and make no unrelated cleanup changes.

## Shared-tree ownership

Multiple agents work concurrently in this single checkout. Touch only paths assigned
to your task and preserve all foreign work, including untracked files. Never edit live
`.moe/`, `.codex/`, or `.claude/settings.local.json` state during implementation.

## Fail-closed truth

- Use stable reason codes at trust boundaries.
- Missing or unverifiable evidence remains `UNKNOWN` and gains no authority.
- Advisory results remain frozen, set `advisoryOnly: true`, and expose no command or
  execution affordance.
- Keep observation, admission, dispatch, activation, and physical truth distinct.

## Source and test rails

- Target at most 250 lines per production source and split before 400 lines.
- Use test-driven development for every behavior change: red, green, then refactor.
- Add or update tests for every changed function or contract.
- Do not commit debug, probe, scratch, transcript, or generated-evidence files.
- Prefer focused modules, explicit error paths, immutable results, and type safety.

## Pointers

- Authoritative design (read-only; never edit from implementation tasks):
  `D:/projexts/moes/docs/plans/2026-08-05-moe-rebuild-design.md`
- Contribution conventions: `CONTRIBUTING.md`
- Approved implementation plans: `docs/plans/`
