# `cargo test --test a --test b` stops after the first RED target

Found 2026-08-10 running two mutation drills at once during QA of task-05bf0e0f.

## What happened
I mutated two production surfaces and ran both affected integration targets in one command:

```
cargo test ... -p <pkg> --test handle_inheritance --test descriptor_block
```

`descriptor_block` failed, cargo printed
`error: test failed, to rerun pass -p <pkg> --test descriptor_block`, and **never ran
`handle_inheritance` at all**. Cargo runs each test binary in sequence and stops at the first
one that exits nonzero (there is no `--no-fail-fast` by default).

## Why it bites a mutation drill specifically
A drill's expected outcome is RED. Seeing "1 target reddened" and no mention of the second
reads exactly like "the second drill did not redden" — i.e. like a weak or detached
assertion in the very test you were trying to validate. It is not; that target never
executed. Concluding the guard is missing there would be a wrong rejection.

## The fix
One drill per run, or pass `--no-fail-fast`. One-at-a-time is usually better anyway: with two
mutations live you cannot attribute a failure to the mutation you meant to test, and the
restore step gets riskier in a shared worktree
(`mem:mutation-drills-in-shared-worktree`).

Also: cargo's own `running N tests` / `test result:` lines are per BINARY. Grepping
`^test result` over a whole-package run yields one line per target, several of them
`0 passed` for empty unit/doc targets. Count the named test lines, not the result lines,
when you need the real total.
