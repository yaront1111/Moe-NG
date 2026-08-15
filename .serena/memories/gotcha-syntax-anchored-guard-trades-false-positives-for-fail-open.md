# A guard rewritten from raw-content matching to syntax-anchored matching can fail OPEN

Pattern seen on `packages/scheduler/src/package-boundary.test.ts`. The guard scanned raw file
contents for a forbidden internal path, which matched **prose** and blocked the board. The fix —
correct in direction — replaced it with a token scanner that extracts only quoted module specifiers.

Direction right, completeness wrong. The old scan had zero false negatives on content by
construction. Every shape the new tokenizer does not model becomes a **silent bypass**, and the
suite is green either way. Two escaped here:

1. **Template-literal specifier.** `readTemplate` collected only `${}` expressions and threw away
   the literal text, so `` await import(`../../scheduler/src/authority/private.js`) `` — which
   resolves at runtime — returned `false`. A backtick specifier IS a module specifier; dropping it
   is not the intended "specifiers only" narrowing, it is an incomplete one.
2. **Regex literal poisoning.** No regex-literal lexing, so `const re = /["']/u;` opens a string at
   the `"` that runs to the next quote in the file — swallowing a following
   `import { x } from "…"` whole. Everything downstream of that point is invisible.

## How to review one of these rewrites

Do not read the tokenizer and reason about it. **Probe the production surface.** Append a temporary
`it.each` of adversarial shapes to the guard's own file, run it, restore (backup outside git, `cp`
restore, `trap restore EXIT`, verify `git hash-object`). Shapes worth probing every time:

backtick `import()` / `require()` / `from` · regex literal containing a quote before a real import ·
TS `import x = require()` · `export * from` · `export type { } from` · default import ·
namespace import · bare `require()` statement · multiline import · comment before import ·
both path separators.

Here 6 of 8 were caught; the 2 that were not are exactly the ones no one would have guessed by
reading.

## The tell that makes it a reject, not a note

The worker had added an allowed-case assertion `["template-literal prose", …]` that **pins the
blind spot as intended behaviour**. A defect a future reader will read as a decision is strictly
worse than an unhandled case — it will never be revisited. Epic rail 4 (fail closed) makes silent
`false` unacceptable; the acceptable alternatives are handle it, or throw loudly.

Related: `mem:pattern-qa-verify-a-mutation-drill-instead-of-reading-it`,
`mem:mutation-drills-in-shared-worktree`, `mem:gotcha-scheduler-boundary-test-matches-prose`.
