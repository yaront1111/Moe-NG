# Gotcha: @moe/contracts exports the tuples, NOT the type guards

`packages/contracts/src/index.ts` re-exports the frozen vocabulary tuples
(`RUNTIME_COMMAND_KINDS`, `RUNTIME_AGGREGATES`, `RUNTIME_LIFECYCLES`, …) and the
`BOUNDED_JSON_ERROR_CODES` tuple, but the accompanying runtime guards are
INTERNAL. Not exported:

- `isCommandKind`, `isQueryKind` (runtime-vocabulary.ts)
- everything in `runtime/runtime-guards.ts` — `isHex64`, `hasExactKeys`, … —
  except the `RuntimeLeaseAuthority` *type*

Hit twice: on `@moe/skills` (reimplemented isHex64 / hasExactKeys / NFC check
locally) and again on `packages/core/src/identity` (`isCommandKind`).

## What to do

Build the membership set locally from the exported tuple:

```ts
import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import type { RuntimeCommandKind } from "@moe/contracts";

const COMMAND_KINDS: ReadonlySet<string> = new Set<string>(RUNTIME_COMMAND_KINDS);
function isCommandKind(value: unknown): value is RuntimeCommandKind {
  return typeof value === "string" && COMMAND_KINDS.has(value);
}
```

Check `packages/contracts/src/index.ts` for the symbol before importing it —
do not assume a guard is public just because it exists next to a public tuple.

## The failure mode is nastier than it looks

Under NodeNext, importing a non-exported name yields `undefined` at runtime.
Calling it throws TypeError. If the call site sits inside a broad `try/catch`
in a fail-closed validator, that TypeError becomes a `null` return — so a
BROKEN IMPORT is indistinguishable from "your input is invalid". Ten tests
failed with no useful signal.

Two defences:
1. Run `pnpm --filter <pkg> typecheck` BEFORE the test suite on any step that
   adds a cross-package import. tsc reports TS2305 immediately and names it.
2. Never wrap validation logic in the catch. Guard only the untrusted property
   reads (hostile getters, revoked proxies); let programming errors throw.

See `mem:task-task-5fa383732c674c9ca00b1bc782153916-handoff`.
