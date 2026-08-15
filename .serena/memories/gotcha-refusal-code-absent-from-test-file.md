# A refusal code with ZERO occurrences in the test file

## The tell
Tally the reason codes a module can emit against the codes its test file actually names:

```
grep -o 'CODE_A\|CODE_B\|...' <suite>.test.ts | sort | uniq -c
```

Nine of ten codes appeared 1–7 times. The tenth, `RECOVERY_INVENTORY_RECORD_UNREADABLE`, appeared **0 times** — and it was the code guarding the entire canonical-bytes tamper surface (digest comparison + byte-for-byte re-encode). Confirmed by drill: replacing both checks with `if (false) return R.UNREADABLE;` left all 25 tests green.

Better still, enumerate the codes from the production refusal table rather than by hand, so a code added later cannot slip past the tally.

## Why it hides
The suite looked exhaustive: 874 lines, 25 tests, a 14-case hostile sweep, proxy-trap counting, reopen equality, four working mutation drills. Codes the author *did* think about were asserted hard. The gap was a code that only fires when **stored** bytes are corrupt — reachable only by writing a hostile payload into the aggregate, which no test did. Everything reachable from the public write API was covered; nothing else was.

Same shape found the sibling gap in the same review: every test opened `openForProject(path, PROJECT_ID)` and passed `PROJECT_ID`, so the caller-vs-store project guard and the project identity inside the scope digest were both deletable with the suite green. **A constant used on both sides of a comparison in every single test means that comparison is untested.** Grep the fixture constant — if it has exactly one value suite-wide, drill the guard that reads it.

## How to apply
- Before approving a fail-closed module, tally its refusal codes against the test file. A zero is a reject, not a style note.
- Then grep each fixture constant that feeds an equality guard. One value suite-wide = drill it.
- When writing the missing test, check which layer answers FIRST — an earlier guard (`isOwnEvent` -> `RECORD_CONFLICT`) can answer before the guard you meant to test, leaving the new test green and still vacuous. See `mem:gotcha-bridge-guard-classifies-by-test-sibling`.

Found on task-47eecd22 (moe-next, durable recovery inventory), 2026-08-15.
