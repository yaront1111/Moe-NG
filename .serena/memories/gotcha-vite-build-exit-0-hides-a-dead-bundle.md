# Gotcha: `vite build` exit 0 does NOT mean the app runs — @moe/contracts is Node-only

Hit on `task-fd82678f720747888d1c32ef96bb5534` (apps/control-room, the repo's first
frontend package).

`packages/contracts/src/runtime/runtime-guards.ts:1` does `import { types } from "node:util"`
and calls `types.isProxy(...)` inside `isPlainRecord` and `isSafeArray` — the revoked-proxy
hardening. Those sit on the hot path of `buildNextAllowedCommands`, `parseLeaseAuthority`,
and anything else that validates a record.

A bundler has no `node:util`. Vite externalizes it and prints only a WARNING:

    Module "node:util" has been externalized for browser compatibility,
    imported by ".../packages/contracts/src/runtime/runtime-guards.ts"

`vite build` still exits 0. `tsc` is clean. Vitest is green, because Vitest runs under Node
where `node:util` really exists. Every gate passes over a bundle that cannot boot:

    BUNDLE_THREW: TypeError Cannot read properties of undefined (reading 'isProxy')

## Rule for any browser-reachable code

Import @moe/contracts **types and plain constants** freely (`NextAllowedCommand`,
`RUNTIME_COMMAND_ENVELOPE_VERSION`, `EMPTY_NEXT_ALLOWED_COMMANDS`, `historicalRuntimeResult()`
— none of these invokes a guard). Do NOT call its parsers/validators from the browser. That
is the correct architecture anyway: affordance parsing is daemon-side, and the browser
consumes the result as a type.

Do NOT "fix" this by editing runtime-guards.ts. It is outside a frontend task's owned paths
and `types.isProxy` is a real security guard.

## The regression lock that actually works

A build gate cannot see this, by construction. Mask the module instead — fast, no bundler:

```ts
it("loads the whole shell module graph without any Node-only API", async () => {
  vi.doMock("node:util", () => ({ default: {}, types: undefined }));
  vi.resetModules();
  try {
    await import("./fixtures.js");
    await import("./kernel.js");
  } finally {
    vi.doUnmock("node:util");
    vi.resetModules();
  }
});
```

Keep the `finally`: without it a failure leaves `node:util` mocked for later tests.

## Verifying a bundle by hand

`node --input-type=module -e` with jsdom, `runScripts: "outside-only"`, eval the emitted chunk.
**Await a tick before asserting** — React 19 renders concurrently, so an immediate read of
`#root.innerHTML` reports empty and looks like a second bug. `await new Promise(r => setTimeout(r, 300))`.
Run it from a `-e` string, never a file under the repo root (`mem:gotcha-moe-wrapper-autocommit`).

Related: `mem:convention-control-room-test-id-prefixes`.
