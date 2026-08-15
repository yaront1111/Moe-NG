# A refusal-only suite ships a gate that refuses EVERYTHING

Epic rail 6 pushes hard on asserting reason codes for failure paths. The blind
spot on the other side: a guard that is **always closed** passes every refusal
test in the file. Only a POSITIVE CONTROL can tell "correctly strict" from
"broken shut".

Live example, `apps/daemon/src/recovery/recovery-completion.ts`:

```ts
const rest = stepUpAuthRef.slice(PREFIX.length);   // "2026-08-10T23:59:00.000Z:<hex64>"
const separator = rest.indexOf(":");               // BUG: hits the "T23:59" colon
const at = rest.slice(0, separator);               // "2026-08-10T23" -> never an instant
```

Every stale/opaque/future step-up test stayed green. Four tests reddened — all
of them positive-path — with `RECOVERY_COMPLETION_APPROVAL_INVALID`. Fix is
`lastIndexOf(":")`, because an ISO instant carries two colons of its own.

Rules that follow:
- Any parser splitting a composite ref needs BOTH a valid case and an invalid
  one. Timestamps, URLs and namespaced ids all embed the obvious delimiter.
- When a mutation drill removes a guard and the named test reddens on
  `expect(outcome.ok).toBe(false)`, that proves the guard runs but NOT that its
  code assertion is load-bearing. Run a second drill that changes only the
  emitted code literal and confirm the test reddens on
  `Expected: <CODE> / Received: <OTHER>`.

Related: `mem:qa-refusal-code-absent-from-test-file`,
`mem:mutation-drill-red-on-wrong-assertion`.
