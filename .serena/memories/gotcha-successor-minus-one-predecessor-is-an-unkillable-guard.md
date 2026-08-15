# Deriving a predecessor from its successor makes the guard unkillable

`apps/daemon/src/activation/activation-ledger-reader.ts` enforces

    record.effectIntent.version === record.predecessorIntentVersion + 1
    record.attempt.version      === record.predecessorAttemptVersion + 1

as the proof that a committed activation succeeded the predecessor somebody
actually observed. The producer must therefore supply the OBSERVED predecessor.

Writing `predecessorAttemptVersion: commit.attempt.version - 1` compiles, reads
naturally, and passes every test — because `activateEffect` computes
`attempt.version + 1`, so the reader's check becomes `x + 1 === (x + 1 - 1) + 1`.
True for any successor, including one produced from a predecessor no caller ever
sent. The guard survives every mutation of the fields it is supposed to police.

## The fix

Read the predecessor from the REQUEST, as an own data property, the same way
the parser that validated it did:

```ts
const descriptor = Object.getOwnPropertyDescriptor(attempt, "version");
if (descriptor === undefined || !("value" in descriptor)) return null;
```

`exactRecord` in `@moe/runner`'s `effect-shape.ts` uses `readOwnDataProperty`,
so an accessor is already rejected upstream — matching that read keeps the two
in agreement instead of introducing a second, weaker one.

The *intent* predecessor is fine to take from the arm stage's output, because
that value is server-derived rather than a restatement of the successor.

## How to spot it

Any expression of the form `successor.<field> - 1`, `successor.<field> + 1`, or
`next(prev)` used to populate the operand a downstream invariant compares the
successor against. Ask: "can this assertion fail for ANY input?" If the answer
is no, it is decoration. Tests never catch this — the property holds; it just
holds vacuously.

Related: `mem:guard-premise-detaches-while-green`,
`mem:qa-generated-table-cannot-police-its-own-generator`.
