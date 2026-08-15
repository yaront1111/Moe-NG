# `readAnchoredIncarnation` answers null for a GENESIS anchor — and so did the writer

`apps/daemon/src/recovery/recovery-incarnation-anchor.ts` used to hard-filter:

```ts
if (binding === null || binding.origin !== "RESTORE") continue;
```

Its own doc comment said "A future genesis anchor needs its own reader." Two
consequences, and the second is the dangerous one:

1. **Reader.** Verifying a genesis anchor through `readAnchoredIncarnation`
   always yields null, so a conjunct written as "the anchor must exist" refuses
   every genesis unconditionally.
2. **Writer.** `anchorIncarnation`'s OWN idempotence lookup used that same
   restore-only reader. For a genesis binding it saw nothing, fell through to a
   second `commitExpectedVersionDecision` with `expectedVersion: 0`, and the
   store refused it as a version conflict — an idempotent retry reported as a
   FAILURE. A "second boot is idempotent" test is what catches this.

Now origin-parameterized: private `readAnchoredBindingOfOrigin(...)`, with
`readAnchoredIncarnation` (RESTORE) and `readAnchoredGenesisIncarnation`
(GENESIS) as thin wrappers, and `anchorIncarnation` looking up under
`binding.origin`. They stay SEPARATE exports on purpose — a restore caller
handed a genesis row would read `restoreCommandId` off a store that never
restored.

## The residual race, and the fix

`anchorIncarnation` reads-then-writes. Two daemons opening one store can both
see no anchor and both attempt one; the loser gets the version conflict and
returns `false`. Do not turn that into a hard startup refusal — the anchor it
wanted DID land. Re-read and accept **only byte-identical** evidence
(`genesis-recovery-binding.ts` `settle()`). Accepting unconditionally is the
wrong fix: a drill replacing the re-read with `return present(...)` reddens the
"refuses instead of claiming an INSTALLED fence its anchor never committed"
test, which is exactly the fail-closed property you must keep.

Store param types are now `AnchorDecisionReader` /
`AnchorDecisionWriter` (`Pick<SqliteEventStore, ...>`), so a caller holding a
narrow handle can anchor without the whole event store.
