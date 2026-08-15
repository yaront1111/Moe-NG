# Gotcha: `TABLE[key] === undefined` is FALSE for `"__proto__"` and `"constructor"`

Two independent JS footguns that hit the same code shape — an "are the own keys exactly
the ones I expect?" validator. Both were live defects in
`packages/store/src/projections/projection-fold.ts` on 2026-08-08 (task-82989467), found
in adversarial self-review with a fully green 19-test suite, then mutation-verified.

## 1. The membership check walks the prototype chain

```js
const FIELD_KINDS = { aggregateId: "string", metadata: "bytes" };
FIELD_KINDS["__proto__"]   === undefined   // false  -> Object.prototype
FIELD_KINDS["constructor"] === undefined   // false  -> the Object constructor
```

So the guard

```ts
if (FIELD_KINDS[key] === undefined && key !== "decisionTrace") { return null; }
```

waves BOTH keys straight through the "unknown extra key" check. A test using an
innocuous extra key (`shadow: 1`) passes and proves nothing about these two.

**Fix:** `if (!Object.hasOwn(FIELD_KINDS, key) && ...)`. Same line length.

Same family as `Object.hasOwn(reducers, eventType)` before invoking a caller-supplied
handler map — without it, `eventType: "constructor"` resolves to `Object`, `typeof` is
`"function"`, and you CALL it. `Object(state, event)` even returns an object, so the
happy path continues and the bug is invisible.

## 2. Assigning `__proto__` swaps the prototype instead of creating an own key

```js
const draft = {};
draft["__proto__"] = { leaked: true };
Object.hasOwn(draft, "__proto__")            // false  -> key silently LOST
Object.getPrototypeOf(draft).leaked          // true   -> prototype REPLACED
```

Any clone/copy loop of the shape `draft[key] = clone(source[key])` therefore silently
absorbs a `__proto__` key AND hands the result an attacker-controlled prototype.
`Object.freeze(draft)` afterwards freezes the wrong thing and hides it further.

**Fixes, pick one:**
- Refuse the key: `key !== "__proto__"` in the copy loop (fail closed — what this repo's
  rails want, and it costs zero lines).
- Or write through `Object.defineProperty(draft, key, {value, writable: true,
  enumerable: true, configurable: true})`, which bypasses setters.
- `Object.create(null)` as the draft also works but changes the prototype of the result,
  which can surprise a deep-equality assertion.

## Where to look for this

Anywhere a plain object is used as a lookup TABLE (`kinds[key]`, `handlers[type]`,
`config[name]`) or as a copy TARGET built key-by-key from untrusted input. Validators,
deep-clone helpers, deserialisers, reducer/handler registries.

## Testing note

Do not test this with a generic extra key. Use fixtures named exactly `__proto__` and
`constructor`, and construct the `__proto__` one with a COMPUTED key —
`{ ...base, ["__proto__"]: {...} }` — because the bare literal form `{__proto__: x}` is
special-cased by the parser into a prototype assignment and creates no own property.
