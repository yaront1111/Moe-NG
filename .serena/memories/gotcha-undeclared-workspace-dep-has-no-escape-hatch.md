# An undeclared workspace dep looks importable in a plan and is not

A plan can name another workspace package's vocabulary as "already exists, invent nothing" and be
completely right about the package while completely wrong about *your* package being able to reach
it. `packages/coordination/src/coordination-contracts.ts` exists, exports what the plan says, and is
still unimportable from `apps/daemon`. Measured on task-04e4367443214a588ed6277b92969a33.

## The failure mode
Architects verify the SYMBOL exists (grep hits the definition). Nobody verifies the EDGE — that the
consuming package declares the dependency. The grep is green and the plan is unbuildable.

## Four-probe measurement, cheapest first
```sh
# 1 manifest
cat apps/<app>/package.json                 # is @moe/<dep> in dependencies?
# 2 lockfile importer
grep -n -A 30 "^  apps/<app>:" pnpm-lock.yaml
# 3 installed tree — the one that actually decides resolution
ls apps/<app>/node_modules/@moe/
# 4 runtime, writes nothing to the repo
cd apps/<app> && node --input-type=module -e "await import('@moe/<dep>')"
```
Probe 4 is decisive and leaves no scratch file — important in a shared worktree where a foreign
whole-tree commit hook can sweep a temp probe file into someone else's commit.

## Then check the three escape hatches — in this repo ALL THREE ARE CLOSED
- **Re-export**: grep every symbol name across `packages` and `apps`, excluding the owning package's
  own `src`. Beware false comfort from string literals — `@moe/coordination` appears in
  `apps/control-room/src/evidence/evidence-timeline-ban.test.ts` purely as a quoted string in a
  ban-list table, which greps identically to a real import.
- **tsconfig `paths`**: `tsconfig.base.json` has **no `paths` key** and sets
  `moduleResolution: "NodeNext"`. So tsc resolves through `node_modules` exactly as node does — there
  is no compile-only shortcut that makes `typecheck` pass while runtime fails.
- **Deep relative import** into the other package's `src`: fails TS6059 "not under rootDir", because
  every package tsconfig sets `rootDir: "src"` with `composite: true`.

## Why you usually cannot fix it yourself
The fix is three artifacts: the manifest, `pnpm-lock.yaml`, and a `pnpm install` to materialise the
symlink. Without the install, tsc and node BOTH still fail — editing the two files is not enough.
And `pnpm install` rewrites shared state for all 17 workspace projects in the one shared worktree
(epic rail 2), so it is a global action, not a scoped edit. Correct move is a narrow prerequisite
task that owns manifest + lockfile, or an explicit ownership amendment — not a silent widening.

See also `mem:owned-package-gate-red-is-a-block-not-a-disclosure` and
`mem:task-task-4d22630791994ed1b0906632a75b349b-handoff` (manifest hygiene work actively governs
these files; adding a dep unilaterally collides with it).
