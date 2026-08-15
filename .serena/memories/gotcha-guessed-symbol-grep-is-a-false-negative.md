# A grep for a GUESSED symbol name returning zero is not evidence of absence

Two separate blocks on this board rested on a zero-hit grep, and **both greps were wrong**. Each
cost a task real time; one nearly inverted an architectural decision.

## Instance 1 — a barrel that re-exports through a differently-named file

    grep -n "telemetry" packages/runner/src/index.ts   ->  ZERO hits

Read as "the telemetry surface is unpublished, report blocked". **False.** The root does
`export * from "./surface/claude-surface.js"` (index.ts:162), and `claude-surface.ts:167-212`
re-exports all three telemetry modules by name. Nothing in the barrel contains the string
"telemetry", so the grep could never have found it.

Only a **compiled probe** settled it: importing `parseClaudeResultTelemetry` from the bare
`@moe/runner` typechecked exit 0, with a negative control (impossible symbol) failing TS2305 exit 1.
This is exactly why the workspace-edge rail demands a probe rather than a root-barrel grep — and
note it failed in the direction that COSTS A TASK, not the direction that lets a bug through.

## Instance 2 — symbol names that never existed

A block on `task-0c89476b` (Disaster restore proof) stated:

> nothing mints an incarnation, installs a slot, or advances a key epoch.
> grep for mintIncarnation/slotInstall/keyEpoch returns only the recoveryIncarnationRef FIELD

`mintIncarnation` and `slotInstall` return zero — because **those names were invented by the
auditor**, not read off the code. The real landed surfaces:

- mint → `mintGenesisIncarnation`, `createRecoveryIncarnationService`
- slot → `anchorIncarnation`, `hasAnchoredIncarnation`, `readAnchoredIncarnation`
- key epoch → 145 non-test hits (`readKeyEpochPointer`, `writeKeyEpochPointer`, `commitSuccessionRecord`)
- controller → `runRestoreQuiesce`, `runSnapshottedRestoreQuiesce`, `verifyRestoreGeneration`

The block stood for days and told later readers "do NOT re-derive the audit", so the error
propagated with authority attached.

## Why it is so convincing

A zero-hit grep looks like a measurement and reads like proof. But it confirms only that *this
string* is absent — which is equally consistent with "the capability is absent" and "you guessed
the wrong name". The two are indistinguishable from the output alone, and the wrong reading is the
one that produces a confident BLOCKED.

## Rule

Never conclude absence from a grep whose search term you *chose*. Establish absence by:

1. **Listing the territory** — `ls` the directory, `grep -n '^export'` the module. You cannot
   mis-guess a directory listing.
2. **A compiled probe with a NEGATIVE control** — a probe that was never compiled also "passes",
   so an impossible symbol must fail (TS2305) in the same run.
3. **A positive control on the same grep shape** — run it for a term that MUST hit
   (`mem:qa-positive-control-on-an-empty-grep`).

And when a stale block cites a zero-hit grep, re-measure by listing before trusting "do not
re-derive this audit" — that instruction is what makes a wrong measurement durable.

Related: `mem:deps-done-is-not-deps-reachable`, `mem:moe-block-conditions-go-stale-silently`,
`mem:gotcha-stale-block-premise-strands-an-approved-plan`.
