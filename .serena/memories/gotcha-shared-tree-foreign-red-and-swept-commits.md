# Gotcha: in the shared tree, another agent's TDD makes YOUR verification gate red

Observed continuously on `task-04673fd0e786481fad95a9343fee500c` (2026-08-08) inside
`apps/control-room`, with three other agents live in the same package.

## 1. Foreign red flicker

Agents commit **red test files before their production files**. Any task whose gate is
package-wide (`pnpm --filter @moe/control-room typecheck && ... test`) inherits that red.
My gate flipped four times in ~20 minutes — 11:22, 11:36, 11:40:30, 11:41 — each time the
sole failure being someone else's `Cannot find module './x.js'` collection error, while
my own suites stayed green throughout.

**Do not** report_blocked for this: nothing of yours is blocked. **Do not** submit an
earlier green run as "fresh" once you know the tree has gone red — that is a false
evidence claim. Do:

- attribute precisely and early (record the failing paths in your step note the moment
  you see the baseline red, before you write a line of code);
- keep building — your work rarely depends on their directory;
- **poll the gate in the foreground** until it clears. Mine cleared in 2-4 minutes each
  time. A bounded retry loop works; do not sleep, just re-run the gate (each run is its
  own delay).

## 2. Commits that sweep up your in-flight files

Commit `2139fcd` ("Node attempt workspace", task-975f8d67) captured four of my
uncommitted shell files plus `.moe/` state into that task's commit. Epic rail 3 exists
precisely because the index is shared state, and a broad `git add`/bare `git commit`
takes whatever else is in the tree.

Consequences to expect when it happens to you:
- your files land in history under **another task's** message;
- `git status` then shows them as ` M` (tracked) rather than `??`, which looks wrong;
- your own explicit-pathspec commit will legitimately contain **fewer** paths than your
  owned list, because the swept files already match HEAD. Verify with
  `git ls-files --error-unmatch <path>` per owned file that all of them are tracked, and
  say so in the completion note — otherwise a reviewer counts paths and thinks you
  dropped work.

## 3. Never `git add <dir>/` for an owned directory

Directory ownership is not file ownership here. `src/approvals/` was mine, yet held four
foreign in-flight files. `git add src/approvals/` would have committed another agent's
red-phase work. Always `git add -- <explicit file> [<explicit file>...]`, then diff the
staged list against your owned list before committing.

Related: `mem:gotcha-phantom-per-task-loc-bar`.
