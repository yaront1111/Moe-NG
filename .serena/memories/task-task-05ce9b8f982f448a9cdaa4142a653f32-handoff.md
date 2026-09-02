# task-05ce9b8f (Security fault matrix) — QA APPROVED, zero edits

QA qa-a533e802, 2026-08-20, HEAD 0c32df957d8aa3d0a9e6c78b5129db41c179a412.
Parent asserts nothing itself; closes on seven DONE SPIDR children. No commit bears this
task id and there should not be one — verified by EVIDENCE, per board rail.

## What QA reproduced independently (not read off the worker's note)
- `git status --porcelain -- tests/security tests/fault` = 0 lines before, between, after
  every run and after both mutation drills. HEAD unmoved across the whole review.
- Plan-literal scan `^export const [A-Z_]*(LAYERS|LAYER|BOUNDARIES) = ` = **99**.
  `EXPECTED_ROSTER_SIZE = 102` (boundary-roster.security.ts:332). 99 + 3 annotated
  single-value layers = 102 = axis sum 15+17+16+25+29. NOT drift; roster :533/:538/:543
  regression-test the ` = `-anchor miss by name.
- `pnpm test:fault` EXIT=0 — `Test Files 10 passed (10)`, `Tests 83 passed (83)`.
- `pnpm test:security` EXIT=0 — `Test Files 10 passed (10)`, `Tests 557 passed (557)`.
- Chained `pnpm test:fault && pnpm test:security` re-run: both legs exit 0, both count
  blocks printed. Spawn probe (git --version x5) 91–106ms total. No cliff.
- Seven children DONE, read from the TOP-LEVEL status field by JSON.parse (a bare
  `grep '"status"'` matches a plan STEP first — see `mem:gotcha-moe-task-json-first-status-is-a-step`).
- 70 UNKNOWN hits in tests/security/**, ZERO OUTSIDE_SCOPE; all assert production
  declining to raise a truth class, none labels an absent subject.
- **ZERO hidden skips**: `it.skip|describe.skip|it.todo|skipIf|.only(` = 0 across both lanes.
- `assertRefusedWith` (hostile-harness.ts:248) rejects a code-only expectation at BOTH the
  type level and runtime (`HostileHarnessMisuseError`) — global rail 1 discharged in the harness.

## The ratchet is DRILL-PROVEN LIVE
See `mem:security-completeness-ratchet-is-drill-proven-live` for the two mutants and their
exact red signatures. Structure alone was not trusted.

## Fault-lane ownership — cited, never claimed
tests/fault/**: disaster-restore/** = task-0c89476b; linux/, macos/,
cross-host/effect-evidence = task-01c5f96e; cross-host/production-surfaces = task-c690a7a0;
foundation/** = Foundation canary chain. Parent authored none of it and says so.

## Do not misread
The two `CROSS_HOST_HOST_MISMATCH` / `CROSS_HOST_COLLECTOR` lines printed to stdout by the
fault lane on win32 (linux + darwin slots) are PASSING assertions, not reds.
The mid-flight security RED at HEAD 5d35739 (2 files / 4 tests) was the ratchet firing on two
unrostered layers; it was fixed by the PRODUCING task 120403f7 (tip 0c32df9, roster 100->102
+ trios, count 544 -> 557), NOT by widening the roster here. Correct attribution; ratchets rise.

Related: `mem:gotcha-refusal-roster-can-outrun-its-assertions`.
