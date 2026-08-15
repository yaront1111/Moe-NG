# Proving a "move only, no semantic edit" refactor mechanically

For file-decomposition tasks in this repo (rails demand preserved public types, discriminants,
union order, readonly/optional modifiers), name-set equality is NOT enough — it misses a flipped
`readonly`, a dropped `?`, a reordered union member, or a lost comment.

Cheap strong check: **sorted chunk-set equality**.

```js
const chunks = s => s.split(/\r?\n\r?\n/)
  .map(c => c.replace(/[\r\n]+$/, ""))
  .filter(c => c.length && !c.startsWith("import "));
// compare JSON.stringify(chunks(baseline).sort()) vs
//         JSON.stringify([...chunks(leafA), ...chunks(leafB)].sort())
```

Works because this codebase separates every top-level declaration by exactly one blank line and
attaches doc comments directly above their declaration (no blank between). So one chunk == one
declaration + its comment. Equality of the sorted arrays proves every byte of every declaration
survived and nothing was added or dropped. Get the baseline with
`cp.execSync("git show <sha>:<path>", {encoding:"utf8"})` — no scratch file needed, and rails
forbid leaving evidence files in commits.

Companion checks worth running in the same `node -e`:
- export-name sets: `/^export (?:type|interface) ([A-Za-z0-9_]+)/gm` on each file, sorted-compare
  against baseline AND against the root `index.ts` re-export block (extract with
  `lastIndexOf("export type {", indexOf('} from "<specifier>";'))` then `/^  ([A-Za-z0-9_]+),$/gm`).
- runtime leakage: `/^export (?!type )/m` must not match a type-only facade.
- cycle: neither leaf may reference the facade specifier.
- private bases stayed unexported: assert `/^interface X/m` matches and `export interface X` does not.
- LF/CRLF/CR-equal physical line count: `t.split(/\r\n|\r|\n/)`, minus 1 if the last element is `""`.

Run it as a PowerShell single-quoted here-string piped to `node -e` (`$js = @'...'@; node -e $js`)
— the closing `'@` must sit at column 0, and JS inside can use double quotes freely.
