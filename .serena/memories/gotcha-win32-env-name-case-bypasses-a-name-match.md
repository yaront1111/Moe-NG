# Gotcha: a case-sensitive environment-name match is a one-keystroke bypass on win32

Windows environment variable NAMES are case-insensitive. `Claude_Code_Effort_Level`,
`claude_code_effort_level` and `CLAUDE_CODE_EFFORT_LEVEL` are the same variable to
the child process.

Found on task-d23a913f0586431d9dccc0cfd1f66fd5 during adversarial self-review, in
a guard added earlier in the SAME task to close a QA finding. The guard refused a
child environment whose `CLAUDE_CODE_EFFORT_LEVEL` disagreed with the launch
selection, matching the key with `name in environment`. A caller supplying
`Claude_Code_Effort_Level` passed the gate and still overrode the effort.

Rules for any guard that matches an environment variable by name on win32:

1. Uppercase the NAME for the match. Keep the VALUE comparison exact — model ids
   and effort levels are case-sensitive even where names are not.
2. A JS object can hold several spellings of one name at once. Refuse that as
   AMBIGUOUS rather than resolving it: which spelling the OS keeps is not the
   guard's to guess, and duplicate evidence is not evidence.
3. Do not turn case-insensitive MATCHING into a case-insensitive BAN. A
   differently-spelled name whose value AGREES must still pass, or the arm stops
   being a comparison.

Drill it: revert the match to `key === wanted` and require the case-variant cases
to redden and nothing else. A guard that only ever sees the canonical spelling in
its own fixtures cannot discover this.

Related: `mem:gotcha-provider-launch-flags-need-real-cli-precedence-probe`.
