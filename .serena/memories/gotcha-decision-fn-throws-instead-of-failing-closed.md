# A discriminated-union guard fails OPEN on null/undefined

Found by adversarial self-review on `adapters/ide-contract`, 2026-08-09 — after a fully green
suite with 17 hand-written failure cases and five passing mutation drills.

## The hole
A "total" decision function over a discriminated union:

    export function decide(evidence: Evidence): Result {
      if (evidence.status === "LISTENING") { ... }
      ...
      return malformed("unrecognised evidence");   // looks total
    }

`null` and `undefined` never reach that final `return`. They throw on the discriminant read:

    TypeError: Cannot read properties of null (reading 'status')

A thrown TypeError carries **no stable reason code**, so a rail that requires failing closed with a
code is violated while every existing test passes. Non-object junk is fine — `(5).status` and
`"x".status` are `undefined` and fall through correctly. Only null/undefined are lethal.

## Why the typed cases cannot reach it
The malformed-input case is usually written as a cast of a *record* with a bad discriminant
(`foreign({ status: "PROBABLY_UP" })`). That exercises the fall-through and passes, which reads as
proof that the function is total. It is not: the two inputs that throw are the two the cast helper
was never given.

## Fix
Guard through a predicate that takes `unknown`, so TS does not reject the comparison
(`evidence === null` on a non-nullable union is TS2367 "no overlap"):

    const isEvidence = (v: unknown): v is Readonly<Record<string, unknown>> =>
      typeof v === "object" && v !== null;
    if (!isEvidence(evidence)) return malformed("...");

Test with `it.each([null, undefined])` across **every** operation, and loosen the cast helper to
`<T>(value: unknown): T` or the null case will not compile.

## Generalisation
Any boundary function typed against a union it receives from foreign/untrusted code has this hole.
Grep for a decision function whose first statement reads a property off its parameter.
