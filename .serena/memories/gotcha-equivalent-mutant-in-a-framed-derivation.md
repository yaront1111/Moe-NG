# A framed-derivation drill survives if you keep the separator

## The trap
Production derives an injective id by BOTH length-prefixing each component AND joining with a
separator:

    `${NS}${a.length}:${a}|${k.length}:${k}`

Two independent defenses, one test table. The obvious "make it naive" drill removes only the length
prefixes:

    `${NS}${a}|${k}`     // <- ALL 12 codec tests stayed GREEN

That is an equivalent mutant with respect to the table, because the collision table
(`activation-ledger-codec.test.ts:32-42` on task-df29871bfc2441659efb3f763ddb23db) is built from
pairs that collide under a NO-separator join — ('a','bc') vs ('ab','c'), ('abc','') vs ('','abc') —
and its self-described "separator-bearing" rows smuggle `:` (the length delimiter) and never `|`
(the component separator). With `|` still in place all ten ids stay distinct.

Dropping the separator too is the drill that discriminates:

    `${NS}${a}${k}`      // AssertionError: expected 5 to be 10  <- 10 ids collapse to 5

## Why this matters twice over
1. A green drill reads as "guard not load-bearing" and tempts you to reject a CORRECT production
   file. The guard here was fine; the mutation was wrong. Cf.
   `mem:mutation-drill-green-may-indict-the-mutation`.
2. It is also a genuine, smaller test-coverage finding worth reporting as non-blocking: the table
   claims to cover separator-bearing components but covers the wrong separator. One pair whose
   component contains a literal `|` would close it.

## Rule
When production stacks N defenses in one expression, a single-defense mutation tests only the
defense the table was written against. Before believing a green drill, ask which defense the
fixtures were designed to break, and mutate THAT one — or mutate all N.

## Restore discipline that made this safe
`sha256sum <file> > /tmp/x.sha` first; mutate and restore with the Edit tool (never `git checkout`,
which reverts to HEAD and would destroy uncommitted peer work in this shared worktree); finish with
`sha256sum -c /tmp/x.sha`. Note `python3` is NOT on PATH in this Git Bash environment — a heredoc
mutation script fails with "command not found" and the drill then reports the UNMUTATED suite as
green. Always echo proof the mutation is live (`grep -n` the new text) before trusting the run.
