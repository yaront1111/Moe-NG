# A frozen `Record<string, T>` lookup returns PROTOTYPE members, and it corrupts the reason code

Found in adversarial self-review on task-1eeb2dcc, apps/control-room/src/live/live-effort-edge.ts.

## The shape

```ts
const NAMEABLE_DEMANDS: Readonly<Record<string, BaselineDecisionKind>> = Object.freeze({
  "goal.create": "CREATE", /* ... */
});
// looked up with a string that arrives from the wire:
const demanded = NAMEABLE_DEMANDS[commandKind] ?? UNNAMEABLE_DEMANDS[commandKind];
```

`Object.freeze` does not sever `Object.prototype`. A `commandKind` of `constructor`, `toString`,
`valueOf` or `hasOwnProperty` reads back an inherited FUNCTION instead of `undefined`.

## Why it matters even when it "fails closed"

It does fail closed — the downstream admission sees a non-string and refuses. But it refuses with
the WRONG STABLE REASON CODE: `EFFORT_OBSERVATION_UNPARSEABLE` ("one arrived and was malformed")
instead of `EFFORT_OBSERVATION_ABSENT` ("no such observation exists"). The table states nothing
about that kind, so absent is the truth. On a board whose epic rail is "fail closed with stable
reason codes", a code that is stable but wrong is worse than a crash: it is a durable claim that
something arrived.

This is invisible to a green suite — no realistic test sends `commandKind: "toString"` — and
invisible to a mutation drill, because there is no operator to flip.

## Fix

Guard the lookup with `Object.hasOwn` (or build the table with `Object.create(null)`):

```ts
function statedDemand(kind: string): string | undefined {
  if (Object.hasOwn(NAMEABLE_DEMANDS, kind)) return NAMEABLE_DEMANDS[kind];
  if (Object.hasOwn(UNNAMEABLE_DEMANDS, kind)) return UNNAMEABLE_DEMANDS[kind];
  return undefined;
}
```

## Rule

Any object-literal table keyed by a string that CROSSES A TRUST BOUNDARY (wire field, command kind,
event type, user input) needs `Object.hasOwn`. `Array.prototype.includes` on a frozen array has no
such hole, so a membership list is safe; a lookup map is not.

Related: `mem:qa-deviation-fixture-must-be-valid-at-earlier-layers`,
`mem:refusal-test-answered-by-earlier-guard`, `mem:a-crash-is-not-a-refusal`.
