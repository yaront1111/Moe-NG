# Sharing a fixture corpus across packages without a dependency

Established by `task-5ff2b39df70c4451ae07a44c92935b42` (Claude runtime adapter).
The Codex adapter (`task-a0fa6da4`) and any future provider adapter should copy
this rather than re-deriving it.

## The problem

A package test cannot import fixtures from a sibling package's `src/`. Each
package typechecks with `composite: true` + `rootDir: "src"`, so a relative
import of a file outside that root fails the package's OWN `typecheck` gate.
Adding a workspace `devDependency` instead costs three touches outside owned
paths (the package.json, the lockfile, the sibling's `index.ts` — the exports
map blocks deep subpaths). See also `mem:gotcha-cross-package-relative-imports-from-tests`,
which covers the different root-`tests/` case.

## The pattern

The OWNING package commits the corpus as **one JSON document inside a template
literal**, delimited by two marker comments that are ALSO exported as string
constants:

```ts
export const X_CORPUS_DATA_BEGIN = "moe-<name>/1 DATA BEGIN";
export const X_CORPUS_DATA_END = "moe-<name>/1 DATA END";

/* moe-<name>/1 DATA BEGIN */
const CORPUS_JSON = `{ "corpusVersion": "...", "cases": [ ... ] }`;
/* moe-<name>/1 DATA END */
```

The consuming package's test `readFileSync`s the module, `lastIndexOf`es both
markers, slices between the backticks, and `JSON.parse`s. `lastIndexOf` (not
`indexOf`) is what makes the exported constants and the delimiters coexist.

## The two rules that make it safe

1. **Per-case `sha256` is over the RAW DECODED BYTES, never over canonical
   JSON.** The consumer then needs only a sha256 implementation. Pinning the
   canonical-JSON digest instead would force two independently-written
   canonicalizers (runner's `canonicalJson`, testkit's `canonicalize`) to agree
   byte-for-byte forever — a latent trap in a cross-package gate. Corpus-level
   stability stays in-package as a separate pinned constant.
2. **The owning package's own test performs the SAME extraction** and asserts
   each marker appears exactly twice in its own source. That way the interchange
   contract is exercised from the producing side before anything depends on it.

Both sides re-verify every fixture digest at module load and THROW. Verified by
red-team: flipping one nibble of a pinned digest fails both suites with
"Tests no tests" — the refusal lands before any assertion consumes the fixture.

## Base64 is mandatory, not stylistic

`.gitattributes` line 1 is `* text=auto eol=lf`. A committed text fixture
containing `\r\n` is silently normalised on the way in and its pinned digest
then never matches. Base64 is inert under that normalisation and needs no
attributes edit. Keep at least one CRLF-bearing fixture and assert the 0x0D 0x0A
pairs, so this stays a tested property instead of a comment.

## Do not export the corpus from the package `index.ts`

`index.ts` is usually outside an adapter task's owned paths, and staying off the
public entrypoint also keeps the corpus away from the raw-node entrypoint smoke
worker — so no `.js` shim is required (see `mem:gotcha-scheduler-js-shims`).
