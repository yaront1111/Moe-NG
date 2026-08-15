# Proving an extraction dropped nothing: coverage arithmetic

Per-function `diff` against HEAD proves each moved body is faithful. It does
NOT prove the set of moves is complete — a whole function silently dropped, or
a line invented between two verified ranges, passes every per-function check.

## The closing step

After diffing each moved range, verify the ranges TILE the original file:

```js
// node -e
const claimed=[[32,56],[58,71],[73,114],[115,182],[183,379],
               [380,485],[486,503],[504,583],[584,648]];
const seen=new Set(); const dup=[];
for(const [a,b] of claimed) for(let i=a;i<=b;i++){ if(seen.has(i)) dup.push(i); seen.add(i); }
const missing=[]; for(let i=32;i<=648;i++) if(!seen.has(i)) missing.push(i);
console.log(seen.size, "covered; dup:", dup, "missing:", missing);
```

Every claimed range must have diffed IDENTICAL, and the result must show zero
duplicates with only blank separators unaccounted. Confirm the leftovers really
are blank with `sed -n '57p;72p' | cat -A` — do not assume.

On `sqlite-schema.ts` (648 lines) this gave 615/617 covered, no duplicates,
lines 57 and 72 both verified blank. Combined with the range diffs, that is a
complete proof: every line of logic lands in exactly one module, unedited.

## Do not tune a normalizer until it agrees with you

My first attempt was a whole-file sorted logic-line set comparison. It reported
differences that were artifacts of the comparison itself — an `export function`
-> `function` rewrite applied to only one side, plus an import line the awk
stripper leaked. The temptation is to keep patching the normalizer until the
diff goes quiet, but a normalizer tuned until it agrees proves nothing about
the code.

Replace the check with one that has no normalizer in the loop (range diffs +
arithmetic) rather than debugging the noisy one.

## Related

`mem:gotcha-verbatim-move-refactor-proof` for the per-range diff technique and
the Windows/Git Bash temp-path caveats. Generate extracted modules by piping
the source range through `sed` rather than retyping — the move is then verbatim
by construction, and large SQL templates never pass through a keyboard.
