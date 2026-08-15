# Gotcha: `pnpm --filter @moe/scheduler test` is red at HEAD on a shebang

Measured 2026-08-09 on `task-cda6bddf`, before any edit: **674 passed, 1 failed**.

```
FAIL packages/scheduler/src/package-boundary.test.ts >
     keeps scheduler registrars behind the package-root import boundary
Error: boundary scan failed for apps\daemon\src\daemon-main.ts:
       Error: unterminated regular expression source token
```

## Cause — two committed files, both innocent-looking

`apps/daemon/src/daemon-main.ts:1` is `#!/usr/bin/env node`, the **only** shebang in
the three scanned roots (`grep -rln "^#!" adapters apps packages` → one hit).

`package-boundary.test.ts`'s tokenizer emits `#` and `!` as punctuation, and `!` is in
`regexPrefixPunctuation`, so the following `/` starts a "regex". `readRegularExpression`
**pushes no token**, so after `/usr/` closes, the last token is still `!` and `/env node`
is scanned as a second regex, hits the newline, and throws.

Shebang landed in `749eb46` (`task-f01ef545`). Scanner was hardened in `de1298a`
(`task-8d198514`, "close boundary parser gaps") — that pass anchored to specifiers and
missed `#!`.

## Why it matters to you

Any task whose gate is `pnpm --filter @moe/scheduler test` **cannot reach exit 0**, and
`complete_task` hard-requires `verification.exitCode === 0`. Global rail 3's
path-attributed baseline covers the *attribution* but does not satisfy that gate.

Submit the owned-scope leg as verification (e.g.
`vitest run --root ../.. packages/scheduler/src/convergence`, exit 0) and disclose the
package-wide exit 1 verbatim with before/after counts. Do **not** silently narrow —
see `mem:gotcha-gate-narrowed-by-exclude-reads-as-green`.

## Fix, when someone owns it
One line: skip a leading `#!` line before tokenizing, **plus** a `forbiddenImportCases`
entry proving a real import after a shebang is still detected — a widened parser that
no longer bites is worse than the red it removed.

Related: `mem:gotcha-scheduler-boundary-test-matches-prose` (the earlier, different
false positive in the same file).
