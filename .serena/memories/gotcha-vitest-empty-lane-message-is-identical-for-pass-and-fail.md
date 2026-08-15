# Gotcha: Vitest's empty-suite message is the same whether the run passed or failed

Found on `task-b5e9bd64` (2026-08-09) while drilling the hostile-lane
`passWithNoTests` setting.

## The trap

Run a config whose `include` matches nothing:

```
passWithNoTests: false  ->  No test files found, exiting with code 1
passWithNoTests: true   ->  No test files found, exiting with code 0
```

**Identical text. Only the exit code differs.**

So a drill, guard or CI check that greps for `No test files found` "proves"
nothing about fail-closed behaviour — it is green in both directions. The same
applies in reverse: seeing that string in a log does not tell you whether the
gate failed.

Quote the **exit code**, and prove it moves. The honest drill is the *pair*:
flip `passWithNoTests` with the include held broken, and show `code 1` vs
`code 0` for the same message. That is what makes the non-zero attributable to
that one setting rather than to some other refusal layer — the epic rail's
"assert the reason code, and which layer refused", applied to a runner.

## Adjacent, same shape

`vitest run` from inside a package prints `No test files found` too, but for a
completely different reason — the config root resolved to the package dir. See
`mem:gotcha-vitest-root-silently-finds-no-tests`. Three distinct situations, one
string.

## Related

`mem:gotcha-or-ed-layer-assertion-pins-neither-layer`,
`mem:pattern-assert-which-layer-refused`,
`mem:task-task-b5e9bd6444514d02a1e554420c0245b8-handoff`
