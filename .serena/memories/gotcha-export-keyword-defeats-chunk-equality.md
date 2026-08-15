# Gotcha: the `export` keyword and blank-line drift break naive chunk-set equality

`mem:gotcha-byte-identical-refactor-proof` gives the sorted chunk-set check for proving a
"move only" refactor. When the move is **private helper -> exported helper in a new module**
(the common `<x>-reducer.ts` -> `<x>-results.ts` split in `packages/core`), the naive version
reports a false mismatch. Two reasons, both hit on 2026-08-08 in task-5a95354855304c.

## 1. `export function` != `function`

Every moved helper gains `export `. Normalize it — but normalize ONLY the helpers you
intended to export, by name, so that an *accidental* new export still shows up as a diff:

```js
const HELPERS = ["rejected","unknownFailure","illegal","rebound","supersededAuthority",
                 "versionConflict","accepted","clonedState"];
const unexport = c => c.replace(
  new RegExp("^((?:/\\*\\*[\\s\\S]*?\\*/\\n)?)export function (" + HELPERS.join("|") + ")\\b"),
  "$1function $2");
```

The `(?:/\*\*...\*/\n)?` prefix group matters: a doc comment sits inside the same chunk as its
declaration, so `^export function` does not match those chunks at all. A blanket
`.replace(/^export /, "")` silently misses every documented helper AND would mask a real
accidental export of a reducer internal.

## 2. Import stripping leaves a stray leading newline

Removing import lines can leave the next chunk starting with `\n`, so the first declaration
after the import block never compares equal. Fix by `.map(c => c.trim())` instead of only
stripping trailing newlines.

## Companion fingerprints that catch what chunk equality cannot

Chunk equality proves each declaration survived; it does not prove the *entry point* still
calls them in the same order (a reordered check inside one chunk changes that chunk, but a
reordered check spread across chunks would not). Add:

```js
const body = t => t.slice(t.indexOf("export function reduceX"));
const calls = t => (body(t).match(/\b(helperA|helperB|guardC)\(/g) || []).join(",");
// baseline vs now must be identical
```

plus whole-file `deepFreeze(` and `Object.freeze(` counts summed across the split files
(a lost freeze is a real regression the type checker will not catch), and a byte compare of
the header prefix before the first import to prove the composition commentary survived.
