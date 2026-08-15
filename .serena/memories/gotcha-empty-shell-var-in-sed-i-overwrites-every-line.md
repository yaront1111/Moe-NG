# An empty line-number variable turns `sed -i` into a whole-file wipe

Mutation-drill pattern that bit during task-8d19851491ad:

```bash
L=$(grep -n "^  const files = await sourceFiles" "$F" | cut -d: -f1)
sed -i "${L}s#.*#  const files: string[] = [];#" "$F"
```

The grep pattern had the wrong indent (the line is indented 4 spaces, not 2), so `L` came back empty. `"${L}s#.*#...#"` then expands to the *unaddressed* script `s#.*#...#`, which sed applies to **every line in the file**. The whole 281-line test file became 281 identical lines. Vitest reported `Test Files 1 failed (1) / Tests no tests` — which reads like a config problem, not a clobbered file.

Two defenses, both cheap:

1. **Always snapshot to an OS-temp file with a `trap restore EXIT`, and verify recovery with `git hash-object` before and after.** That is what caught this — the restore printed `RESTORE-HASH-MATCH` and the drill continued with no damage. Without it the corruption would have been committed by the next whole-tree hook (see `mem:mutation-drills-in-shared-worktree`).
2. **Anchor mutations by exact string, not line number.** Use a node one-liner that throws when the anchor is missing:

```bash
node -e 'const fs=require("fs");const[f,a,b]=process.argv.slice(1);const s=fs.readFileSync(f,"utf8");if(!s.includes(a))throw new Error("anchor missing");fs.writeFileSync(f,s.replace(a,b));' "$F" 'OLD' 'NEW'
```

A missing anchor becomes a loud failure instead of a silent full-file substitution.

Related trap in the same session: Git Bash `/tmp` is **not** what `node` resolves. `mktemp -t x.XXXXXX` returns `/tmp/x.abc123`, but node reads that as `D:\tmp\x.abc123` and throws ENOENT. Convert with `cygpath -w` before handing a temp path to node or any native Windows binary.
