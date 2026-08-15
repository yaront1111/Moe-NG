# Versioned skill bundle runtime — implementation handoff

Task `task-eca1a82ffa844c679d25a60ad8bd165e` implemented by `worker-4dddabde`.
Commit `f4cdba6`, 9 owned paths, +1412 / -0. New package `@moe/skills`.
Focused gate exit 0 (2 files / 75 passed, 1 skipped). Repo regression green at
61 files / 648 tests.

## Modules

    skill-contract.ts   160  versions, limits, 16 error codes, canonical JSON,
                             sha256, deepFreeze, local guards
    skill-manifest.ts   222  validateSkillManifestBytes — closed schema
    skill-loader.ts     166  loadSkillBundle — read-only, contained, read-once
    skill-snapshot.ts   153  resolveSkillSnapshot, toSkillRendererInput
    index.ts             49  public surface only

## OPEN ITEM — the next task that imports this package owns it

**No `.js` shims and no raw-node entrypoint smoke test ship here.** Deliberate,
recorded in the approved plan. The adapter-wiring task that first imports
`@moe/skills` from a raw-node strip-types path MUST add five one-line shims
(`export * from "./<name>.ts";`) plus a smoke test.

This is not theoretical — I hit it. A `node --experimental-strip-types` probe
against the package failed with:

    ERR_MODULE_NOT_FOUND: .../skill-contract.js
    imported from .../skill-manifest.ts

Vitest resolves `.ts` directly, so all 127 tests pass regardless; neither tsc
nor Vitest will ever catch the gap. See `mem:gotcha-scheduler-js-shims`.

## Design points that must not be "simplified"

- **`contentBase64`, never bytes.** `Object.freeze` on a non-empty Uint8Array
  THROWS TypeError (re-verified empirically). An EMPTY one freezes silently —
  the nastier case, because it also slips past a keys-based allowlist walk
  (`[].every(...)` is vacuously true). Hence the explicit `contentBase64 === ""`
  test for a zero-length file. Defensive-copy getters were rejected too: a
  function-typed value would break the no-function allowlist assertion.
- **Containment needs the trailing `path.sep`.** `realFile.startsWith(realRoot)`
  alone admits a sibling directory (`/x/skills-evil` against root `/x/skills`).
  There is a dedicated test for exactly that.
- **Read-once is structural.** The bytes from the single `readFileSync` are what
  get size-checked, hashed, AND base64-encoded. No re-stat, no second read, so
  no TOCTOU window. Do not "optimise" by re-reading.
- **`snapshotDigest` is computed over the body BEFORE the digest field is
  added**, so it is well-defined and not self-referential.
- **Nothing time- or environment-derived anywhere.** `phase0-evidence-contract.ts`
  `capturedAt` is the tempting WRONG precedent; a test asserts the canonical
  JSON matches no ISO-timestamp regex.

## Authority neutrality is an allowlist, not a denylist

Four frozen key allowlists + a deep walk asserting every node is frozen, has
only allowlisted keys, and holds no function. A denylist of forbidden keys is
unfalsifiable theater. A hostile fixture whose whole file body is a command
envelope must round-trip as base64 while `JSON.stringify(snapshot)` contains
neither "commandKind" nor "leaseAuthority".

Known limit: the walk matches SUBSET, so a node with fewer keys passes. Extra
keys — the real risk — do fail.

## Gotchas hit

- `@moe/contracts` does NOT export runtime-guards. isHex64 / hasExactKeys /
  isSafeByteCount / NFC checking are reimplemented locally in skill-contract.ts.
- Decoded bounded-JSON objects have a NULL PROTOTYPE — use `Object.hasOwn`.
- NFC alone is not enough: `normalize()` PRESERVES lone surrogates. The guard is
  `value.isWellFormed() && value === value.normalize("NFC")`.
- A TS `interface` has no implicit index signature, so it cannot satisfy a
  recursive JSON type (TS2345). `canonicalJson` takes `unknown` and THROWS on
  any unsupported runtime shape rather than letting JSON.stringify emit
  `undefined`.
- Real symlink tests need Developer Mode; `symlinkSync` gives EPERM here. The
  loader takes an injectable fs facade so containment is tested deterministically
  on any host, with `it.skipIf` guarding only the real-symlink case.
- Windows: `import()` of an absolute path needs `pathToFileURL`, else
  ERR_UNSUPPORTED_ESM_URL_SCHEME.

## pnpm-lock.yaml was NOT committed

By the time I committed, the lock carried a foreign `packages/core` entry from a
concurrent task alongside my `packages/skills` entry. Epic rail 3 forbids
capturing another task's work, and the file cannot be split —
`git commit -- <pathspec>` commits WORKING TREE content and ignores a
differently-staged index, while a bare `git commit` is rail-forbidden.

So the 9 source paths were committed and the lock left dirty for its owners.
Nothing breaks: `pnpm install` regenerates it and both gates are green without
it. Escalated to the governor.
