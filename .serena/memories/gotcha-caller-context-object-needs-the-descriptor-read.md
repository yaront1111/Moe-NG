# A caller-supplied options object needs the own-DATA-descriptor read too

Hostile-input discipline is usually applied to the VALUE a caller passes and not
to the OPTIONS OBJECT that carries it. Reading `context.priors` by plain property
access is enough for both defects to be live at once:

- an accessor (`Object.defineProperty(ctx, "priors", { get() { throw } })`) runs
  the CALLER'S OWN CODE inside the read that decides whether to trust the caller;
- a revoked proxy as the context throws
  `TypeError: Cannot perform 'get' on a proxy that has been revoked`,
  turning a typed refusal into an exception.

Both were found by adversarial self-review AFTER a green 41-test suite, and a
mutation drill (revert to `context.priors`) reddens exactly those two cases.

The fix follows the launcher's own `declaredOf` precedent — proxy guard first,
then an own DATA descriptor, never a property access:

    if (typeof context !== "object" || context === null) return null;
    try { if (types.isProxy(context)) return null; } catch { return null; }
    let d; try { d = Object.getOwnPropertyDescriptor(context, "priors"); }
    catch { return null; }
    return d === undefined || !("value" in d) ? null : d.value;

Note `types.isProxy` must come BEFORE `Array.isArray` on the inner value too:
`Array.isArray` THROWS on a revoked proxy.
Landed in
`packages/runner/src/providers/telemetry/provider-usage-normalization.ts`.
