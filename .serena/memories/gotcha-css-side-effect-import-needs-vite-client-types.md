# Gotcha: a bare CSS import in `apps/control-room` fails tsc with TS2882

> **STALE AS OF 2026-08-09 — DOES NOT REPRODUCE. Do not add the workaround below
> to new code.** Verified: `apps/control-room/src/shell/frame.tsx:6` imports
> `"./shell-layout.css"` and `src/approvals/approval-detail-plan.tsx:8` imports
> `"./approval-layout.css"`, **neither carries a `vite/client` reference**, and
> `pnpm --filter @moe/control-room typecheck` exits **0** — re-run after
> `rm node_modules/.cache/control-room.tsbuildinfo` so `composite: true` could
> not mask it with a cached tsbuildinfo. App config is still
> `types: ["node"]`, base is `moduleResolution: NodeNext`, and there is no
> `vite-env.d.ts` or `declare module "*.css"` anywhere in source.
>
> So a bare CSS side-effect import needs **no** ceremony today. Adding the
> triple-slash reference "just in case" is a net negative — see the trap
> section: it is invisible to import-ban scans.
>
> **But do NOT strip the existing one from `board/board-surface.tsx:1`.**
> `board/goals-board-ban.test.ts:118` asserts the extracted type-reference set
> `toEqual(["vite/client"])` for its scanned modules, so removing it reddens
> that test. It is pinned, not vestigial.
>
> The rest of this note is kept for the type-reference-hole insight, which is
> still correct and still worth applying to any new import allow-list.

---

## Original note (mechanism no longer observed)


`import "./board-layout.css";` inside a `.tsx` under `apps/control-room` fails
`pnpm --filter @moe/control-room typecheck`:

```
error TS2882: Cannot find module or type declarations for side-effect import of './board-layout.css'.
```

The app's `tsconfig.json` sets `"types": ["node"]`, so the `*.css` module
declarations that ship in `vite/client` are never loaded. There is no
`vite-env.d.ts` in this app.

## Fix that stays inside one owned file

Put a triple-slash reference at the very top of the importing module:

```tsx
/// <reference types="vite/client" />
import { useRef, useState } from "react";
```

`vite` is already a devDependency of `@moe/control-room`, so the types resolve.
This avoids adding a shared `vite-env.d.ts` (which would be outside a
board/goals-scoped task's owned paths) and avoids editing `tsconfig.json`.

## The trap it opens

A `/// <reference types="..." />` is invisible to the usual import-ban scan,
which only matches `import ... from "x"` and `import "x"`. That is a
type-shaped hole: a module could pull in a forbidden package's types without
tripping the guard. If the area has an import allow-list test, extend it:

```ts
const TYPE_REFERENCE = /\/\/\/\s*<reference\s+types="([^"]+)"/gu;
// assert the extracted set equals exactly ["vite/client"]
```

`apps/control-room/src/board/goals-board-ban.test.ts` does this.

## Related

Vitest does not need the CSS import to resolve to anything (default
`css: false` stubs it), so the tests were green while tsc was red — run the
typecheck, not just the suite.
