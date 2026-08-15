# Gotcha: appending a daemon command kind is never a one-file change

Found 2026-08-09 on `task-671578e5` while adding `goal.close` to `BOOTSTRAP_COMMAND_KINDS`.

A task whose owned paths name only `apps/daemon/src/bootstrap/bootstrap-contracts.ts`
"(command-kind vocabulary only)" **cannot** append a kind without touching three more files.
None of them are discoverable from the task description.

## The type wall

`apps/daemon/src/bootstrap/bootstrap-sequence.ts`:

```ts
export const COMMAND_PREREQUISITES = Object.freeze({ ... }
  as const satisfies Readonly<Record<BootstrapCommandKind, readonly BootstrapCommandKind[]>>);
```

`BootstrapCommandKind` is derived from `BOOTSTRAP_COMMAND_KINDS`, so widening that array
makes the record non-exhaustive and `tsc` fails **in a file the task does not own**. There is
no way to stage the two edits apart.

## The assertion wall

Two suites pin the list by hand-written literal AND length, exactly as the rails require:

- `bootstrap-services.test.ts` — `OWNED_KINDS` literal, `toHaveLength(9)` twice
- `bootstrap-durability.test.ts` — `expect(sequence).toHaveLength(9)`

Both are correct, non-vacuous assertions (`mem:decision-daemon-bootstrap-command-ingress`
explains why the literal is restated rather than derived). Appending a kind MUST move them,
and the DoD that asks for the set-equality pin is the same DoD that makes editing them
mandatory. Also `bootstrap-test-fixtures.ts` `bootstrapSequence()` must gain the new entry,
since the durability sweep drives it by index.

## What to do

Treat "append a command kind" as a five-file change and say so in the step note before QA
finds it: contracts (the array), sequence (the prerequisite entry), the two pinning suites,
and the shared fixture. Adding the entry to `COMMAND_PREREQUISITES` is not scope creep — it
is the only way the array edit compiles.

## Bonus, same session: a mutation survivor in the ingress

Neutralising `keys.length !== BOOTSTRAP_REQUEST_KEYS.length` inside `hasExactKeys` leaves the
whole suite green. It is a genuinely redundant operand: `keys.every(KEY_SET.has)` still
catches extra keys, and `isExactEnvelope` independently checks all nine fields, so a missing
key cannot pass either. Drill the MECHANISM (`hasExactKeys(request)` -> `true`, which reddens
"refuses an envelope carrying an extra key") rather than one of two mutually redundant halves.
Same family as `mem:gotcha-redundant-operand-mutants-survive-inside-one-guard`.

Related: `mem:task-task-671578e5c0f649b0a3c80567ad0677a6-handoff`,
`mem:gotcha-shared-frozen-vocabulary-couples-foreign-sweeps`.
