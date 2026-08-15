# Publishing a fairness validator reddens a file you do not own

`packages/scheduler/src/fairness/fairness-contract.test.ts` holds a
`RUNTIME_MODULES` table of `[moduleName, module, expectedExportCount]` and
asserts `Object.keys(module).length === count` per module (around line 620).

Adding ANY export to `fairness-work-item.ts`, `fairness-ring.ts`,
`fairness-evidence.ts` or `fairness-cap-revision.ts` breaks that hand-written
number, in a file your task almost certainly does not own. There is no way to
land the export without the one-line edit — the guard is deliberately closed so
a new export is a reviewable act.

Prove it was forced the same way QA should check it: revert just that one line
and the file goes red while everything else stays green.

The same file also policies export NAMES (`validate*` / `is*` prefixes, a closed
`RESULT_CONSTRUCTORS` allowlist, and an `AUTHORITY_NAME` regex banning
`next|order|sort|rotat|select|charge|promot|rank|decid|pick|schedul`). A new
fairness export must satisfy those too, or the count fix alone will not save you.

Sibling hazard in the same package: `scheduler-runtime-entrypoint.test.ts` pins
`fairnessIssueCodeCount` and `fairnessLayerCount` through a worker smoke test —
adding a fairness CODE or LAYER reddens that instead.
