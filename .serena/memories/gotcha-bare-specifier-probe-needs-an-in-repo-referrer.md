# Gotcha: a probe script living outside the repo can never resolve a bare workspace specifier

Found on `task-17b03331` (2026-08-09) while probing `.js` runtime bridges.

## The symptom

A probe script written to the OS temp dir (deliberately, so no scratch file lands in a commit),
run with the cwd set to a consumer package:

```sh
cd apps/control-room
PROBE_TARGET='@moe/control-room-client' node --experimental-strip-types /c/.../Temp/probe.mjs
# -> {"code":"ERR_MODULE_NOT_FOUND",
#     "specifier":"Cannot find package '@moe/control-room-client' imported from C:\\...\\Temp\\probe.mjs"}
```

Four packages, four identical failures. It reads exactly like a broken `exports` map or a
missing `node_modules` link, and on a task whose whole job is resolution failures it is very
easy to bank as a finding.

## Why

ESM resolves a **bare** specifier from the importing MODULE's path, walking `node_modules` up
from there — **not** from `process.cwd()`. `probe.mjs` sits outside the repo, so no
`node_modules` on its ancestor chain contains the workspace links. `cd` changes nothing.

File-URL and relative targets are unaffected: once `import("file:///.../src/index.ts")`
succeeds, that module's own specifiers resolve relative to *it*, inside the repo. So a probe can
be simultaneously correct for path targets and structurally incapable of bare ones.

## Fix

Use an inline script, whose referrer is cwd:

```sh
cd apps/control-room
node --experimental-strip-types --input-type=module -e 'const m = await import("@moe/control-room-client"); ...'
# -> IMPORTED, 1 export, 0 undefined
```

Or place the probe inside the repo — but then it is a scratch file you must not commit.

## The rule worth keeping

A failure whose specifier names **your own probe** as the importer is a harness bug, not a
finding. Check the `imported from` clause before reporting. Same discipline as refusing to
"fix" a `node_modules` resolution failure with a bridge: read *which* resolution failed and
*who asked for it*.

Related: `mem:task-task-17b03331e4ee488a994635144cae4a53-handoff`,
`mem:gotcha-bash-tool-mangles-dollar-quoted-cr-pattern`, `mem:gotcha-vitest-hides-missing-js-bridge`.
