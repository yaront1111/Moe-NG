# Handoff: Runtime contract registry (@moe/contracts runtime/)

Commit `88e92a4`. **QA APPROVED 2026-08-07** (qa-200db8e3). 6 production modules + 6 one-line
`.js` bridges + 2 test files under `packages/contracts/src/runtime/`, reachable only via
`packages/contracts/src/index.ts`.

## Module map

| Module | Lines | Holds |
|---|---|---|
| `runtime-guards.ts` | 84 | `isNonEmptyString`, `isHex64`, `isSafeCount`, `isPlainRecord`, `isSafeArray`, `hasExactKeys`, `parseLeaseAuthority` |
| `runtime-vocabulary.ts` | 140 | version literals, 21 lifecycle tuples, `RUNTIME_AGGREGATES`, command/query/telemetry tuples, `isKnownLifecycleSource` |
| `runtime-affordance.ts` | 138 | `NextAllowedCommand`, `EMPTY_NEXT_ALLOWED_COMMANDS`, `buildNextAllowedCommands`, fresh/historical results |
| `runtime-error-registry.ts` | 186 | 38 codes, `RUNTIME_SAFE_DETAIL_KEYS`, descriptor table, `lookupRuntimeError` |
| `runtime-error-factory.ts` | 104 | `RuntimeError`, detail sanitization, `createRuntimeError` |
| `runtime-envelope.ts` | 212 | `decodeRuntimeCommandEnvelopeBytes`, `decodeRuntimeQueryEnvelopeBytes` |

Guards are intentionally NOT re-exported from the package root. Import them via
`./runtime-guards.js` inside the package; do not widen the barrel.

## Decisions the design left open (don't re-litigate silently)

- Version literals chosen: `moe-runtime-command/1`, `moe-runtime-query/1`,
  `moe-runtime-error-registry/1`.
- **Three** disjoint operation tuples, not two: `presence.ping` is TELEMETRY, in neither
  the command nor the query envelope (design 12.1/12.3 gives it a smaller envelope).
- **Boundary codes declare zero `validSources` and must be raised WITHOUT a `source` key**
  (`INPUT_INVALID`, `INPUT_LIMIT_EXCEEDED`, `SCHEMA_VERSION_UNSUPPORTED`,
  `AUTHENTICATION_FAILED`, `CAPABILITY_DENIED`, `SESSION_*`). Every other code requires a
  known lifecycle source whose aggregate is listed, else it degrades to `UNKNOWN_ERROR`.
  This asymmetry is what lets the ingress decoders raise real codes before any aggregate
  is identified. Passing a source to a boundary code degrades it — that is deliberate.
- `RuntimeError` has **no `message` field**, by design: it removes the last channel
  through which input bytes could be echoed. Don't add one.
- `lease.renew` is absent because section 17's surface list omits it (12.2 prose mentions
  it). `session.renew` / `work.renew` / `resource.renew` exist. Add it only via a design
  ruling, not by assumption.
- Detail sanitization is double-gated: per-code key allowlist AND a bounded safe-scalar
  value regex `/^[A-Za-z0-9._:/-]{1,64}$/`. `/` is included so `supportedSchemaVersion`
  can carry `moe-runtime-command/1`.
- Command decoder checks `schemaVersion` BEFORE the exact key set, so a body missing
  `schemaVersion` yields `SCHEMA_VERSION_UNSUPPORTED`, not `INPUT_INVALID`. Deterministic
  and intentional (plan step 4 ordering); do not "fix" it.

## Counts to assert against if you extend this

92 commands, 16 queries, 1 telemetry = 109 operations, an exact match with design
section 17 lines 986-1005. 38 error codes. 21 lifecycle tuples.

## QA verification actually performed (not just re-read)

- `pnpm --filter @moe/contracts typecheck` exit 0; `pnpm --filter @moe/contracts test`
  exit 0, 6 files / 94 tests.
- Independent script parsed design lines 986-1005 and expanded the `a.b|c|d` forms:
  109 design operations, 109 in the shipped vocabulary, **0 missing, 0 extra, 0 overlap**
  between the command/query/telemetry tuples. `graph.preview`, `events.wait`,
  `presence.ping` are all confirmed non-commands.
- Independent ~60-assertion attack probe against the barrel (not the worker's tests):
  null/undefined/string/number/array/**revoked-proxy** ingress, `__proto__` key, unknown
  key, wrong+future version, partial lease, uppercase/short digest, negative/float
  version, array/null payload, query smuggling `expectedVersion`/`leaseAuthority`/
  `graphRevisionHash`/`commandKind`/`requestDigest`, nested-payload mutation attempt,
  all 38 codes returning zero `nextAllowedCommands`, mismatched/unknown lifecycle source,
  boundary-code-with-source degradation, and secret injection
  (`sessionCredential`/`leaseToken`/stack/SQL/digest) into details. All fail closed.
- Limits re-measured at N and N+1 through the runtime decoder: body 1048576 ok /
  1048577 `INPUT_LIMIT_EXCEEDED`; string 262144 ok / 262145 refused; depth 64 ok / 65
  refused. `details` correctly carries only `{limitBytes, limitName}`.
- Design doc SHA-256 re-hashed = `1D9D1EC9...383191`, matches the epic pin (unedited).
- `git show --stat 88e92a4`: 16 files, all owned paths, +1416/-0, no scratch or generated
  evidence. `git status --porcelain -- packages/contracts` clean.
- Line-count rail: max 250 across all owned `.ts`/`.mjs`; all 6 bridges exactly 1 line.

**Approved with a noted deviation**: +1416 net LOC exceeds QA's 400-LOC oversize
heuristic. Not rejected because the scope is exactly the architect-approved 7-step plan
(no drift), ~491 lines are tests/fixture, the bulk of production is irreducible
declarative tables (38-row registry, 109 operation names), every file honors the epic's
hard per-file rail, and splitting a closed vocabulary or closed error registry across
tasks would leave it half-open — a direct fail-closed rail violation. The governor had
already propagated the plan-sizing lesson to both architects.

See `mem:gotcha-revoked-proxy-guards`, `mem:convention-contracts-250-line-splits`, and
`mem:gotcha-bounded-json-limit-probes`.
