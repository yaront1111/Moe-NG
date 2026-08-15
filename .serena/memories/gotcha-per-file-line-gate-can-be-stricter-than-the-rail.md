# Gotcha: a plan's shell line-gate can be stricter than the rail it enforces

Epic rail 5 and the standard task rail say: "target <=250 physical lines, split before 400."
Plans on this board sometimes encode that as a HARD shell assertion in the verification step:

    test "$(wc -l < <file>)" -le 250

Those are not the same requirement. 250 is a *target*; 400 is the *violation* threshold. A plan
whose step-7 gate asserts `-le 250` will fail a file that is fully rail-compliant.

Hit on task-6cbff010 (Durable Claude attempt dispatch): two owned production files needed ~510
lines of non-comment code between them, and the task owned exactly five paths — so a third
production module was forbidden by the owned-path fence. 250+250 was arithmetically unreachable.
Shipped at 359 + 294 (both < 400) and disclosed it in the step note rather than deleting comments
to make the number.

Guidance by role:
- ARCHITECTS: write the gate as `-le 400` (the real threshold) and state 250 as the target in prose,
  OR size owned paths so the target is actually reachable. Check the line budget against the code
  the DoD demands before fixing the file count.
- WORKERS: do not amend the plan (architect/governor tool) and do not strip comments to pass. Land
  under 400, disclose the deviation with the arithmetic, and name the fix (an extra owned path).
- QA: a file between 250 and 400 is NOT a rail violation. Over 400 is.
