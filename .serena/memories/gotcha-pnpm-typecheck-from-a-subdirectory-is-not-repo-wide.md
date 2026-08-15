# `pnpm typecheck` from a package subdirectory silently narrows to that package

The third verification leg on this board is repo-wide `pnpm typecheck`, which at
the repo root runs `pnpm --recursive typecheck` across all 16 workspace projects.

Run the SAME command from inside `apps/daemon` (or any package) and pnpm resolves
the package's own `typecheck` script instead — `tsc --project tsconfig.json` for
that one package. It prints almost nothing and exits 0.

The trap is that the Bash tool's working directory PERSISTS between calls. A
`cd apps/daemon` in an earlier call — e.g. to run a plain-Node bridge probe, which
must run from the package root — is still in effect several calls later. Then:

```
$ pnpm typecheck 2>&1 | grep -E "error TS|Failed|ELIFECYCLE"
(no output)
```

reads as "repo-wide typecheck is now green" when nothing repo-wide was run. It is
especially convincing when you are polling a foreign red you expect to clear.

**Tells, in order of reliability**
1. The real run prints `pnpm --recursive typecheck` then `Scope: 16 of 17
   workspace projects`. No `Scope:` line means it was not recursive.
2. A stray `git status -- <repo-relative-path>` in the same call fails with
   `could not open directory 'apps/daemon/<path>'` — the doubled prefix names
   the actual cwd.

**Habit:** prefix the gate with an absolute `cd`, e.g.
`cd /d/projexts/moe-next && pnpm --filter @moe/daemon typecheck && ...`, and
grep the tail for `Scope:` before believing a green.

This produced a false green and then a self-correction inside one task; it is a
pure harness artefact, not anything about the code.
