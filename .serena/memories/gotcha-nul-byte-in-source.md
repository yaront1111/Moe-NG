# Gotcha: a stray NUL byte turns a source file invisible to tooling

On `packages/core/src/identity/identity-capability.ts` a single NUL (0x00) ended
up as a `join()` separator instead of a printable delimiter.

## Why it is dangerous, and why no test catches it

The code still WORKS — a NUL is a perfectly good string separator, so all 95
tests passed and `tsc` was clean. But `file` reports the source as `data`, not
text, and `grep` says:

    Binary file identity-capability.ts matches

So the file silently drops out of every text-based search, `git diff`, and code
review tool. A security grep over the package would skip it entirely. No test
can detect this; only tooling behaviour reveals it.

I found it by accident, because an import-boundary `grep` printed the "Binary
file" line instead of matches.

## Detect

```sh
file packages/**/src/*.ts            # anything reporting "data" is suspect
tr -cd '\000' < FILE | wc -c         # exact NUL count; do NOT use grep -c $'\x00'
```

`grep -c $'\x00'` is a BAD probe: bash strips the NUL, the pattern becomes
empty, and it matches every line — reporting a huge bogus count.

## Fix: byte level, nothing else works

Three string-level attempts all failed:
- The Bash tool REJECTS a command containing a literal control character
  ("command contains control characters that would be hidden in the approval
  dialog").
- The shell collapsed `\\u0000` back into a raw NUL twice, so `String.replace`
  kept writing the byte straight back.

What worked — operate on a Buffer and never name the byte in shell text:

```js
const b = fs.readFileSync(p);
for (let i = 0; i < b.length; i++) if (b[i] === 0) b[i] = 124;  // 124 = "|"
fs.writeFileSync(p, b);
```

Then confirm: `file` should report "JavaScript source ... text", and re-run
typecheck plus tests.

Pick a delimiter the value charset forbids — `|` works when ids are
`[A-Za-z0-9._-]`.
