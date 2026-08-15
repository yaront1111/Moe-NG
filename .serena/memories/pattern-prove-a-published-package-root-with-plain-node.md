# Prove a published package root with plain Node, not with vitest

Confirmed 2026-08-09 finishing `task-6054520b` (publish the @moe/daemon command surface).

A task whose objective is "an external consumer can drive this package" CANNOT be verified
by the package's own vitest run. Vitest resolves a NodeNext `"./x.js"` specifier back to
`x.ts`, so a curated root re-export block stays 46/46 green while plain Node dies with
`ERR_MODULE_NOT_FOUND` on the very first `.js` specifier. That is exactly how this task
blocked: green focused suite, broken external surface.
See `mem:gotcha-vitest-hides-missing-js-bridge`, `mem:gotcha-missing-runtime-bridge-invisible-to-vitest`.

## The probe that actually proves it

Run from inside the package so workspace resolution applies, and import the ROOT
specifier, never a path:

```bash
cd apps/<pkg> && node --experimental-strip-types -e "
import('@moe/daemon').then((m) => {
  console.log('exports', Object.keys(m).length);
  for (const n of ['GOAL_HANDLERS','claimWork','evaluateDoctorCommandBytes']) console.log(n, typeof m[n]);
  const leaked = ['PROJECTION','streamPort','ledgerIdsUpTo'].filter((f) => f in m);
  console.log('fixtures leaked:', leaked.length === 0 ? 'NONE' : leaked.join(','));
}).catch((e) => { console.log('FAILED', e.code, e.message.split('\n')[0]); process.exit(1); });
"
```

Assert three things, not one: the import RESOLVED, a named export is the expected `typeof`
(a TDZ-undefined binding imports fine and only fails at first use), and no test-fixture
name leaked onto the runtime surface.

Same probe proves advisory discipline survives publication — call the published function
and read `advisoryOnly` / `authority` off the real result rather than a fixture:

```
outcome REQUEST_INVALID / code GRAPH_PREVIEW_REQUEST_INVALID / advisoryOnly true / authority NONE
```

## Two traps that cost time here

1. **Shell cwd persists between tool calls.** The probe needs `cd apps/<pkg>`, and every
   LATER `git ... -- <repo-relative path>` then silently matches nothing and prints empty
   output — which reads exactly like "clean working tree". I briefly concluded a file was
   committed when the pathspec had simply resolved against the wrong directory. `cd` back
   explicitly, or prefix each git call with the repo root.
   Related: `mem:gotcha-git-checkout-restore-resolves-pathspec-against-shell-cwd`.
2. **Bridges belong to a package-wide sweep task, never to the publishing task.** Adding a
   few `.js` bridges to make your own re-exports load is a PARTIAL sweep, and the gap is
   invisible to vitest — the next module to be re-exported breaks Node again. The architect
   on this task retracted their own "apps/daemon needs no bridges" rail for this reason:
   a package needs bridges the moment its root re-exports local modules.
