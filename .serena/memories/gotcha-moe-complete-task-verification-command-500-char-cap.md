# `moe.complete_task` caps `verification.command` at 500 chars

Undocumented, and it bounces the call AFTER the gate has already been run:

```
MCP error -32602: [INVALID_INPUT] Invalid verification.command: too long (max 500 chars)
```

The `summary` field is far more generous (a ~3.5k-char summary was accepted on
`task-f5d1dae629ec4c8bbb74b370c0a1d789`), and `outputTail` takes ~2000. It is
only the COMMAND string that is tight. Compare `mem:gotcha-qa-summary-hard-capped-at-2000-chars`
and `mem:gotcha-moe-report-blocked-reason-capped-at-2000-chars`.

This bites exactly the tasks whose plan names a single composite PowerShell gate
with an inline `node -e` probe. The natural formulation

```
& { pnpm --filter @moe/x typecheck; if ($LASTEXITCODE) { exit $LASTEXITCODE }; ... Push-Location apps/x; try { node --experimental-strip-types --input-type=module -e "..." } finally { Pop-Location } }
```

lands around 620 chars and is rejected.

## How to stay honest under the cap

Do NOT paraphrase the command you actually ran into a shorter fiction — the
field is evidence. Re-run a genuinely shorter equivalent and submit THAT, with
its own fresh output. What bought ~140 chars on the daemon root-publication gate:

- `if($LASTEXITCODE){exit 1}` instead of `if ($LASTEXITCODE) { exit $LASTEXITCODE }` (the daemon leg's own exit code is already in `outputTail`).
- drop `--input-type=module` and write the probe as `import('@moe/pkg').then(m=>{...})` — dynamic `import()` works in the default CJS eval, and `--experimental-strip-types` still strips the `.ts` behind the package `exports`.
- `Push-Location`/`$c=$LASTEXITCODE`/`Pop-Location`/`exit $c` instead of `try`/`finally`.
- single-letter locals in the `-e` payload.

Measure before you submit: `$cmd = '...'; Write-Output "LEN=$($cmd.Length)"; Invoke-Expression $cmd`.
Note `exit` inside an `Invoke-Expression`'d `& { }` block terminates the whole
PowerShell process, so a trailing `Write-Output "EXIT=$LASTEXITCODE"` never
prints — read the tool's own exit status instead.
