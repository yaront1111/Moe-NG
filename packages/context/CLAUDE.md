# @moe/context

The sealing kernel for everything a provider seat is allowed to read. It picks items against
a byte budget, renders them to exact bytes, and seals both under a canonical SHA-256 manifest,
so a launch can later prove the bytes it is about to send came out of *this* renderer. It also
owns the dead-end journal and the typed retry predicate that keeps a seat from re-running a bug
it already hit. It reads no store, takes no clock, mints no authority, and declares no
dependencies — every input is handed to it and every output is deep-frozen.

## Seams

- The export map is `"." : "./src/index.ts"` and nothing else. `src/index.ts` is four
  `export *` lines: `context-contract`, `context-render`, `context-selection`,
  `dead-end-journal`. `canonical-digest.ts` and `context-wire.ts` are **absent from the
  barrel on purpose** — they are package-private. `apps/daemon/src/bootstrap/
  bootstrap-policy-authority.ts` writes its own `canonicalJson` rather than widen this
  package's surface, and says so in a comment (which still reads "five `export *` lines",
  stale since `release-handoff.ts` was deleted).
- `selectContext(input)` → `ADMITTED | REFUSED`. The one production caller is
  `apps/daemon/src/work/foundation-context-selection.ts`; the items it selects over are
  projected by `foundation-context-matrix.ts`, which imports only the item *types*.
- `renderContext(selection)` → `{ bytes, manifest }` and `digestContextManifest(binding)`.
  Callers: `work/foundation-context-prelaunch.ts` (renders exactly once, then re-reads),
  `work/launch-template-authority.ts` (`admitRenderedContext`), and
  `work/foundation-context-manifest-codec.ts` (recomputes the inner digest, never trusts it).
- `createDeadEndJournal(entries)`, `evaluateRetryUnlock(previous, candidate)`,
  `DEAD_END_KINDS`, `DeadEndJournalEntry`, `FactPredicate`. Callers:
  `apps/daemon/src/journal/{journal-append,journal-reader,journal-entry-codec}.ts` and
  `packages/scheduler/src/convergence/{breaker,breaker-contract,failure-fingerprint}.ts`.
- Exactly two manifests depend on it: `apps/daemon/package.json` and
  `packages/scheduler/package.json`. Its own importer line in `pnpm-lock.yaml` is
  `packages/context: {}` — keep it that way.

## The model

- **Refuse, never trim.** `selectContext` answers `INVALID_CONTEXT_BUDGET` for a budget that
  is not a non-negative safe integer, and `CONTEXT_TOO_LARGE` when the mandatory items alone
  exceed it. Both carry `layer: "CONTEXT_SELECTION"`; a refusal never carries a partial
  `selection`. `foundation-context-selection.ts` forwards both code *and* layer verbatim under
  `source` rather than restamping them.
- **The budget is measured over canonical JSON, not over content.** `renderedItemByteLength`
  runs the *whole item* through `encodeCanonical` (keys sorted by `compareCodeUnits`), so key
  names, quotes, `kind` and `priority` all consume budget, plus one separator byte per item
  boundary. `renderSelectionBytes` joins the same encodings with `"\n"`, which is why
  `selection.selectedBytes === rendered.bytes.length`.
- **Optional fill is greedy and stops dead.** Candidates sort priority-descending, then id /
  section / content ascending; the loop `break`s at the first candidate that would overflow —
  it does not skip ahead to a smaller one. Excluded ids are dropped before the fit test.
- **Ordering is published, not implied**: `CONTEXT_ORDERING`
  (`MANDATORY_ID_SECTION_CONTENT_ASC_OPTIONAL_PRIORITY_DESC_ID_SECTION_CONTENT_ASC`) travels
  inside the selection and is one of the digest-bound fields.
- **Seven bound fields, no more.** `ContextDigestBoundField` is the roster:
  `optionalSelection`, `journalCountLimit`, `journalTextLimit`, `ordering`, `rendererVersion`,
  `exclusions`, `exactBytes`. `context-pipeline.test.ts` mutates each one and asserts the
  digest moves. Nothing about project, node, attempt or epoch is bound here — that is the
  daemon's outer `recordDigest` in `foundation-context-manifest-codec.ts`.
- **Canonical encoding frames its numbers.** `-0`, `NaN`, `Infinity` encode as
  `{"$number":"-0"}` and friends, so `-0` and `0` seal differently. Anything
  `encodeCanonical` cannot express (`undefined`, `bigint`, function, symbol) **throws**
  `TypeError: Unsupported canonical value type`.
- **Journal order is total and explicit**: `occurredAt`, then `id`, then
  `canonicalSha256(entry)` as the last tiebreak; the digest is taken over
  `{ version, entries }` after sorting, so insertion order cannot move it.
- **A reworded dead end stays locked.** `evaluateRetryUnlock` compares
  `canonicalSha256(predicate)` on both sides and answers `RETRY_PREDICATE_UNCHANGED` /
  `RETRY_PREDICATE` — prose is not evidence. `packages/scheduler` binds its
  `RetryPredicateRefusal` to `Extract<RetryUnlockResult, { kind: "REFUSED" }>` so a change to
  that code or layer breaks the scheduler's types rather than drifting.
- **Every returned value is `deepFreeze`d** (`Reflect.ownKeys`, stopping at an already-frozen
  node), and entries/predicates are cloned first, so a caller mutating its own input after
  admission cannot reach inside the journal.

## Gotchas

- **Nothing here validates shape.** `cloneEntry` *spreads* the caller's entry, so a stray key
  survives into the journal and into its digest; `clonePredicate` returns `undefined` for an
  unknown `kind`, and `canonicalSha256` then throws — a crash, not a refusal. The strict
  decoder is `apps/daemon/src/journal/journal-entry-codec.ts`, and it deliberately reads
  `DEAD_END_KINDS` and `FactPredicate` off this package instead of retyping them. Any new
  caller needs its own fence before it reaches `createDeadEndJournal`.
- **`MAX_JOURNAL_TEXT_CHARACTERS` (12 KiB) is a total across all entries**, not a per-entry
  cap — `createDeadEndJournal` sums `entry.text.length`. Eight entries share one budget.
  The comment at `apps/daemon/src/work/foundation-context-manifest-codec.test.ts:588` reasons
  as if it were per-entry (`8 * 12,288`).
- **The journal limits are bound into the *context* digest.** `journalCountLimit` and
  `journalTextLimit` come from `MAX_JOURNAL_ENTRY_COUNT` / `MAX_JOURNAL_TEXT_CHARACTERS`, so
  bumping either constant changes every context manifest digest and every already-persisted
  foundation context record stops recomputing (`FOUNDATION_CONTEXT_MANIFEST_DIGEST_MISMATCH`).
- **Three bare layer literals, all censused.** `CONTEXT_SELECTION`, `DEAD_END_JOURNAL` and
  `RETRY_PREDICATE` are written inline at the refusal sites, not declared as `*_LAYER`
  constants, so they live in `UNRESOLVED_LAYER_LITERALS` in
  `tests/security/layer-visibility-cases.ts` under `EXPECTED_LITERAL_COUNT = 106` /
  `EXPECTED_UNRESOLVED_LITERAL_COUNT = 37`. A new refusal layer here reds the TASK-LV arms:
  re-measure and move the pins, never widen the matcher.
- **Every module needs its sibling `.js` bridge** (six exist today; `index.ts` itself imports
  `"./context-contract.js"`). Vitest rewrites those specifiers back to `.ts`, so no in-package
  suite notices a missing bridge — `runtime-entrypoint.test.ts` and
  `tests/runtime/package-loadability.test.ts` spawn a real `node --experimental-strip-types`
  child, and they are what goes red.
- **`DEFAULT_CONTEXT_BYTE_BUDGET` has no production caller.** The real budget is the provider's
  `CONSERVATIVE_INPUT_BYTES.bytes`, read in `foundation-context-matrix.ts`; only daemon tests
  and fixtures import the default. Do not wire it in as a fallback.
- `canonicalSha256` uses `node:crypto` and `tsconfig.json` sets `types: ["node"]` — this
  package is Node-only and must not be pulled into browser code.
- `release-handoff.ts` was deleted as dead code in `65f73a0c` and the census moved 108 → 107 /
  39 → 38 with it. Do not resurrect `RELEASE_HANDOFF`.

## Testing

- Whole package: `pnpm --filter @moe/context test` — the script is
  `vitest run --root ../.. packages/context/src`, so it runs under the **root**
  `vitest.config.ts` (node environment, forks pool, bounded workers).
- One file, from the repo root: `pnpm vitest run packages/context/src/dead-end-journal.test.ts`.
- Types: `pnpm --filter @moe/context typecheck`.
- Four suites: `context-pipeline.test.ts` (admission, exclusions, the seven bound fields, key
  reordering and `-0`), `context-adversarial.test.ts` (NaN/Infinity/negative/fractional budgets
  and content-boundary framing), `dead-end-journal.test.ts` (limits at exactly the boundary,
  total order, post-admission mutation), `runtime-entrypoint.test.ts` (child-Node import probe).
- Outside coverage, all of it load-bearing: `pnpm --filter @moe/daemon test` for
  `src/journal/**` and `src/work/foundation-context-*`; the root suite for
  `packages/scheduler/src/convergence/**` plus `package-boundary.test.ts`, which pins the
  scheduler's declared deps to exactly `["@moe/context", "@moe/contracts", "@moe/core"]`;
  `pnpm test:security` for the layer census; and
  `tests/integration/release/release-version-surfaces.test.ts`, which pins
  `packages/context/package.json`.
