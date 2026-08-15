# Gotcha: validating a callback's return value OUTSIDE the try/catch that guards the call

A result-union API that promises "never throws, returns frozen evidence" is
broken by this extremely natural shape:

```ts
let produced: unknown;
try {
  produced = handler(input);          // guarded
} catch {
  return refuse("HANDLER_FAILED");
}
const checked = validate(produced);   // NOT guarded  <-- hole
```

`validate` touches properties of an attacker-supplied object. If any of them is
a getter that throws, the exception escapes the whole function, and every caller
that trusted "this returns evidence instead of throwing" is now wrong. Observed
2026-08-08 in `packages/store/src/projections/projection-upcast.ts`; a handler
returning `{ get metadata() { throw ... }, payload }` made `upcast()` throw
`Error: getter` straight out to the test runner.

Fix is one line of restructuring — put the inspection inside the same try:

```ts
let checked: OutputCheck;
try {
  checked = validate(handler(input));
} catch {
  return refuse("HANDLER_FAILED");
}
```

Costs nothing and closes throw-on-call and throw-on-read together.

## Related traps in the same family

- **Thenable probes must read through the prototype chain.** Verified:
  `Object.getOwnPropertyDescriptor(Promise.resolve(), "then")` is `undefined` —
  a real promise has no OWN `then`. So a descriptor-based probe (the usual
  advice for avoiding getter invocation) silently fails to detect real promises.
  You must do plain `value.then` property access, which is exactly what can
  invoke a hostile getter — hence the try above is mandatory, not optional.
- **`Object.keys` hides symbol keys.** `Object.keys({a:1,[Symbol()]:2}).length`
  is 1, `Reflect.ownKeys(...)` is 2. An "own keys are exactly X and Y" check
  written with `Object.keys` accepts a symbol-keyed extra. Use `Reflect.ownKeys`
  (see also `mem:gotcha-pure-reducer-deep-freeze-aliasing`, which covers the
  non-enumerable half of the same blind spot).
- Both defects were mutation-verified: revert the fix, confirm the new test goes
  red, restore. Do that — a regression test for a hole you just closed is worth
  nothing until you have seen it fail.
