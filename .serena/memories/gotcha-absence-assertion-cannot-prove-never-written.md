# An absence assertion cannot prove NEVER-WRITTEN — disable the cleanup and re-run

`expect(existsSync(secretPath)).toBe(false)` after a failure path is satisfied EQUALLY by
"never written" and by "written, then deleted". Only the first closes the window. A
`try { write() } finally { rm() }` fix passes the absence assertion while the secret still hits
disk for the duration of the failing operation.

## The instrument: a negative-control drill

With the real fix in place, temporarily disable EVERY cleanup path (the per-item `rmSync`, the
`process.once("exit")` sweep — all of them), then re-run the failure-path case. The file must
STILL never appear. If it appears once cleanup is off, the code was writing-then-deleting and the
fix is the wrong shape.

## Run the WHOLE file, not just the one case

The other cases are a free positive control. If the drill silently failed to apply, they stay
green and the "pass" means nothing. In moe-next this read:

    3 failed | 3 passed (6)
    x hands the agent's credential to the MCP server ...
    x kills a hung agent after its lifetime bound ...
    x removes the config file on the error path too

— the three cleanup-dependent cases red (drill applied; written files DO survive and ARE visible
to these assertions), the refusal case green (never written). Without the reds, the green proves
nothing.

Generalises past credentials: temp files, lock files, partial uploads, outbox rows. Anywhere the
requirement is "must not exist even briefly", the absence assertion is necessary and not
sufficient.

Related: `mem:task-task-89071eb1ea0d4ccd8015f61d10cd89f6-handoff`,
`mem:qa-pair-a-publication-probe-with-a-negative-control`,
`mem:mutation-drill-that-applied-nothing-reads-as-green`.
