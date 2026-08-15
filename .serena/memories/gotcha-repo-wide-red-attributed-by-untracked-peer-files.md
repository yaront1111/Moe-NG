# A repo-wide red can be a peer's UNTRACKED file, invisible to every diff

Seen QA'ing task-996e5318 (2026-08-15). Root `pnpm typecheck` was EXIT 1 with:

```
packages/mcp typecheck: src/http/http-shutdown.test.ts(26,8): error TS2307:
  Cannot find module './http-shutdown.js' or its corresponding type declarations.
```

The tempting read is "the worker's diff broke packages/mcp" or "the worker faked a green gate" —
the worker's recorded `verification.exitCode` was 0 for the same command 3 hours earlier.

Both wrong. `http-shutdown.ts`, `http-shutdown.js` and `http-shutdown.test.ts` were all UNTRACKED,
written by a live peer between the worker's gate and mine. `git diff <base>..HEAD` shows NOTHING —
it is blind to untracked paths (`mem:gotcha-git-diff-is-blind-to-untracked-paths`) — and
`git log -- <path>` returns nothing either, because the path has no history yet.

**How to attribute in one command:**
```bash
git status --porcelain <failing package dir>     # ?? entries = live peer WIP
git ls-tree HEAD <dir> --name-only                # is the file even committed?
git ls-tree <task-base> <dir> --name-only         # was it there at the baseline?
```
A `??` entry plus absence from both trees closes the question: the red is foreign and post-baseline,
so the (2)-minus-(1) delta the project rail asks for is empty for that path.

**Corollary for the timing case in the same run:** a foreign red can also come from a commit that is
not an ancestor of the task's base. `git merge-base --is-ancestor <suspect> <task-base>` answers it
directly — if the suspect is NOT an ancestor, it entered the tree after the baseline was taken and
cannot be the reviewed task's doing.

**Do not** conclude a worker fabricated a green gate because you now measure red on the same command.
Re-measure WHY, by path, before touching `mem:own-diff-red-in-foreign-file-is-not-excused` — that
memory is about the opposite direction and only applies once the content trace reaches your diff.
