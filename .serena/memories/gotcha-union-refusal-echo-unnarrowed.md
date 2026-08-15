# Gotcha: a result union whose BOTH arms carry the same field lets callers skip the `ok` check

Found by QA on `task-82989467` (`packages/store/src/projections/projection-fold.ts`).
Not a reject there — the DoD was fully met — but it is a live footgun for every
consumer of a fail-closed result type in this repo.

## The shape

```ts
type Result =
  | { ok: true;  checkpoint: Checkpoint; state: State }
  | { ok: false; checkpoint: Checkpoint; state: State; code: Code; layer: Layer }
```

Putting `checkpoint`/`state` on BOTH arms is deliberate and good — it lets a refusal
echo the caller's unchanged values so nothing is laundered. But it also means
TypeScript resolves `result.checkpoint` on the UNNARROWED union. So:

```ts
saveCheckpoint(result.checkpoint)   // compiles clean, never checked result.ok
```

The compiler's usual protection — "property does not exist on type X" — is exactly
what stops being available the moment you make the field common to both arms. The
discriminant is there, and nothing forces you to read it.

## Why it bites hardest on the failure path

Refusal arms usually echo the caller's own input, so a careless consumer gets away
with it — until ONE arm echoes a sentinel. In the fold engine the entry-catch arm
echoes `EMPTY_STATE` + `{globalPosition: 0n}` because at that point nothing about the
input is trusted. That arm is reachable with a perfectly VALID caller state (a hostile
batch makes `Reflect.ownKeys` throw during preflight). So the unnarrowed read rewinds
a live projection checkpoint from 5 to 0. Fail-closed on the producer side; still a
rewind on the consumer side.

## What to do

- **Producer:** if a sentinel arm exists at all, prefer echoing the caller's value
  whenever it was representable (`start ?? EMPTY_STATE`) so the sentinel is reachable
  only when the field genuinely has no trustworthy value. Cheap, usually zero net lines.
- **Producer, stronger:** put the echoed values ONLY on the success arm and expose the
  refusal's copy under a distinct name (`echoedState`) — then an unnarrowed
  `result.state` is a compile error again. Costs an API rename; worth it for seams many
  consumers will wire.
- **Consumer:** never read a payload field off a result union without narrowing on the
  discriminant first, even when it compiles.
- **QA:** when reviewing a fail-closed seam, check WHICH refusal arms echo a sentinel
  versus the caller's input, and whether a valid input can reach a sentinel arm. A test
  asserting only `code` and `layer` on that arm — as the fold suite does for its
  `throwingProxy` case — passes while the echoed values go unasserted.

Related: `mem:task-task-82989467aa474ae786f0c4eb8b23bfb0-handoff`,
`mem:gotcha-assertions-detached-from-their-subject`.
