# A focused daemon vitest run silently finds ZERO test files

`pnpm --filter @moe/daemon exec vitest run src/recovery/foo.test.ts` exits **1**
with:

```
No test files found, exiting with code 1
include: adapters/**/*.test.ts, packages/**/*.test.ts, tests/**/*.test.ts
```

It resolves the **root** `vitest.config`, whose `include` covers
`adapters/**`, `packages/**`, `tests/**` and therefore never `apps/**`.

The daemon's own script is the tell:

```json
"test": "vitest run --root . --config package.json src"
```

`--config package.json` points vitest at a file with no vitest key, which drops
the root include and restores the defaults. So the working focused form is:

```
pnpm --filter @moe/daemon exec vitest run --root . --config package.json <paths>
```

**Why this matters beyond ergonomics:** several Moe task descriptions name the
BROKEN form as the task's verification command. `moe.complete_task` requires
exit 0, so the named command cannot be submitted as-is. Do not paraphrase it and
do not claim it passed.

**Prove it is the command, not your diff**, before disclosing: run the same
broken form against a pre-existing test file you never touched
(`git status --porcelain -- <that file>` empty). It fails identically. That
control turns "the gate is broken" from an assertion into a measurement.

Related: `mem:root-vitest-excludes-apps`, `mem:vitest-focused-run-config-path-doubles`.
