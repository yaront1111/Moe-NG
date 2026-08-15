# Gotcha: `createRuntimeError({ code })` silently downgrades to UNKNOWN_ERROR

`packages/contracts/src/runtime/runtime-error-factory.ts:79-103`. `sourceAccepted()`:

```ts
if (!Object.hasOwn(input, "source")) return descriptor.validSources.length === 0;
```

So a code whose registry row declares a NON-EMPTY `validSources` **must** be raised
with `source: { aggregate, state }` (a `RuntimeLifecycleSource` whose aggregate is in
`validSources`). Omit it and the factory fails closed to `UNKNOWN_ERROR`
(`INTERNAL_UNKNOWN`, HTTP 500, mcp -32603, truthClass `UNKNOWN`) — **no throw, no
warning**. The returned object still looks like a well-formed `RuntimeError`, so the
downgrade is invisible until you assert on `code`/`transport`.

Hit on `task-cc9a6953a1274b5eab5d82d15322ddd8`: `createRuntimeError({ code:
"DISTRIBUTION_MISMATCH" })` returned `UNKNOWN_ERROR` because that row declares
`validSources: ["PROJECT"]`.

## How to apply

- Before calling the factory, read the row: `lookupRuntimeError(code).validSources`.
  Empty -> pass no `source`. Non-empty -> pass a matching one. Passing a `source` for a
  boundary code with empty `validSources` ALSO downgrades.
- Always assert `error.code` (not just "an error came back") in tests. A truthiness
  assertion cannot see this downgrade.
- **Client/edge code should usually not use the factory at all.** A `RuntimeError`
  carries `truthClass: DAEMON_VERIFIED`; a control room or adapter that detected the
  condition itself has not verified anything as the daemon. Fabricating a lifecycle
  source just to satisfy the factory invents daemon truth. Prefer a local refusal type
  that names the stable code, projects `retryability`/`recoveryCategory`/`transport`
  from the registry row (facts about the CODE), and sets its own honest `truthClass`
  (`OBSERVED` for something the caller directly compared). That is what
  `packages/control-room-client/src/client-compat.ts` does.
