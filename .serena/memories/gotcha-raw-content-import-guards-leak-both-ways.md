# Raw-content import guards leak in BOTH directions, not just one

`packages/scheduler/src/package-boundary.test.ts` used to enforce the package boundary with `forbiddenInternalPath.test(contents)` against whole file bytes. The known complaint was false positives: a doc comment path-quoting `packages/scheduler/src/authority/test-fixtures.ts` tripped the guard and jammed the board.

The part nobody noticed: **the same raw scan also produced false negatives.** The regex is `/(?:@moe\/scheduler\/|scheduler[\\/]src[\\/])/u`. A genuine CommonJS deep import written with Windows separators —

```js
const scheduler = require("..\\scheduler\\src\\authority\\private.js");
```

— has *escaped* backslashes in the source bytes, so the raw content reads `scheduler\\src\\`. After `scheduler`, `[\\/]` eats one backslash, then the pattern wants `src` but the next character is another backslash. No match. The guard silently allowed a real boundary violation.

Proven by mutation: reverting the detector to the raw scan turns 7 cases red — the 6 prose decoys **and** `detects CommonJS require`.

## Lesson

When a content-scanning guard is reported as noisy, do not just quiet the noise. A regex applied to raw bytes sees escape sequences, comments, and string literals that the language never sees. Fix the layer: extract the actual construct (here, quoted module specifiers from import / `import type` / side-effect import / `export ... from` / dynamic `import()` / `require()`) with a comment- and string-aware scanner, then apply the predicate to the extracted value, where `\\` has already collapsed to `\`.

Pin both axes with hand-written cases. A guard test that only proves "prose is allowed" is half a test — the positive axis is the half that catches regressions, and it is the half that was quietly broken here.
