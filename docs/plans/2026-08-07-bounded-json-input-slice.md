# Bounded JSON input slice

Date: 2026-08-07

Base: `e7f2b680fd830c25a4c66cae420bda825fff0792`

Branch: `codex/bounded-json-ingress`

Design input SHA-256:
`1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191`

## Outcome

Add a transport-neutral, fail-closed byte-to-JSON boundary to `@moe/contracts`.
It enforces the design's body, nesting, and per-string limits before any future
HTTP, MCP, command, or graph adapter can treat hostile input as data.

The decoder grants no authority. It performs no schema validation, command
admission, graph activation, persistence, authentication, or external effects.

## Public contract

- `MAX_JSON_BODY_BYTES = 1_048_576`
- `MAX_JSON_DEPTH = 64`
- `MAX_JSON_STRING_UTF8_BYTES = 262_144`
- `decodeBoundedJsonBytes(input: unknown): BoundedJsonDecodeResult`
- A closed immutable success/error result with stable reason codes.

Accepted input is a stable snapshot of an ordinary `Uint8Array` or Node
`Buffer`. Proxies, other views, shared/resizable/detached backing stores, and
untrusted input shapes fail closed. UTF-8 decoding is fatal. The JSON parser
preserves duplicate-key visibility, validates Unicode, rejects non-finite
numbers, and creates null-prototype objects. Numeric decoding also rejects
underflow, decimal spellings changed by conversion, and integer results outside
JavaScript's exact safe range; downstream schemas never receive a silently
altered command-plane number.

## Split ownership

- `input-limits.ts`: shared numeric limits only.
- `bounded-json-model.ts`: JSON/result types and reason codes only.
- `bounded-json-parser.ts`: internal bounded JSON grammar parser only.
- `bounded-json-string.ts`: incremental UTF-8 accounting and grouped output.
- `bounded-json-number.ts`: interoperable decimal conversion policy only.
- `bounded-json.ts`: byte snapshot, fatal UTF-8 decode, immutable result.
- Boundary and hostile tests stay separate.
- Existing canonical JSON code consumes the shared depth/string constants.

Keep each new source or test file below 400 lines; split sooner when a file has
more than one responsibility.

## TDD sequence

1. Prove the root export is absent with a failing runtime-visible test.
2. Add a minimal exported decoder contract.
3. Add failing boundary and hostile-input tests.
4. Implement the smallest parser and byte boundary that makes them pass.
5. Update the package-root runtime smoke and canonical-limit consumers.

Every numeric boundary is exercised at `N` and `N+1`, including body bytes,
container depth, ASCII strings, multibyte strings, and decoded object keys.

## Verification

- `pnpm --filter @moe/contracts typecheck`
- `pnpm --filter @moe/contracts test`
- `pnpm verify:foundation`
- `pnpm typecheck`
- `pnpm test`
- raw Node strip-types package-root smoke
- `git diff --check`, NUL scan, and focused-file size audit
- independent hostile review of the exact committed diff

## Explicit non-goals

No route/server, command schema, objective/criterion 32 KiB schema rule, graph
revision, scheduler admission, store write, approval, lease, budget, provider,
fan-out, Phase-0 evidence artifact, or frozen-design claim is part of this slice.
