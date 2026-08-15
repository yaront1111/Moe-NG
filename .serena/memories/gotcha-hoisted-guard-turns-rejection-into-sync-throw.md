# Hoisting a guard out of a Promise executor silently changes its error channel

Moving a throwing call from inside `return new Promise((resolve) => { ...throw... })` to above the
`return` converts a promise REJECTION into a SYNCHRONOUS throw from a function still typed
`(x) => Promise<void>`. Every caller written as `f(x).catch(...)` **without `await`** stops catching
it, and the throw escapes into whatever loop called `f` — for a poll tick, that kills the tick.

The type does not change, so tsc is silent. The suite can stay green because a test written as
`try { await f(x) } catch {}` passes under BOTH channels.

## Fix

Make the returned arrow `async` (any throw inside becomes a rejection) and type the inner promise
explicitly — inside an async function the contextual return type no longer pins it, so bare
`new Promise((resolve) => ...)` infers `Promise<unknown>`.

## Pin it, or it regresses

```ts
let returned: Promise<void> | undefined;
expect(() => { returned = f(req); }).not.toThrow();   // the channel, as its own assertion
await expect(returned).rejects.toMatchObject({ code, layer });
```

`await expect(f(req)).rejects...` alone is NOT enough — if `f` throws synchronously the expression
throws while building the argument and the failure reads as an unrelated error.

## Before hoisting, read the real call site

Grep the consumer. `awaited` means the hoist is safe; `.catch()` without `await` means it is not.
Found in moe-next at `agent-wrapper.ts:226` (`config.spawnAgent({...}).catch(() => undefined)`),
which is what made `async` mandatory in `mem:task-task-89071eb1ea0d4ccd8015f61d10cd89f6-handoff`.

Related: `mem:refusal-test-answered-by-earlier-guard`, `mem:a-crash-is-not-a-refusal`.
