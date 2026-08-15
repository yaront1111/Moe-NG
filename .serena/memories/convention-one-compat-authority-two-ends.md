# One compatibility authority across a seam neither side can import

`createCompatGate` (`packages/control-room-client`) is the single admission decision for
distribution compatibility. The DAEMON cannot call it: `apps/daemon` has no
`@moe/control-room-client` dependency, and `AGENTS.md`'s architecture map points
dependency direction TOWARD contracts — daemon -> control-room-client inverts it.

## The rule: COMPOSE the pin on both ends, do not copy it

Both sides derive the wire protocol version from the same three `@moe/contracts`
constants, in the same order, and neither writes the string down:

```ts
// apps/daemon/src/http/http-contract.ts
export const WIRE_PROTOCOL_VERSION =
  `${RUNTIME_COMMAND_ENVELOPE_VERSION}+${RUNTIME_QUERY_ENVELOPE_VERSION}+${RUNTIME_ERROR_REGISTRY_VERSION}` as const;

// emitted by packages/control-room-client/generator/generate.ts
export const GENERATED_WIRE_PROTOCOL_VERSION = /* the same template */;
```

`generated-coverage.test.ts` already asserts `GENERATED_CONTRACT_PINS` equals those live
constants, so a registry bump moves both ends at once. That is ONE authority with two
readers — not a second compatibility rule.

Assert the pin is COMPOSED, never compare it to a hard-coded string: a literal comparison
passes even when the generator emitted a literal that has drifted from the registry, which
is the exact failure the pin exists to prevent.

## Placement: behind the gate, never on the package root

`client-compat.test.ts` pins the package root to EXACTLY `["createCompatGate"]` — one
runtime export, so no surface is reachable without passing the gate. Adding a constant
there reddens it. Put it on `ControlRoomClientSurface` instead: a build whose pins do not
match should not even learn the protocol string it failed to match. Then update the
surface-key assertion in `client-compat.test.ts` (it asserts the EXACT sorted key list) and
the golden `GENERATED_FILE_SHA256` in `generated-coverage.test.ts` — that ritual is
documented in that test's own comment. `GENERATED_CONTRACT_DIGEST` should NOT move: it
covers the runtime-enumerable registry, not the emitted file.

## Related

`DISTRIBUTION_MISMATCH` cannot be raised through `createRuntimeError` at either end: it
declares a `PROJECT` lifecycle source and the factory fails closed to `UNKNOWN_ERROR`
without one, while both ends refuse BEFORE reading project state. Project the registry row
verbatim (retryability, recoveryCategory, recoveryCommands, transport) and set
`truthClass: "OBSERVED"` — the observer compared two pins, it did not verify project state.
`client-compat.ts` did this first; `apps/daemon/src/http/http-adapter.ts` mirrors it.
