# A seeded harness on an LFSR can be silently narrower than it claims

Found on `task-49acb856` (supervisor race harness), and it would have shipped a
gate testing five fewer refusal codes than its evidence claimed.

## The failure

The lease-presence core's harness pattern uses xorshift32:

```ts
state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
return state >>> 0;
```

Every decision in a race harness is `value % n` for a SMALL n — `% 10` to pick a
command, `% 16` to pick a tamper arm, `% 12` to pick a scenario — and each step
draws several in a row. xorshift is LINEAR, so its low bits stay linearly related
across successive draws. The pair "`% 16` taken two draws after `% 10`" is
therefore periodic, not uniform.

Measured, at 1200 steps: **three of a sixteen-arm activation tamper table were
never reached at all, and two more fired exactly once.** Five refusal codes were
effectively untested while the suite was green and the coverage table looked full.

A final multiply-xorshift mix on the xorshift output does NOT fix it. `0x2545F491`
is 1 mod 16, so the product's low four bits are still the state's low four bits.

## The fix

splitmix32 — a mixed counter with full avalanche, no linear relation between
successive outputs:

```ts
let state = seed | 0;
return () => {
  state = (state + 0x9e3779b9) | 0;
  let z = state;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
};
```

Same determinism, same reproducibility, same seed-in/schedule-out contract.

## The assertion that catches it

Reproducibility and seed-sensitivity tests DO NOT catch this — a correlated
generator replays fine and differs across seeds. Assert the modulus behaviour
directly, at the widths and draw offsets the harness actually uses:

```ts
const next = seeded(SEED);
const arms = new Set<number>();
for (let i = 0; i < 400; i += 1) { next(); next(); arms.add(next() % 16); }
expect(arms.size).toBe(16);
```

## The general rule

An outcome-kind set-equality assertion is only as good as the generator feeding
it. Assert a per-kind count floor (`count >= 2`), never just presence: a kind
reached once is a coincidence, and a kind reached zero times is a coverage
failure to investigate rather than a list to trim.
