# Control Room merge audit

Date: 2026-09-13. This integrates the product workspace commits `d461c50a` and `0b255111` with upstream main `2d7d5b30`, preserving its 39 intervening fixes. The integration uses a separate temporary clone so the shared checkout's uncommitted source, configuration and staged deletions remain untouched during verification.

## Merge decisions

- Keep the product workspace as the default project view and the manager's dedicated header and scrolling content region.
- Keep the newer sessions decoder and daemon read contract together, including seat start times and exit observations.
- Combine the upstream no-plan presentation with the exact-body review gate. An authorization offer cannot make an unreadable, incomplete or differently bound plan approvable. Pending decisions and their exact refusal remain visible when an offer disappears.
- Keep upstream statement folding while allowing historical definitions to disclose their contents. Historical decision commands remain refused by their action ports.

## Additional reproduced defects

- Manager and single-project launchers returned an exit result while their operator stdin reader kept the executable alive. Real Node child tests reproduce the hang with the parent pipe left open. Shutdown must cancel and await the owned reader.
- A late automatic project-list read could overwrite a newer manual refresh, restoring stale Running controls. Older successes and refusals must not replace the latest list or its report.
- The workspace Refresh action did not retry the independent definition-card read. Refresh must retry that read without replacing a pending decision's identity.
- Starting a definition decision before the initial background reads finished left selection implicit. A later artifact could become the default and unmount the pending decision. The selected definition is now pinned when a decision starts, including clarification answers.

The first clean-clone root and daemon runs refused native process probes because the Windows Job broker had not yet been built in that checkout (`PROCESS_BOUNDARY_BROKER_UNRESOLVED`). The repository's locked release build command supplied that prerequisite before rerunning the gates. No production guard or expected refusal was relaxed.

## Verification

Fresh checks on the combined tree after building the native broker:

- Workspace typecheck passed, including both application projects.
- Root: 454 files, 10,610 tests passed; 50 tests skipped.
- Daemon: 632 files, 11,250 tests passed; 21 tests skipped.
- Control Room: 240 files, 3,033 tests passed.
- Security: 12 files, 1,003 tests passed.
- Foundation: 35 files, 756 tests passed. Store: 54 files, 709 tests passed.
- Browser suite typecheck passed. Eleven Chromium checks passed: two product desktop/phone cases, six manager layout cases, one isolated-daemon Gate 1 approval journey, and two production smoke cases.
- Product and manager screenshots were inspected at desktop and phone sizes, including short-phone pairing and refresh refusal. No layout overflow regression was observed. The production smoke ran last and left the production build.

Browser examples remain explicit fixtures and isolated test daemons; they do not certify the user's paired live project, provider completion or remote publication acceptance. GitHub checks and merge provenance are recorded on the pull request after publication.

## Cross-host follow-up

The push Linux run for `378e0df5` exposed a timing defect in `dispatch-crash-sweep.e2e.test.ts`; the PR's Linux run passed against the identical Git tree. The fixture never selected a configured context seal. Dispatch therefore committed `RESERVED`, awaited workspace preparation, and recorded `UNPROVEN` with `FOUNDATION_CONTEXT_SEAL_UNCONFIGURED @ FOUNDATION_CONTEXT_SEAL`. The 10 ms poll could miss that entire interval. A passing run only proved that it happened to interrupt preparation before the expected refusal.

The repaired crash journey declares a test-only dependency module that pauses after real workspace preparation and signals the parent over IPC. It keeps the production HTTP ingress, registry, reservation, process kill and reconciliation sweep. Normal completion and resumed-pause controls both prove the exact seal refusal and one terminal record. The original timing failure was reproduced locally before the repair; the three cases and harness checks then passed, with foundation e2e typecheck green.

The push Windows run also found an immediate-deletion assertion in the preview capture-failure test. The existing production cleanup intentionally retains live or locked source and retries removal after observation; an immediate filesystem assertion cannot establish eventual cleanup or a leak. Follow-up verification measures process and listener shutdown separately from source reclamation.

A real Windows file lock reproduced the deferred removal: cleanup retried `EPERM` and removed the source after 665 ms. The repaired assertions require observed PID death, listener `ECONNREFUSED`, and source removal within a bounded interval while preserving the original workspace. No runtime cleanup rule changed. Both test repairs received independent review. Follow-up workspace typecheck and root gate passed (454 files, 10,612 tests; 50 skipped), as did the foundation crash/harness checks (38 tests) and preview source checks (17 tests).
