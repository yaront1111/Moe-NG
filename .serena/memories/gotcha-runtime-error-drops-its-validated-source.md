# RuntimeError validates `source` then throws it away — the refusing layer is unobservable

Measured 2026-08-09 in `packages/contracts/src/runtime/runtime-error-factory.ts`.

## The shape
`createRuntimeError` accepts `source` in `OPTIONAL_KEYS` (`:33`) and uses it in `sourceAccepted()` to
decide whether the code is legal from that aggregate. But the `RuntimeError` interface (`:20-31`) is
`code / correlationId / details / nextAllowedCommands / recoveryCategory / recoveryCommands /
registryVersion / retryability / transport / truthClass` — **no `source`**. It is consumed and
dropped.

`details` is not a fallback: `sanitizeDetails` copies only `descriptor.requiredDetailKeys`, and many
codes are registered with `NO_KEY` (`REVISION_REBOUND`, `SUPERSESSION_CONSEQUENCE_CHANGED`), so their
`details` is always the frozen empty object.

## Why it bites
Epic rail 6 requires failure tests to pin "the specific stable reason code — and, where more than one
layer can refuse, WHICH LAYER refused". With `source` dropped and `details` empty, a test literally
cannot observe the layer from the error. Any DoD phrased as "refuses with exact CODE **at
AGGREGATE**" is untestable until production exposes a discriminant.

**Fix: a production `layer` field on the aggregate's own rejected-result type**, set once in the
shared `rejected()` constructor so every refusal path carries it with no duplication. Not a test
helper — a helper that reconstructs the layer is asserting against itself, which the global test rail
forbids. `packages/core/src/supersession/supersession-engine.ts` already does it right:
`SupersessionRefusal` carries `layer: "SUPERSESSION_KERNEL"`.

Where a code IS registered with detail keys, the existing `illegal()` pattern works instead: it puts
`aggregateKind` in `details`, which survives sanitization.

## Second, nastier half: a wrong source degrades silently
`createRuntimeError` fails **closed to `UNKNOWN_ERROR`** on an unknown code or a source the descriptor
does not list — it does not throw. So a refusal built with the wrong aggregate returns a
well-formed `UNKNOWN_ERROR`, and a test asserting only `ok === false` stays green. Always assert the
exact code. Before planning a refusal on a new aggregate, grep the row in
`runtime-error-registry.ts` and confirm the aggregate appears in its `srcs(...)`.
