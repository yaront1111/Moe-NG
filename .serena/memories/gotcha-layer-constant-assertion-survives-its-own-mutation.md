# A layer/code assertion written against the production constant survives mutating that constant

Seen on `task-45d12ecfa6ae4938b23af28fe7876a44` (macOS platform boundary), and it generalises to any test that pins a "which layer refused" / "which code" answer.

A refusal matrix full of

```ts
expect(failure.layer).toBe(PLATFORM_MACOS_LAYER);
```

reads like ~25 independent layer assertions. It is ZERO. Flip the production constant

```ts
export const PLATFORM_MACOS_LAYER: PlatformLayer = "PLATFORM_LINUX";
```

and every one of those still passes, because both sides moved together. The suite stays green while the adapter is now attributing darwin verdicts to Linux — the exact defect the two-adapter split exists to prevent.

## What actually kills it

Only assertions that name a LITERAL, or that relate the constant to a DIFFERENT constant:

```ts
expect(PLATFORM_MACOS_LAYER).toBe("PLATFORM_MACOS");
expect(failure.layer).not.toBe(PLATFORM_LINUX_LAYER);
// and the strongest one — sweep every reachable refusal, collect the layers,
// compare the SET against a hand-written literal list:
expect([...layers].sort()).toEqual(["PLATFORM_CONTRACT", "PLATFORM_MACOS"]);
expect(layers.has(PLATFORM_LINUX_LAYER)).toBe(false);
```

In the real drill exactly 4 tests reddened out of ~30 that mention the layer, and 3 of the 4 were of the forms above.

## Reading the drill result

A LOW red count on a constant-substitution drill is not evidence of weak coverage — it is evidence of how few assertions were ever anchored to anything but the constant. Do not "fix" it by adding more `toBe(THE_CONSTANT)` lines. Add one literal pin plus one cross-constant sweep.

Same shape applies to error codes, version strings and any `X_LAYER` / `X_VERSION` exported alongside the tests that assert it. Related: `mem:qa-cross-check-table-omits-the-key-field`, and epic rail 6 on assertions that quietly detach from their subject.
