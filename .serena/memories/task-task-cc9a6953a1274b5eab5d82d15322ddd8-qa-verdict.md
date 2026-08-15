# QA verdict: @moe/control-room-client (commit 9583ab6) — APPROVED

Verified by qa-813cd351. Every gate re-run in the foreground from disk, nothing
taken from the worker's summaries.

## Evidence

| check | result |
| --- | --- |
| `pnpm --filter @moe/control-room-client typecheck` | exit 0 |
| `pnpm --filter @moe/control-room-client test` (run twice) | exit 0, 25/25 both runs |
| `pnpm --filter @moe/control-room-client generate` then `git status --porcelain -- packages/control-room-client` | EMPTY — regeneration is a working-tree no-op |
| independent registry count vs generated file | 92 command builders / 16 query builders / 38 error rows — exact match to `RUNTIME_COMMAND_KINDS` / `RUNTIME_QUERY_KINDS` / `RUNTIME_ERROR_CODES` |
| `grep -rnE "Date\.now\|Math\.random\|process\.env\|os\.EOL\|new Date" packages/control-room-client/` | zero hits |
| repo `pnpm typecheck` / `pnpm test` | RED — foreign only, see below |

DoD 2 is enforced structurally, not just by the gate function: `src/index.ts`
exports exactly one value (`createCompatGate`, asserted by
`client-compat.test.ts:122`) and `package.json` `exports` has only `"."`, so
there is no deep-import path to `generated-client.ts` from another package. The
refusal object carries only `{error, ok}`, prototype is `Object.prototype`, and
is deep-frozen. Malformed-report matrix covers null/string/array/{}/missing
key/extra key/wrong-typed range/each pin flipped/digest flipped/empty sourceSha.

## Foreign-work attribution (do not re-diagnose)

Repo gate red is entirely `packages/mcp/src/http/` — `git status` reports it as
`??` (UNTRACKED). A concurrent worker's TDD-red state: `http-session.test.ts`
exists, `http-session.ts` does not (`TS2307`). Zero overlap with owned paths.
Everything else: 89 test files passed, 1220 passed / 1 skipped.

## LOC ruling (precedent for the next generated-package task)

+1814 / 10 files, well over the 400-net-LOC reject bar, APPROVED anyway. The
breakdown is what makes it defensible, so state it this way in the completion
message: 886 generated (`CONTRIBUTING.md:7` — "Generated files are exempt"), 373
tests, 26 config, 6 lockfile, leaving 523 handwritten production — and ~175 of
`generate.ts`'s 337 lines are the emitted static `HEADER` template (data, not
logic). Every module sits below the 400-line rail. Contrast
`mem:gotcha-core-aggregate-loc-bar`, where a +3116 core aggregate was rejected on
size alone: the difference is that here the bulk is machine-emitted and
regenerable, not hand-maintained branching logic.

## Design calls I checked and accepted

- Refusal is a local `CompatRefusalError`, not a `RuntimeError`.
  `createRuntimeError({code:"DISTRIBUTION_MISMATCH"})` would silently degrade to
  `UNKNOWN_ERROR` (`mem:gotcha-create-runtime-error-requires-source`); faking a
  PROJECT source to satisfy it would invent daemon truth. `truthClass:"OBSERVED"`
  is the honest label for a client-side string compare.
- No event-stream frame vocabulary. Confirmed no domain-event type exists in
  `@moe/contracts`; the deferral is stated in the emitted header (boundary 5)
  rather than papered over with an invented shape.
- The structural-typing residual (TS cannot prove an affordance came from
  `buildNextAllowedCommands`) is documented in the header, not claimed away.

See `mem:task-task-cc9a6953a1274b5eab5d82d15322ddd8-handoff`.
