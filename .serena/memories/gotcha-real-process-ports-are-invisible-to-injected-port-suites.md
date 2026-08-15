# An injected-port suite cannot see its own real ports

A pipeline built as `runX(input, ports)` with a `SYSTEM_PORTS` default and
per-test injection has a blind spot that a green suite and a mutation matrix
BOTH miss: the real port implementations, and the argument shape the
orchestrator actually passes them.

Three defects of this exact family on task-9449ce65, all invisible to a
36/36 green suite:

1. **Argument shape.** The orchestrator called
   `ports.buildSubject({ buildIndex, privateKey, signingKeyId, source, sourceRoot })`
   while the real builder validated an EXACT key set without `buildIndex`,
   so the real composition refused 100% of the time. Every test injected a
   spy declared `async ({ buildIndex }) => ...` — a helper LOOSER than the
   production surface it stood in for, so it accepted what production
   rejected.
2. **Real port body.** `generateSbom` spawned a CLI with a wrong flag and
   could never parse its output. Every fast test replaced it.
3. **Self-fulfilling refusal.** A test named "...refuses conflicting content"
   injected a fake publisher that RETURNED the refusal it then asserted. The
   real conflict branch never executed; mutating it away kept the suite green.

## Detection

A mutation drill on a real port body SURVIVES if the only test that reaches
it is one you excluded for being slow. Treat "survived, and every test that
names this function injects it" as proof of the blind spot, not as proof the
code is fine.

## Two cheap closures

- **A composition test**: run the orchestrator with the REAL function as the
  port and fake only the external processes around it. Provision fixtures
  from the production inventory constants, never a hand-written list.
- **A source-boundary test**: assert the invocation shape in the source text
  (`assert.match(source, /"-o", output/u)` +
  `assert.doesNotMatch(source, /"-o", "-"/u)`). Weak alone, but it is the
  only fast guard for a port whose real body needs minutes of I/O.

Related: `mem:gotcha-assertions-detached-from-their-subject`,
`mem:gotcha-fixture-derived-from-export-under-test-hides-every-assertion`.
