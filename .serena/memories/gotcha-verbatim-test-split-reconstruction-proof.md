# Proving a verbatim TEST-file split: reconstruct the baseline, don't match names

For "split this oversized test file, change no behavior" tasks (rails forbid renamed/skipped cases
or loosened assertions), the usual proofs are all weaker than they look:

- `it()` name-multiset equality misses a loosened matcher, a dropped `expect`, a flipped loop bound.
- Sorted chunk-set equality (`mem:gotcha-byte-identical-refactor-proof`) is built for *declaration*
  files; test files are a few giant `describe(...)` chunks, so it degenerates to "the blocks moved".

## Do this instead: write the files FROM the baseline, then reconstruct it

1. Never hand-transcribe describe blocks. Slice them out of the committed baseline and write the
   owned paths directly — the move is verbatim by construction:

```js
const base = cp.execSync(`git show <sha>:${P}`, {encoding:"utf8", maxBuffer: 1<<26});
const L = base.split("\n");                       // 0-indexed; L[i] is line i+1
fs.writeFileSync(FILE_A, headA + L.slice(154,360).join("\n") + "\n", "utf8");
fs.writeFileSync(FILE_B, headB + L.slice(361).join("\n"), "utf8");
```

2. Then prove it by rebuilding the baseline minus its import block:

```js
const MARK = '} from "./<fixtures>.js";';
const after = t => t.slice(t.indexOf(MARK) + MARK.length).replace(/^\n+/, "");
const rebuilt = unexport(fixtureBody) + "\n\n" + after(a).replace(/\n$/,"") + "\n\n" + after(b);
console.log(rebuilt === L.slice(17).join("\n"));   // must be true
```

`unexport` strips `export ` by EXPLICIT name list (see
`mem:gotcha-export-keyword-defeats-chunk-equality`) so an accidental extra export shows as a diff.

A `true` here means every byte of every helper, describe, `it()`, assertion, cast, loop matrix and
blank line survives exactly once in original order. Loss, duplication, rename, reorder and assertion
loosening all become impossible at once — you no longer need separate checks for each.

## Slice-boundary gotchas

- Print the boundary lines first (`[13..17, 152..155, 359..362, 512..514]`) and eyeball that each is
  a `describe(` opener, a `});` closer, or blank. Off-by-one silently drops a blank line and the
  reconstruction fails with a confusing "lens differ by 1".
- `split("\n")` on a trailing-newline file yields a final `""`. `slice(361)` (to EOF) keeps it, so
  that half already ends in `\n`; the earlier half does not — add it explicitly.
- Confirm the baseline is LF before slicing: `git show` always yields LF, so if disk is CRLF a
  `base === disk` check fails and you must normalize.

## Companion checks worth the extra ten lines

- Cross-platform physical line count: `t.split(/\r\n|\r|\n/)`, pop a trailing `""`.
- `/\.(skip|only|todo)\b/`, `/^(let|var) /m`, `/Date\.|new Date|Math\.random|performance\.now/`.
- Writes to imported bindings: build the imported-name list from the `import {...}` blocks and test
  `` new RegExp("(?<![A-Za-z0-9_$.])"+s+"\\s*(?:=[^=]|\\.[A-Za-z0-9_$]+\\s*=[^=]|\\[[^\\]]*\\]\\s*=[^=])") ``.
  EXPECT FALSE POSITIVES: `const allowed: readonly Lifecycle[] = ...` and
  `const HASHES: PlanRevisionHashes = {...}` both match. Open each hit rather than trusting the flag.

## Vitest specifics in this repo

`vitest.config.ts` include is `packages/**/*.test.ts`, so a `*-test-fixtures.ts` sibling under `src/`
is typechecked but never collected as a suite. The default forks pool isolates modules per test file,
so a shared fixture module cannot become cross-suite state — but still keep every export `const` and
have factories return fresh objects, since that is the property the rails actually ask for.
