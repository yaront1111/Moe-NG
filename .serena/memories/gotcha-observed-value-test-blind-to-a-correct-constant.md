# A "we READ it" test cannot see a hard-coded constant that happens to be right

Found on `task-1cafc7f9` (2026-08-09) by the step-6 mutation drill, in
`apps/daemon/src/recovery/doctor-version.node.ts`.

## The defect

DoD said: prove the value is observed by asserting it equals what the TEST reads
from the same accessor — never against a hard-coded string. So the test was:

```ts
expect(readObservedRuntime().node).toEqual({ known: true, value: process.version });
expect(observed.node.known && observed.node.value).toMatch(/^v\d+\.\d+\.\d+/);
```

Drill: replace the reader body with `known("v24.16.0")`. **Suite stayed GREEN,
19/19.** On this host `process.version` IS `"v24.16.0"`, so both sides of the
comparison are the same literal. The shape regex passes too — a correct constant
is correctly shaped.

**Reading the same host on both sides cannot separate a read from a constant.**
The letter of "compare against what the test reads" was satisfied; the intent
was not. This survives any number of extra assertions about the value.

## The fix that actually bites: move the live property

```ts
function withProcessValue(key: string, value: unknown, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, key);
  expect(original).toBeDefined();
  try {
    Object.defineProperty(process, key, { value, configurable: true, writable: true });
    body();
  } finally {
    if (original !== undefined) Object.defineProperty(process, key, original);
  }
}
```

Then assert the reader returns a value **no constant could match** (`v9.99.99`,
`sunos`, `mips`). Any literal now reddens. `process.version`, `process.platform`
and `process.arch` are all redefinable this way under Node 24 + vitest; capture
and restore the ORIGINAL DESCRIPTOR, not the value, or you leave `writable:true`
behind on a property that was read-only.

Bonus: the same helper reaches the unreadable branch (`value: undefined`), which
had NO test — a code that is declared in the frozen vocabulary and emitted by no
test is the dead-entry half of `mem:gotcha-daemon-refusal-code-vocabulary-drift`.

## Generalisation

Applies to ANY "this is observed, not restated" claim where the test and the
production code read the same source: `process.*`, `os.*`, `import.meta`, env
vars, `Date`. **If the test cannot make the source say something surprising, it
cannot tell you the source was consulted.** Either inject the source or move it.

Corollary for drills: a mutation that uses the CORRECT value is the strong drill
here. A wrong constant reddens trivially and proves much less.

Related: `mem:gotcha-daemon-refusal-code-vocabulary-drift`,
`mem:task-task-1cafc7f9fcdc4c9299860b6b1e38275d-handoff`.
