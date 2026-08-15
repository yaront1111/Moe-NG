# A mutation that fails to APPLY reads exactly like a mutant that SURVIVED

Found 2026-08-09 drilling `task-58029c26` (@moe/review).

## What happened

Drill 2 used a brace-delimited perl substitution whose pattern itself contained `{`:

```sh
perl -0pi -e 's{if \(!a \|\| !b\) \{}{if (false) {}s' file
```

Perl parsed the inner `\{` as the delimiter's close, then choked:

```
Unknown regexp modifier "/t" at -e line 1, at end of line
Substitution pattern not terminated at -e line 2.
```

The file was **never modified**. The drill then reported:

```
################ DRILL: 2 unresolvable-fact branch -> if (false)
 Test Files  2 passed (2)
      Tests  82 passed (82)
```

which is indistinguishable from a genuine surviving mutant — the exact conclusion
that would have been written up as "this guard is untested". The perl error scrolled
past above the drill banner.

## Rules

1. **Verify the mutation applied.** Hash before and after; shout if unchanged:

```sh
before=$(git hash-object "$f"); perl -0pi -e "$sub" "$f"
[ "$before" = "$(git hash-object "$f")" ] && echo "!! MUTATION DID NOT APPLY to $f"
```

2. **Pick a delimiter absent from both sides.** `#` works for TypeScript conditions;
   `{}` never does, because source is full of braces. `!` clashes with negations.
3. **Never read a green drill as a survivor without seeing the mutated bytes.**
   A survivor and a no-op are the same output.
4. **Re-drill after refactoring.** Patterns match SOURCE TEXT. When the self-review
   extracted `!input.authorshipResolved` into `authorshipKnown(input)`, the old drill
   patterns silently stopped matching and had to be rewritten.

Related: `mem:mutation-drills-in-shared-worktree`,
`mem:gotcha-mutation-drill-swept-by-foreign-completion-hook`.
