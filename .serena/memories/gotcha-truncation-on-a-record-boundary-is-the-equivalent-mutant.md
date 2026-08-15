# A truncation drill is an equivalent mutant unless the cut lands on a record boundary

2026-08-15, task-cbc42f33 (@moe/runner provider telemetry).

The guard: a truncated capture must yield NO counts, never a partial sum.

```ts
if (evidence.truncated !== false) return refuse("TELEMETRY_CAPTURE_TRUNCATED", ...);
```

The drill: delete that line so the parser sums the prefix it does hold. It should redden the
never-zero and coverage tests.

**It reddened nothing.** Both existing truncation cases cut the capture MID-LINE
(`stdoutBytes: 16` and `90` against a ~120-byte JSON line). A mid-line cut leaves
`truncatedTailByteLength > 0`, so the *framing* layer raises `TRUNCATION` and refuses with the
same code from a different guard. The drill was an equivalent mutant and the suite stayed green
while the guard under test was gone.

## The case that kills it

Cut EXACTLY at a newline:

```ts
const first = line({ seq: 1, ... usage: { input_tokens: 4, ... } });
const stdout = `${first}${line({ seq: 2, ... usage: { input_tokens: 400, ... } })}`;
const boundary = Buffer.byteLength(first, "utf8");   // derive it, don't guess
// limits: { stdoutBytes: boundary }
```

Now every record the capture holds is complete, no framing anomaly fires, and the visible usage
sums to `4` — a number indistinguishable from a real total at every later layer. Only the
`truncated` flag knows it is a prefix. With the drill applied the test failed
`expected 'COMPLETE' to be 'UNKNOWN'`.

## Two transferable rules

1. **A bounded-capture guard needs a boundary-aligned case.** Any "we cut the stream" fixture
   that happens to cut mid-record is answered by the framing layer, not by the guard you think
   you are testing. Ask which layer answers, not merely whether it refused.
2. **Assert the CLASS before the code.** The test originally asserted
   `telemetryRefusal?.code` first, so the drill reddened with
   `expected undefined to be 'TELEMETRY_CAPTURE_TRUNCATED'` — true, but it does not say a
   partial sum was published. Reordering so `coverage` is asserted first made the failure name
   the actual defect. `expect` throws on the first failure, so assertion ORDER decides which
   message a future reader sees.

Related: `mem:qa-equivalent-mutant-in-a-two-clause-guard`,
`mem:refusal-test-answered-by-earlier-guard`,
`mem:mutation-drill-red-on-wrong-assertion`.
