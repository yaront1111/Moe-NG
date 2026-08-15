# Gotcha: "no .js bridge is added" in a DoD collides with the size rail that forces extraction

Found on `task-7d0abdcd` (QA, 2026-08-09), and it will recur on every publish-the-package-root
task, of which there have now been five.

## The shape

These tasks ship two things at once:

- **DoD "zero behaviour change"**, typically worded: *git diff shows index.ts as the only
  modified non-file, no .js bridge is added or removed*. Intent: nobody quietly re-bridged an
  EXISTING module while claiming to only re-export.
- **A size rail**: *if index.ts passes 250 lines, extract per-area re-export modules* — plus a
  companion rail *any new module needs its sibling .js bridge in the SAME commit*, because the
  package is bridged and covered by the repo-wide runtime-loadability gate.

When index.ts does pass 250 lines — it did, three inline blocks would have taken it to ~333 —
the rails MANDATE new modules, and each mandated module MANDATES a new `.js` bridge. The DoD
clause then reads as violated by a diff that is following orders.

## Ruling

Read the DoD clause as scoped to PRE-EXISTING modules. A bridge added for a module created in
the same commit under the extraction rail is compliant. Reject only if a bridge appears next to
a module that already existed, or if one disappears.

**Do not reject on the literal clause.** It is a stale-by-construction wording, not a defect —
the DoD was written before anyone knew whether the 250-line threshold would trip.

## What to verify instead, since the literal check is unusable

1. Every new `.js` is a one-line `export * from "./<same-name>.ts";` matching the repo's
   existing bridges (`cat packages/runner/src/recovery/safe-boundary.js` for the convention).
2. The bridge actually loads in plain Node, not just vitest — probe the ROOT from a package
   that depends on it: `cd apps/daemon && node --experimental-strip-types --input-type=module
   -e "const ns = await import('@moe/runner'); console.log(Object.keys(ns).length)"`.
   From the repo root this is `ERR_MODULE_NOT_FOUND` and proves nothing.
3. No module under the subtrees being published was touched — `git show --stat` is enough.

Related: `mem:task-task-7d0abdcd586742548a0733f7f71985c1-handoff`,
`mem:gotcha-export-star-collision-is-silent`, `mem:gotcha-vitest-hides-missing-js-bridge`.
