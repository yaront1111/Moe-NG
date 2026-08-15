# Proving a "verbatim move" refactor mechanically (not by eye)

On refactor-only tasks whose rail is "preserve stable errors / functionally
identical SQL", the messages and check order are usually NOT test-observable —
suites match `DurableStoreError` codes only. Eyeballing the move is the weakest
possible guard. Two cheap mechanical proofs that actually close it:

## 1. Moved function body vs HEAD

```bash
git show HEAD:packages/store/src/<file>.ts | sed -n '<start>,<end>p' \
  | sed -e 's/^  //' -e 's/\bthis\./ctx./g' > /tmp/old_body.txt
sed -n '/^  const firstLine/,/^  return stored;$/p' <new-file>.ts > /tmp/new_body.txt
diff -u /tmp/old_body.txt /tmp/new_body.txt
```

Normalize only the mechanical deltas (indent shift, `this.` -> `ctx.`). A clean
diff, or a diff with exactly the hunks you can name in advance, is the proof.

## 2. Extracted SQL constants vs HEAD

Load the new module under Node's type-stripping runtime and string-compare
against the templates pulled out of the HEAD file:

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning -e "
import fs from 'node:fs';
const sql = await import('./<new-sql-module>.ts');
const head = fs.readFileSync(process.env.HEADFILE, 'utf8');
const bodies = [...head.matchAll(/\.prepare\(\`([\s\S]*?)\`\)/g)].map(m => m[1]);
// resolve any \${INTERPOLATED_CONST} the originals contained, then compare
console.log(bodies.some(b => b === sql.SOME_QUERY));
"
```

This caught a real defect on the decision read-model split: putting the
interpolation `${SHARED_COLUMNS}` on its own line injected an extra blank line
after `SELECT`. Functionally harmless in SQL, but it would have quietly falsified
a "byte-identical" claim. Fix: keep the interpolation inline at the original
indent (`          ${SHARED_COLUMNS}`) and let the constant carry its own indent
on lines 2..n with NO leading newline.

## Windows/Git Bash caveats hit while doing this

- `/tmp/x` in the Bash tool is NOT what `node` resolves — node reads it as
  `D:\tmp\x`. Convert first: `export F=$(cygpath -w /tmp/x)` and read
  `process.env.F` (a trailing `VAR=value` after `node -e "..."` becomes a script
  arg, not an env assignment — export it beforehand).
- `node -e` with top-level `await` plus `require()` fails with
  `ERR_AMBIGUOUS_MODULE_SYNTAX`. Use `import fs from 'node:fs'`.
- Keep every temp artifact OUTSIDE the repo root (`%TEMP%` via `/tmp`), because
  the Moe wrapper auto-commit sweeps the dirty tree
  (`mem:gotcha-moe-wrapper-autocommit`).
