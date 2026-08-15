# Gotcha: a native Promise can never FULFIL with a get-trapping Proxy

Writing a hostile-fulfilled-result test, the natural fixture is
`prepareRuntime: async () => hostileProxy` or `Promise.resolve(hostileProxy)`.

Both FAIL to deliver it. Promise resolution reads `value.then` to decide whether the value is
a thenable, so a Proxy whose `get` trap throws turns the promise into a REJECTED one. The
delivery machinery, not production, fires the trap — and a `counter.fired === 0` assertion
about "production never reflected on it" goes red for a reason that has nothing to do with
production.

Consequences for this test family:

- Trap only reflection (`getOwnPropertyDescriptor`, `ownKeys`, `has`, `getPrototypeOf`), never
  `get`. Then `Promise.resolve(proxy)` reads `then` off the target, finds `undefined`, and
  fulfils with the proxy intact — which is the scenario you actually wanted to test.
- With `get` untrapped, `util.types.isProxy` rejects the value before any trap runs, so the
  honest assertion is `fired === 0` (production never reflected), NOT `fired > 0`.
- That makes the counter look dead, so pair it with a one-line positive control near the sweep:
  `expect(() => Object.keys(hostileFulfilled("reflection", {}, armed))).toThrow();
   expect(armed.fired).toBe(1);`
  Otherwise a reviewer cannot tell "never reflected" from "trap was never armed".

Same shape applies to a raw thenable fixture: assert its `then` body never ran (a shared
`fired` counter across all cases, asserted `0` once at the end) rather than asserting the
production result alone.
