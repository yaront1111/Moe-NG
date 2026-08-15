# Convention: `Array.isArray` + `for...of` is a smuggling hole in a hostile-input parser

Found by adversarial self-review on `task-2580a578` (supervisor activation gate,
2026-08-08), AFTER the suite was green — no test had caught it, because no test had been
written for it. Mutation-verified afterwards: reverting the fix reddens exactly two tests.

## The hole

```ts
// looks strict, is not
if (!Array.isArray(value) || value.length > MAX) return null;
for (const entry of value) { /* validate entry */ }
```

`Array.isArray` is TRUE for a subclass. A subclass can override `Symbol.iterator`, so
`for...of` yields elements the `.length` check never saw — you validate one list and
return another. Array indices can also be **accessor** properties, so a getter answers a
valid record to the validating read and something else to the read that binds.

## The discipline (cloned from `packages/scheduler/src/runtime-shape.ts`)

Records: `isPlainRecord` (reject proxies, require `Object.prototype`/null prototype) ->
`hasOnlyOwnStringKeys` (exact key set, defeats prototype + symbol keys) ->
`readOwnDataProperty` (rejects accessors) for each key. That is what `exactRecord` does.

Arrays need the SAME treatment and it is easy to forget because `exactRecord` looks like
it already covers the object:

```ts
export function readList(value: unknown, maximum: number): readonly unknown[] | null {
  if (!isPlainArray(value)) return null;            // prototype === Array.prototype
  const length = readOwnDataProperty(value, "length");
  if (!length.ok || !length.present || !isCount(length.value) || length.value > maximum) return null;
  const out: unknown[] = [];
  for (let i = 0; i < length.value; i += 1) {
    const read = readOwnDataProperty(value, String(i)); // never invokes the iterator
    if (!read.ok || !read.present) return null;         // rejects holes AND accessors
    out.push(read.value);
  }
  return out;
}
```

`readOwnDataProperty` at every index also rejects sparse holes for free.

## Hostile fixtures that actually reach the hole

- `Object.setPrototypeOf([good], Object.create(Array.prototype))` — subclassed array
- an array with index `0` defined via `Object.defineProperty(..., {get})` — accessor element
- `new Array(cap + 1).fill(good)` — past the bound
- `{ length: 1, 0: good }` — a record wearing a length

All four must refuse with the SAME malformed code the object parsers use.

## The general rule

In a module that advertises hostile-input strictness, **every** structural read must go
through the strict helpers. One ordinary `Array.isArray`/`.length`/`for...of`/spread in an
otherwise-strict parser is the whole bypass — and a green suite will not tell you,
because the test that would catch it is the test you did not think to write.

Related: `mem:gotcha-digest-mutation-that-proves-nothing` (mutate at the mechanism's single
source), `mem:task-task-2580a578812f46a49cae0af79ff6fc16-handoff`.
