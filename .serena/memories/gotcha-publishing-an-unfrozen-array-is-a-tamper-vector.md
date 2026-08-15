# Do not publish an unfrozen array that production code reads on every call

Found while curating the `@moe/runner` root seam (task-53680e91, commit 9bfaa3b).

`packages/runner/src/supervisor/effect-shape.ts` declares its vocabularies two
different ways, and the difference is load-bearing:

```ts
export const MIRRORED_LEASE_KINDS = Object.freeze([...] as const);  // frozen
export const MIRRORED_LEASE_KEYS  = [...] as const;                 // NOT frozen
```

`as const` is a TYPE-level guarantee only. At runtime `MIRRORED_LEASE_KEYS` is an
ordinary mutable array, and `parseMirroredLease` / `parseMirroredProof` read it
through `exactRecord` on EVERY call. Re-exporting it from the package root would
hand any consumer a live handle on the parsers' own key list: setting
`.length = 0` breaks every mirror fence in the process. TypeScript's `readonly`
tuple type stops the honest caller and nothing else.

## Rule

Before putting a `const` array on a package's public surface, check whether it is
`Object.freeze`d. If it is not, either freeze it (only if you own that file) or
leave it internal. Prefer publishing a BEHAVIOURAL assertion over the data: an
exact-own-key contract is better proven by
`expect(parseMirroredLease({ ...LEASE, extra: 1 })).toBeNull()` than by
republishing the key list and asserting its contents.

## Why it bit here specifically

A re-export-only task cannot fix it: freezing the array is an edit to a
supervisor module, which the task rails forbid. So the only move available was to
narrow the seam. That is the general shape — the cheapest fix for "this symbol is
unsafe to publish" is usually "do not publish it", and the decision belongs in a
comment at the seam so the next person does not re-add it.

Related: `mem:gotcha-workspace-exports-map-is-exclusive`,
`mem:convention-hostile-shape-reads-in-pure-kernels`.
