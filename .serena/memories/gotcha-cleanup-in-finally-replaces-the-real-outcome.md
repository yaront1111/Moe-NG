# A throw from `finally` REPLACES the return value and escapes the surrounding catch

## The shape
```js
try { ... return releaseRefusal("SBOM_GENERATION_FAILED"); }
catch { return releaseRefusal("EVIDENCE_WRITE_INTERRUPTED"); }
finally { process.off(...); cleanRoots(roots); }   // <-- cleanRoots can throw
```
If `cleanRoots` throws, the caller gets the cleanup error — not the refusal, not the
success. The `catch` above it does NOT help: a `finally` throw escapes its own try/catch.
So a truthful, specific refusal silently becomes a wrong one, which under fail-closed rails
is worse than no code at all: it routes the operator to the wrong subsystem.

`rmSync(..., {force: true})` is not protection. `force` suppresses **ENOENT only** —
EISDIR, EBUSY, EPERM all still throw.

## Where to fix it
Inside the cleanup helper, not by wrapping the `finally`:
1. A wrapper around the whole call abandons every remaining root after the first failure;
   a per-item `try/catch` keeps cleaning the rest.
2. The same helper is usually also called by the SIGINT/SIGTERM handler
   (`const stop = () => { cleanRoots(roots); process.exit(130); }`). Fixing the helper
   covers that path too; fixing the `finally` leaves the signal path able to throw.
3. It costs no lines in the caller — relevant when the file is already over the line cap.

Report the failure as a **subordinate** fact (stderr naming the path). Do not swallow it:
that trades a wrong outcome for a missing one, and a leaked temp root nobody is told about
is its own defect. Do not thread it into the return value either — `finally` runs after the
result is computed, so carrying it means restructuring the result shape for a footnote.

## Testing it
Force the cleanup to actually throw (see `mem:gotcha-held-fd-does-not-block-rmsync-on-windows`
for why a held handle will not) and assert the ORIGINAL exact reason comes back — once
against a success and once against a specific refusal. Then assert non-vacuity: every item
WAS removed (cleanup ran) and the obstacle SURVIVES (the throwing call was reached).

Found on task-5611791337894212a277600a0768f1f9 (moe-next, release supply chain), 2026-08-15.
