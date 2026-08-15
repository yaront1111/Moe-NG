# A red boundary scan can blame a clean file

`packages/scheduler/src/package-boundary.test.ts` fails with
`unterminated regular expression source token` and the message names
`apps/daemon/src/daemon-main.ts`. That file is **correct** — clean, committed
(`749eb46`), 93 lines, valid TypeScript. The defect is in the test's own
hand-rolled tokenizer.

## Mechanism

`sourceTokens` has no shebang handling. `daemon-main.ts` line 1 is
`#!/usr/bin/env node` — it is the **only** file with a shebang under all three
scanned roots (`grep -rl '^#!' adapters apps packages` returns exactly 1).

1. `#` and `!` push punctuation tokens; `!` is in `regexPrefixPunctuation`.
2. First `/` → `canStartRegularExpression` true → `readRegularExpression`
   consumes `/usr/` plus flags `bin`.
3. **`readRegularExpression` pushes no token**, so the previous token is still
   `!`.
4. Second `/` → true again → scans `env node` → hits `\n` → throws.

The stale-previous-token reuse is the real bug; the shebang only exposes it.

## Why it is dangerous

The obvious "fix the unparseable file" reading leads to deleting a shebang from
a CLI entrypoint that needs it. Three tasks carried this as "foreign in-flight
red that resolves itself" — it does not; it is committed.

## The worse half

The per-file `catch` at `:299` rethrows, and roots run
`["adapters", "apps", "packages"]`. One throw in `apps/` means the entire
`packages/` half has never been scanned since `749eb46`, and the
`scannedWitness` assertion (`packages/runner/.../effect-test-fixtures.ts`) is
unreachable. Its future green certifies a scan that aborted before the half it
exists to cover — same family as `mem:gotcha-hop-count-scan-roots-narrow-silently`.

## Fix shape (all in the test, none in `daemon-main.ts`)

- Skip a leading `#!` line when `index === 0`.
- Push a token after `readRegularExpression` so regex-prefix state advances.
- Collect per-file failures and assert at the end; add a per-root lower bound on
  `scanned.length`, or a narrowed scan still reads green.

## Reproduction without touching the repo

Copy `canStartRegularExpression` / `readRegularExpression` / the `sourceTokens`
loop verbatim into a temp `.mjs` outside the repo and feed it
`'#!/usr/bin/env node\nimport { resolve } from "node:path";\n'` versus the same
string without line 1. First throws, second parses.
