# Contributing to Moe Next

## Focused modules

Keep source and test files cohesive and easy to review. When a file begins to carry multiple responsibilities or becomes cumbersome to navigate, split it along domain boundaries such as contracts, codecs, schema management, orchestration, and read models.

Line count is a review signal, not a target. Files approaching 800 lines require an explicit split review; files above 1,200 lines require a written justification when a safe split is not yet possible. Generated files are exempt.

Prefer small public surfaces and private implementation modules. A split must preserve atomicity, invariants, and tests; do not create circular dependencies merely to reduce line count.

## Two verification claims for the foundation Windows launch path

`apps/daemon/src/work/foundation-attempt-windows.test.ts` holds one case whose
child is a **real Claude provider session**. Its wall time is the provider's, and
this repository does not control it. Measured fresh at the launch seam on an
idle win32 host, gate held, one worker, four runs took **63.0 s, 165.0 s,
216.3 s and 123.6 s** — a 3.4x spread with no usable trend, whose worst sample
consumes 90% of the arm's 240 s launch deadline before any co-scheduling. No
deadline is defensible
against that, so the arm is routed to its own lane rather than given a bigger
number. The two lanes certify **different things**, and neither substitutes for
the other.

### The ordinary gate

```
pnpm --filter @moe/daemon test
```

Runs every daemon case **except** the live one, selected by the negative
`--testNamePattern` in `apps/daemon/package.json`. It covers the deterministic
settlement, retention, replay and refusal-code behaviour of the foundation
attempt path, including the scripted-provider service cases in
`foundation-attempt-service.test.ts`.

It does **not** certify that a real provider session can be launched, observed
and filed. A scripted or injected provider observation is not physical evidence
and must never be reported as one.

### The live lane

```
pnpm --filter @moe/daemon test:live:foundation-attempt
```

Required for any change to the foundation Windows launch, settlement, launch
template or provider boundary path — and for that change's delivery record, not
only its author's confidence. Run it:

- **foreground**, never backgrounded, and never piped into `tail` — a pipe
  reports the pipe's exit status, so capture `${PIPESTATUS[0]}` if you must;
- on a **win32 host with a provable installed Claude runtime**;
- while **holding the shared `full-suite-gate` lease**. The suite takes a
  machine-global launch lock, so a second concurrent real session refuses with
  `LAUNCH_LOCK_IDENTITY_CONFLICT` or contends and corrupts both measurements.
  This is also why the script pins `--maxWorkers=1`.

**Absence is not a pass.** On a host with no provable runtime the live arm
fails, rethrowing discovery's own code and layer —
`CLAUDE_RUNTIME_PATH_MISSING@RUNTIME` or
`CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED@RUNTIME`. That is unverified live
capability, reported as such. The arm is registered with an unconditional `it`
for exactly this reason: `it.runIf(...)` would report a skip as a pass.

The sibling Windows arms that legitimately launch `--version` are unchanged and
still ride the ordinary lane, where green-on-absence is correct.

### Reading the result

Exit 0 is not evidence a lane ran. Read the output:

- the `Test Files N passed` and `Tests N passed` count lines must be **nonzero**
  — `No test files found` and `0 passed` are both exit 0;
- the live lane must additionally show `[LIVE_PROVIDER_DISCOVERY]` with
  `"executed":true`, and `[LIVE_PROVIDER_TIMING]` with `forwardedLaunches:1` and
  a finite `launchSeamMs`. `"executed":false` means the prerequisite branch was
  reached and nothing was launched;
- Vitest 4 buffers a passing case's console output, so harvest those lines with
  `--reporter=verbose`.

The timing lines are **value-free** by construction: a boolean, the platform,
the typed refusal code, and integer milliseconds. Never widen them to carry
provider stdout or stderr, a path, a digest, a credential or an environment
value.

Do not add `--retry` and do not raise the deadline to make a live failure go
away. A provider slower than the bound is the finding, and the routing contract
in the same file fails if either appears in the script.

### Checking the lane partition

The two patterns must together select every case exactly once. Collect the real
names rather than trusting the regexes by eye:

```
cd apps/daemon
pnpm exec vitest list --root . --config package.json src/work/foundation-attempt-windows.test.ts
pnpm exec vitest list --root . --config package.json --testNamePattern="^(?!.*LIVE_PROVIDER:)" src/work/foundation-attempt-windows.test.ts
pnpm exec vitest list --root . --config package.json --testNamePattern="LIVE_PROVIDER:" src/work/foundation-attempt-windows.test.ts
```

The unfiltered count must equal ordinary plus live, and the live list must hold
exactly the one marked case. `vitest list` **collects**; it does not execute, so
it proves routing and never capability.

Both scripts are plain `pnpm` invocations: POSIX and PowerShell users run the
same commands. The quoted negative lookahead lives in `package.json`, not in a
shell-specific environment assignment, so no shell quoting rules apply.

Note that the **root** `pnpm test` include carries no `apps/**`. It runs zero
daemon tests, so it can never stand in for either lane above.
