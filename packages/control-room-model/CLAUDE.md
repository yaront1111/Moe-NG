# @moe/control-room-model

The presentation half of the control room, kept in a package that *cannot* reach authority:
no dependencies at all (`pnpm-lock.yaml` records `packages/control-room-model: {}`), no
`node:` import in any production module, no React, no fetch, no credential. Two unrelated
kernels live here — the truth-class descriptor table and the product-workspace fold — and
both exist so the UI has somewhere to interpret daemon-supplied records without being able
to *compute* a verdict the daemon did not commit.

## Seams

- Export map is `.` → `./src/index.ts` only; no subpaths. Exactly five runtime exports,
  pinned as a sorted list by `src/package-root.test.ts`: `buildProductRequirements`,
  `describeTruthClass`, `sameProductContract`, `sameProductScope`, `selectProductArtifact`.
- `describeTruthClass(input: unknown)` has one caller in the repo:
  `apps/control-room/src/v2/truth-class.ts` (`sayWho`), which `TruthChip` renders.
- The product-workspace four are consumed by `apps/control-room/src/v2/workspace/`:
  `product-model-adapter.ts` (the composer), `product-model-artifacts.ts`,
  `product-artifact-history.ts`, `product-artifact-identity.ts`, `product-action-context.ts`,
  `live-product-definition.tsx`, and `fixtures/fixture-product-data.ts`.
- The types in `src/product-workspace/contracts.ts` are the vocabulary of
  `apps/control-room/src/v2/workspace/product-model-contracts.ts`
  (`ProductWorkspaceInput` / `ProductWorkspaceModel`).
- `TruthClass` is re-declared here as a literal union rather than imported from
  `@moe/contracts` (`RuntimeTruthClass`). That duplication is what keeps the dependency list
  empty; the five tokens are hand-mirrored in `src/truth-presentation.test.ts`.

## The model

- `describeTruthClass` is a bare `switch` over the primitive value — no coercion, no property
  access, no fallback. Five frozen module-level results plus one frozen `INVALID_RESULT`, all
  returned **by identity**: `describeTruthClass("OBSERVED") === describeTruthClass("OBSERVED")`
  is asserted with `toBe`, and every invalid input returns the *same object*.
  `src/hostile-input.test.ts` proves proxy traps never fire (`trapCount === 0`) and that
  revoked object/callable proxies do not throw.
- One refusal code in the whole package: `TRUTH_CLASS_INVALID`, and it carries **no layer**.
  Distinguishing absent from malformed is the caller's job — `sayWho` maps `null`/`undefined`
  to origin `ABSENT` *before* calling in, and only malformed reaches `INVALID`.
- The descriptor is presentation the shipped UI does not render. `truth-class.ts` re-maps every
  class to its own glyph, tone var and border (`AGENT_REPORTED` is dashed there, `solid` here;
  `UNKNOWN` is dotted there, `dashed` here). The only field that survives into the DOM is the
  `cr.chip.<class>` grammar — and `truth-chip.tsx` recomputes it as
  `` `cr.chip.${shown.truthClass.toLowerCase()}` ``, never reading `descriptor.chipTestId`.
- Everything in `requirement-links.ts` folds through `applies()`: same scope (all four of
  `connectionId`, `projectId`, `goalId`, `plane`), same contract ref (all four fields, and a
  `null` on either side is a refusal), exact `planningRunRef`, exact `graphContentHash`. A
  `null` input field never matches anything.
- Only checks whose `sha` equals `input.sha` are credited. A check on other bytes yields
  `NEEDS_CHECKING_AGAIN`, never `PASSED`; `input.sha === null` credits nothing and the label
  becomes `No candidate selected; N criterion checks defined`.
- **A repeated `criterionId` poisons both requirements.** `buildProductRequirements` counts
  occurrences first and, for any id seen more than once, evaluates the criterion against
  `{ ...input, availability: "UNREADABLE" }` — so both rows come back `UNKNOWN` rather than one
  arbitrarily winning.
- Readiness counts a de-duplicated `Map` keyed by `criterionId`, not the flat criteria array, so
  `total` is criterion identities and the label names that denominator in words. The model is
  typed `advisoryOnly: true` as a literal — it offers no command, per the AGENTS.md rule.
- `selectProductArtifact` retains the selection as an *identity*. An id matching nothing, or
  matching a non-`PRESENT` artifact, returns `status: "UNAVAILABLE"` with `selectedId` intact —
  the view never silently re-points at another version. Ambiguity is refused too:
  `matches.length === 1`, so two artifacts sharing an id resolve to `null`.
- Every returned value is `Object.freeze`d, and nested `scope` / `contractRef` are copied and
  frozen on the way out, so a caller cannot mutate its way back into the input.
- `docs/plans/2026-09-13-prd-to-product-workspace-engineering.md` ("Pure presentation model")
  proposes `readiness.ts` and `workspace-model.ts`. Neither exists: readiness is computed inside
  `requirement-links.ts`, and composition lives in the app's `product-model-adapter.ts`.

## Gotchas

- Only three `.js` bridges exist, beside the three value modules. `contracts.ts` has **no**
  `contracts.js` because every import of it is `import type`, and `index.ts` has no `index.js`
  because the export map points Node at `./src/index.ts` directly. Give `contracts.ts` a runtime
  export and you must add the bridge.
- All five test files import the package **by its own name**. There is no
  `node_modules/@moe/control-room-model` symlink outside `apps/control-room/node_modules`; it
  resolves through package *self-reference* off this `package.json`'s `exports` map. Rename or
  drop `exports` and every test and the smoke worker fail to resolve while `tsc` stays green.
- `src/truth-presentation.test.ts` hand-mirrors all five descriptors byte for byte, including the
  composed `ariaLabel` strings. Editing one `meaning` means editing that sentence twice.
- The package declares no `export const *_LAYER`, so it has no row in
  `tests/security/boundary-roster.security.ts` even though `packages` is in its `SCAN_ROOTS`.
  Declaring one moves that lane's cardinality and distribution pins.
- `tests/integration/release/release-version-surfaces.test.ts` pins
  `packages/control-room-model/package.json` in `EXPECTED_JS_MANIFESTS`.
- `control-room-model-entrypoint-smoke-worker.mjs` runs in a worker thread under
  `--experimental-strip-types` and is the only arm that sees a *real* Node resolution of this
  package — vitest rewrites `./x.js` back to `.ts`, so no other suite can see a missing bridge.
  It asserts nine exact fields, including `Object.isFrozen` on both envelopes.
- `tsconfig.json` sets `types: ["node"]`, but no production module here imports `node:`. Keep it
  that way: `apps/control-room` bundles this package into the browser build.
- `src/product-workspace/workspace-model.test.ts` imports `../index.js`, a specifier that only
  resolves because vitest rewrites it. That is safe only while it stays a test file.

## Testing

- Whole folder: `pnpm --filter @moe/control-room-model test` — which is
  `vitest run --root ../.. packages/control-room-model/src`, i.e. the **root** config
  (`environment: "node"`, forks pool). Five files, 55 tests, well under a second; no daemon, no
  store, no on-disk fixtures.
- One file, from the repo root:
  `pnpm vitest run packages/control-room-model/src/hostile-input.test.ts`.
- Types: `pnpm --filter @moe/control-room-model typecheck`.
- The root `pnpm test` gate also runs this folder (its include covers `packages/**/*.test.ts`).
- Outside coverage lives in `pnpm --filter @moe/control-room test` (jsdom, configured in the
  `test` block of `apps/control-room/vite.config.ts`): `src/v2/components/truth-chip.test.tsx`
  and `src/v2/workspace/product-model-adapter.test.ts`, `product-artifact-history.test.ts`,
  `product-initial-selection.test.tsx`, `live-product-workspace*.test.tsx`.
- `tests/e2e/control-room/prd-persistence-boundary.spec.ts` selects
  `cr.chip.${truthClass.toLowerCase()}` in a real browser under `pnpm test:e2e:browser`.
