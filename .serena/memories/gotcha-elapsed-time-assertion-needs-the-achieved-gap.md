# A "wait N seconds" requirement is vacuous unless you assert the ACHIEVED gap

From the legacy quiesce drill (task-4e1fe69, 2026-08-15), where a DoD literally
read "two complete manifests at least ten seconds apart match before import".

The obvious test — `await sleep(10_000)` then assert the two captures match — is
green whether or not ten seconds passed. A vitest fake clock, a clamped
`setTimeout` (`mem:settimeout-clamps-huge-delay-to-one-ms`), or someone
"optimising the slow test" all shorten it invisibly, and the assertion that
survives is the one that never depended on the wait.

Assert the achieved gap from a monotonic clock, between the two captures:

    const startedAt = process.hrtime.bigint();
    await sleep(10_200);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    expect(elapsedMs).toBeGreaterThanOrEqual(10_000);   // load-bearing

Then **drill it**: shorten the wait to 200ms and require the run to redden with
`expected 213.9712 to be greater than or equal to 10000`. A drill that reddens on
the *match* instead means the gap assertion is not the one holding.

Three supporting details:
- Give the case an explicit timeout ABOVE the wait (`it(name, fn, 60_000)`),
  or vitest's 5s default kills it mid-drill. This also converts the fake-timer
  case into a failure instead of a hang (`mem:mutation-drill-can-hang-instead-of-failing`).
- A real wait makes the lane genuinely slow — ~11s here. That is the drill
  working. Do not replace it with a fake clock to speed the suite up.
- `process.hrtime.bigint()` is monotonic and unaffected by wall-clock jumps;
  `Date.now()` is not.
