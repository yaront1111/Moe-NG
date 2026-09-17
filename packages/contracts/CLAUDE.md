# @moe/contracts

The bottom of the dependency graph: the closed vocabularies, the byte-level decoders and the
refusal shapes every other package folds over. It has **no dependencies at all** — no
workspace package, no npm package, no `node:` import in any production module — because it
loads in the daemon *and* in the browser bundle (`apps/control-room` imports it in 39 files).
Nothing reads a clock, a filesystem or an env var: every entry point is a pure function over
untrusted input that returns a frozen result and never throws at a boundary.

## Seams

- `exports` is `{ ".": "./src/index.ts" }` — TS source, no build step. `src/index.ts` (267
  lines) is the only published surface; a consumer always writes `@moe/contracts`.
- `decodeRuntimeCommandEnvelopeBytes` / `decodeRuntimeQueryEnvelopeBytes` —
  `apps/daemon/src/http/http-command-ingress.ts`, `daemon-foundation-command.ts`,
  `packages/mcp/src/stdio/stdio-server.ts`, `packages/mcp/src/http/http-tool-bridge.ts`.
- `createRuntimeError` + `RUNTIME_ERROR_CODES` — every daemon refusal site, e.g.
  `mcp-dispatch-port.ts` and `bootstrap/bootstrap-conflict-error.ts`.
- `RUNTIME_COMMAND_KINDS` / `RUNTIME_QUERY_KINDS` / `RUNTIME_LIFECYCLES` —
  `apps/daemon/src/daemon-command-vocabulary.ts`, `packages/mcp/src/stdio/stdio-schemas.ts`,
  `packages/control-room-client/generator/generate.ts`, `packages/core/src/cutover`.
- `buildNextAllowedCommands` / `freshRuntimeResult` / `historicalRuntimeResult` — the
  affordance contract `packages/control-room-client`'s generated builders are written against.
- `decodeBoundedJsonBytes` + `MAX_JSON_*` — used far outside the envelope path
  (`apps/daemon/src/activation/*`, `tests/e2e/foundation/hostile-client.e2e.test.ts`).
- `admitGoalBrief` / `admitGoalSource` — `apps/control-room/src/v2/goals/live-goal-create.ts`
  and `packages/control-room-client/src/goal-with-source-command.ts`.
- `canonicalSessionProofBytes` / `sessionAuthorityCanonicalString` — the daemon's
  `identity/session-authority-protocol.ts` and the browser's `session-key.ts` both sign these.
- `parseProjectConfigurationManifest` (→ `packages/core/src/configuration`),
  `decodeDocumentWorkProposalBytes` (→ `apps/daemon/src/documents`), diagnostics emitter and
  codec (→ `apps/daemon/src/diagnostics`).
- **Not in the barrel:** `distribution/distribution-{parser,verifier}.ts` — only
  `tools/packaging/distribution-{build,startup,inventory}.ts` and
  `tests/security/integrity-hostile-cases.ts` reach them, by relative path.

## The model

- **Refuse by returning, never by throwing.** Every entry point takes `unknown` and returns a
  frozen discriminated union. `createRuntimeError` fails closed to `UNKNOWN_ERROR` /
  `truthClass: "UNKNOWN"` for an unknown code, a mismatched lifecycle source or a non-exact
  key set, and never reflects attacker bytes back.
- **`runtime-error-registry.ts` `ROWS` is the whole error contract**: each row binds a code
  to truth class, retryability, recovery category, a transport binding (`httpStatus` +
  `mcpCode`), its `recoveryCommands`, its `validSources` aggregates, and its
  `requiredDetailKeys`. Details are copied *only* for the keys that row declares, and only
  values passing `SAFE_SCALAR` (`/^[A-Za-z0-9._:/-]{1,64}$/`) or `Number.isSafeInteger`.
  `sourceAccepted` requires a `source` exactly when `validSources` is non-empty, so raising
  a boundary code such as `INPUT_INVALID` *with* a source refuses.
- **`EMPTY_NEXT_ALLOWED_COMMANDS` identity is part of the contract** — tests assert `toBe`,
  not `toEqual`. `buildNextAllowedCommands` is all-or-nothing: one malformed entry, one
  duplicate `commandId`, or an unknown `{aggregate,state}` yields that shared empty tuple
  rather than partial authority. Output is sorted by `` `${commandKind} ${commandId}` ``.
  `historicalRuntimeResult()` returns one shared frozen object — a replay never carries
  current affordances.
- **Three disjoint kind vocabularies**: `RUNTIME_COMMAND_KINDS`, `RUNTIME_QUERY_KINDS`
  (read-only; none may ever become a mutation) and `RUNTIME_TELEMETRY_KINDS`
  (`presence.ping`, neither envelope). `isKnownLifecycleSource` admits a source only when
  aggregate *and* state are both members of the frozen `RUNTIME_LIFECYCLES` map.
- **`bounded-json.ts` classifies input through saved native getters, not `node:util`.**
  `%TypedArray%.prototype[@@toStringTag]`, `.buffer`, `.byteLength`, `.byteOffset` and
  `ArrayBuffer.prototype.byteLength` are captured at module load and applied with
  `Reflect.apply`: internal-slot access cannot tunnel through a Proxy, and shared, resizable
  or detached buffers throw or are refused. Bytes are then **copied** into a fresh snapshot,
  so what the caller mutates afterwards is not what got parsed. Decoded objects are
  **null-prototype and deeply frozen** — read them with `Object.hasOwn`; and
  `parseInteroperableJsonNumber` refuses any number whose decimal spelling does not
  round-trip, plus unsafe integers.
- **The envelope decoders translate exactly three bounded-json codes** into
  `INPUT_LIMIT_EXCEEDED` with `{limitBytes, limitName}` (body / depth / string); everything
  else collapses to `INPUT_INVALID`. `schemaVersion` is checked *before* `hasExactKeys`, so a
  wrong version reports `SCHEMA_VERSION_UNSUPPORTED`, not a shape error. The query decoder
  rejects lease, revision and command-only keys outright: a query cannot smuggle authority.
- **`runtime-guards.ts` detects proxies without a static import**: it reaches
  `process.getBuiltinModule("node:util").types.isProxy` through `globalThis`, invisible to
  bundler analysis, and degrades in a browser to refusing only revoked/hostile objects — the
  hostile-bytes boundary always runs in Node. `isPlainRecord` also refuses arrays, foreign
  prototypes, symbol keys and accessors.
- **Two canonicalisers that look alike and must never be swapped.**
  `sessionAuthorityCanonicalString` caps depth at 8 and refuses non-safe integers; the one in
  `distribution/distribution-contract.ts` does neither, so it accepts inputs that would hash
  differently, and swapping either invalidates every persisted signature. That file's header
  records ten independent per-domain canonicalisers in this repo — deliberately.
- `admitGoalBrief` normalises CRLF→LF, trims, requires `String.isWellFormed()` and caps title
  at 1 KiB / instructions at 32 KiB UTF-8. Its single frozen refusal
  (`GOAL_BRIEF_INPUT_INVALID` / layer `GOAL_BRIEF_CONTRACT`) is re-used by
  `@moe/control-room-client` so that package mints no vocabulary of its own.
- `PROJECT_CONFIGURATION_LIMIT_KEYS` **order is part of the contract** — a stored table is
  compared positionally, so a reordered table is refused, not sorted back, and no key has a
  default: a missing value fails closed.
- A `DocumentWorkProposal` is shaped so it *cannot* express authority: `advisoryOnly: true`,
  `authority: "NONE"`, `truthClass: "AGENT_REPORTED"`, `submissionState: "NOT_SUBMITTED"`.
- Diagnostics redact in `encodeDiagnosticLine`, never at call sites: a secret-looking field
  *name* (`SECRET_NAME` regex) and every host-declared secret *value* go, including inside
  thrown messages and stack frames. Encoding is total — it shrinks a record, never refuses
  it; `admitsDiagnosticLevel` likewise fails open on an unknown threshold.

## Gotchas

- **`src/index.ts` is the one module with no sibling `.js` bridge** — it is the exports
  target. Every other module has one (`export * from "./x.ts";`) and the barrel imports
  `./x.js`. Vitest rewrites `.js` back to `.ts`, so the *only* arm that sees a missing bridge
  is `runtime/runtime-contract.test.ts`, which spawns a `node:worker_threads` Worker under
  `--experimental-strip-types` running `runtime-entrypoint-smoke-worker.mjs`.
- **Adding one string to `RUNTIME_COMMAND_KINDS` reds four suites at once**, by design: the
  hand-transcribed `EXPECTED_COMMAND_KINDS` roster in `runtime/runtime-contract.test.ts`;
  `apps/daemon/src/gates-roster-coherence.test.ts` (set equality against the generated client,
  containment against what the daemon serves); `stdio-schemas.test.ts` in `packages/mcp`; and
  `@moe/control-room-client`, regenerated with its `GENERATED_CONTRACT_DIGEST` golden updated.
- `tests/security/boundary-roster.security.ts` pins `"packages/contracts": 3` against a roster
  of 180 — `PROJECT_CONFIGURATION_REFUSAL_LAYERS`, `DISTRIBUTION_REFUSAL_LAYERS`,
  `DOCUMENT_WORK_PROPOSAL_LAYERS`. A fourth exported `*_LAYER(S)` const reds `pnpm
  test:security`, a lane `pnpm test` and `pnpm typecheck` are both blind to.
- `src/distribution-root-publication.test.ts` exists to prove the *bare specifier* resolves:
  it imports each symbol from `@moe/contracts` and compares tuple **identity** against a
  relative import. It also annotates eleven type-only exports, so
  `pnpm --filter @moe/contracts typecheck` is what catches a type dropped from the barrel.
- `lib: ["ES2024"]`, **no DOM lib**, `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`
  — hence optional envelope/affordance fields built into a `Record<string, unknown>` draft and
  cast at the end, rather than assigned `undefined`.
- `configuration/project-configuration-contract.ts` imports `isCanonicalText` from
  `distribution/distribution-contract.ts`; the two folders are not as independent as they look.
- `tests/integration/release/release-version-surfaces.test.ts` pins this `package.json` by
  path; moving or renaming the manifest reds the release lane.

## Testing

- One file, from the repo root (root `vitest.config.ts`, `environment: "node"`, forks pool
  capped at 8): `pnpm vitest run packages/contracts/src/bounded-json-hostile.test.ts`.
- Whole folder: `pnpm --filter @moe/contracts test` — which is
  `vitest run --root ../.. packages/contracts/src`; there is no package-local vitest config.
- Outside coverage: `pnpm test:security` (`boundary-roster.security.ts`,
  `integrity-hostile-cases.ts` — the only caller of the distribution parser/verifier besides
  `tools/packaging`), `tests/integration/distribution/distribution-packaging.test.ts`,
  `tests/property/schedule/schedule-coverage.test.ts` (folds `RUNTIME_LIFECYCLES`),
  `tests/e2e/foundation/hostile-client.e2e.test.ts` (`MAX_JSON_BODY_BYTES` over a real
  daemon), and `tests/e2e/control-room/session-key-signing.spec.ts`, the only arm proving a
  real browser signs the same `canonicalSessionProofBytes` the daemon verifies.
- Hostile suites hand-pin case counts (`project-configuration-hostile.test.ts`: 63 structure,
  14 field; `distribution-manifest.test.ts`: 13/26/11/20). Re-measure, never widen a matcher.
