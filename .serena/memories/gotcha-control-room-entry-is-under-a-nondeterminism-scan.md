# Gotcha: `apps/control-room/src/main.tsx` is under a nondeterminism source scan

Hit 2026-08-09 on `task-a62e3c2d`, whose approved plan asserted that `main.tsx`
"is outside `src/performance/**` and is therefore the one production module
permitted to read a real time API." It is not.

`apps/control-room/src/scaffold.test.tsx`:

```ts
const modules = ["./fixtures.ts", "./kernel.tsx", "./main.tsx"] as const;
const nondeterminism = /Date\.now|Math\.random|new Date\(\)/u;
// asserts nondeterminism.test(source) === false for each
```

So the app entry point — the natural composition root for a clock, a seed, or an
id generator — refuses three of the obvious ways to build one. **`scaffold.test.tsx`
is not owned by surface tasks**, so widening it is unowned-scope creep.

## The way through

`performance.now()` is not in that regex, and for a *composition root supplying a
clock* it is the better choice anyway, independent of the ban:

- it is **monotonic**, so an NTP correction cannot step it backwards mid-command;
- a wall clock that jumps backwards turns an ordinary wait into a negative
  interval, which makes a UI claim it cannot measure something it was measuring
  perfectly well.

Use it, and **say in the step note that you know it sidesteps the tripwire and
why** — otherwise it reads as gaming an incomplete ban rather than picking the
right API. `Math.random` has no equivalent escape; a seed must be injected.

## Check this before planning, not after

Two independent source scans bind this package and they have **different module
lists and different rules**:

| scan | covers | forbids |
|---|---|---|
| `scaffold.test.tsx:234` | `fixtures.ts`, `kernel.tsx`, `main.tsx` | `Date.now`, `Math.random`, `new Date()` |
| `recovery/recovery-import-ban.test.ts` | `src/doctor` + `src/recovery` | unlisted import specifiers, a 16-token identifier list, new files in the directory |

`grep -rn "readFileSync\|readdirSync" apps/control-room/src` enumerates every such
guard in one command — `src/data`, `src/board`, `src/evidence`, `src/shell` and
`src/recovery` each carry one. **No scan enumerates the app-root `src/` itself**,
which is why adding a new directory (`src/a11y/`, `src/performance/`) is safe while
adding a file to `src/recovery/` is not.

Related: `mem:pattern-import-ban-scans-specifiers-not-text`,
`mem:gotcha-boundary-test-greps-prose-not-imports`.
