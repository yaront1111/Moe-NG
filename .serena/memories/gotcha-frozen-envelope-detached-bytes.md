# Gotcha: "frozen + detached" durable envelopes — two ways to get bytes wrong

This repo returns immutable snapshots of byte-carrying records (`StoredEvent`,
outbox messages, decision records). Two traps recur.

## 1. `Object.freeze` on a non-empty typed array THROWS

Verified 2026-08-08 on this repo's Node:

```
node -e "Object.freeze(new Uint8Array(2))"
# TypeError: Cannot freeze array buffer views with elements

node -e "Object.freeze(new Uint8Array(0))"   # succeeds
```

**Empty arrays freeze fine.** So a naive deep-freeze helper passes every test
written with 0-byte fixtures and explodes the first time real data flows through.

Do: freeze the envelope object (and any failure/result wrapper). Never freeze
`payload` / `metadata`. "Frozen envelope, copied bytes" is the achievable
contract — spell it that way in the DoD, not "deep frozen".

Any fixture-driven test of a freeze path must include a **non-empty** byte array
or it proves nothing.

## 2. `.slice()` does not detach a Buffer

`Buffer` extends `Uint8Array`, but `Buffer.prototype.slice` is aliased to
`subarray` — it returns a **view sharing the same ArrayBuffer**. So:

```ts
const copy = source.slice();          // WRONG: aliases when source is a Buffer
const copy = new Uint8Array(source);  // RIGHT: fresh buffer, from Buffer or Uint8Array
```

`new Uint8Array(src)` also normalizes a `Buffer` down to a plain `Uint8Array`,
which is what the durable contracts declare.

Detachment assertions must check buffer identity, not just value equality:

```ts
expect(result.payload.buffer).not.toBe(input.payload.buffer);
result.payload[0] = 0xff;
expect(input.payload[0]).toBe(originalFirstByte);
```

Value-equality alone (`toEqual`) passes on an aliased view — it is exactly the
assertion a mutation test kills. Cf. `mem:pattern-qa-mutation-testing-the-claim`.

## Related

`mem:decision-projection-upcast-fold-split`,
`mem:task-task-14ba8b74f05f458d94591e02ce851e29-handoff`
