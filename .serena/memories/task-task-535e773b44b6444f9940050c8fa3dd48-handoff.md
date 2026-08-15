# Task task-535e773b44b6444f9940050c8fa3dd48 handoff

## State
- Reopen fix is complete; all 7 plan steps are COMPLETED and the task is ready for QA handoff.
- QA's sole defect was raw ENOENT from a declared-but-absent runtime entry collapsing discovery and the control tests.
- Current owned blobs are clean and committed at HEAD:
  - tests/runtime/package-loadability-support.ts: 88a47e6335916abb171007b769d348d796a7d15d (299 physical lines)
  - tests/runtime/package-loadability.test.ts: d13f0763a149b00430750fad440e04d1d51c59d0 (164 physical lines)

## Reopen fix
- WorkspacePackage is a three-state discriminated union: NO_RUNTIME_ENTRY, PRESENT, MISSING_ENTRY.
- ENOENT is classified as MISSING_ENTRY rather than thrown.
- observeWorkspacePackage returns stable {code:"MISSING_ENTRY", outcome:"MISSING_ENTRY", specifier}; observationIssues reports package name plus exact specifier and never allowlists this state.
- Permanent mkdtemp fixture discovers a good package and a declared-missing package together, proves the real-Node good probe still runs, pins the missing state/code/specifier/report, and cleans up in finally.
- The live controls and timeout case survive a bad package; only the full workspace gate reports the bad package.

## Evidence
- TDD before fix: focused runtime suite 2 failed / 5 passed (raw ENOENT plus transient @moe/import zero-export).
- Missing-entry production mutation (ENOENT misclassified PRESENT): exact permanent regression red, exit 1, 1 failed / 6 skipped; restored support hash 88a47e6335916abb171007b769d348d796a7d15d; green 1 passed / 6 skipped.
- Strict ad-hoc TSC for both owned files: exit 0.
- Runtime suite: 1 file / 7 tests passed.
- Fresh exact gate before final handoff: pnpm typecheck && pnpm test exit 0; 187 files passed; 3303 passed, 1 skipped (3304 total).
- Fresh real-Node package report: all 15 Node-entry packages imported with >0 exports; allowlist EMPTY.

## Attribution
- Original task commit daadf47 contains exactly the two owned runtime files.
- Shared-tree whole-tree hooks swept reopen bytes while this task was active: initial regression bytes into foreign 20c41a4; final support/test reopen delta into foreign 878538b.
- Do not manufacture a no-op commit. Review exact bytes with:
  git diff daadf47 HEAD -- tests/runtime/package-loadability-support.ts tests/runtime/package-loadability.test.ts
- Current owned paths and shared index are clean. No package bridge or package.json path was edited by this task.
