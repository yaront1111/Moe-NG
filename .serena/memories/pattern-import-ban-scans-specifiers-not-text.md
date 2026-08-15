# A package import-ban must scan SPECIFIERS, not raw text

Confirmed the hard way 2026-08-09 on `task-d99ca771`, writing
`apps/control-room/src/evidence/evidence-timeline-ban.test.ts`.

The obvious implementation, and the one `data-ban.test.ts` uses for identifiers:

```ts
if (text.includes("@moe/store")) offenders.push(...)
```

First run went red on:

```
timeline-contract.ts:@moe/coordination
timeline-contract.ts:@moe/store
```

Those hits were the module's own doc comment **explaining why those two packages are
unreachable**. `mem:gotcha-boundary-test-greps-prose-not-imports`, live. The tempting fix
— delete the comment — is backwards: the comment is the only thing telling the next
author why the ban exists.

## Fix: collect specifiers, then match

```ts
const IMPORT_SPECIFIER = /^\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/gmu;
const DYNAMIC_SPECIFIER = /\b(?:import|require)\s*\(\s*"([^"]+)"/gu;   // text scan misses these

function reaches(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);        // subpath counts
}
```

Strictly stronger than the text scan it replaces: a text scan cannot distinguish
`import("@moe/store")` from prose, and `startsWith(pkg + "/")` catches
`@moe/store/subscriptions`, which a bare-name equality check misses.

## Three assertions worth stealing

1. **Union equality, not subset.** `data-ban.test.ts` only checks each specifier is IN the
   allow-list. Also assert the allow-list contains nothing unused, or a stale over-broad
   entry sits there granting future access.
2. **The allow-list itself cannot be widened.** `expect(ALLOWED_IMPORTS).not.toContain(banned)`
   — otherwise assertion 1 is defeated by adding one line.
3. **Detector liveness.** A sweep reporting zero offenders is indistinguishable from a
   broken detector. Plant a banned static import AND a dynamic one in a string and assert
   both are caught. See `mem:pattern-guard-the-case-list-not-just-the-cases`.

Identifier sweeps can keep using plain `includes` — an identifier in a comment signals
intent to compute and is fair to ban. It is only PACKAGE names that legitimately appear in
prose.

Related: `mem:gotcha-jsdom-url-breaks-import-meta-dirname` (same file needs it),
`mem:gotcha-package-boundary-test-matches-comments`.
