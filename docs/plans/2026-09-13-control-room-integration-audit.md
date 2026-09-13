# Control Room integration audit

Date: 2026-09-13. Follow-up to the [workspace replacement](2026-09-13-product-workspace-implementation.md), starting from shared HEAD `8b80d247e2408c20333362d9d34ea3302540b2eb`. This records source fixes and local verification; external deployment and full product-workflow acceptance remain separate obligations.

## Confirmed defects and fixes

- **Pending decisions lost during read failures.** A transient criterion or preview error changed the workspace's record identity and unmounted an outstanding release. Previously visited actions now retain their established identity for component lifetime, while unavailable observations hide and disable them. A recovered read reveals the same pending decision or exact refusal. Actual session, run, selected artifact, contract and candidate changes still reset the controls. Tests reproduce the failure with real release components and unresolved dispatch promises.
- **Failed preview commands waited for the startup deadline.** Immediate child exit, including exit zero without a listener, and asynchronous spawn errors did not end readiness polling. They now return the existing `PREVIEW_START_TIMEOUT` refusal promptly through normal cleanup. Readiness also rechecks termination after listener ownership probes. Process liveness remains independently measured for source cleanup.
- **Closed preview supervisors still admitted work.** A new start after `close()` could extract source, install packages and spawn a server before being stopped. Admission now refuses before the runner is entered. Work already in flight retains its existing eventual cleanup behavior.
- **Cutover census included host-local checkout copies.** Existing `.claude/worktrees` contained about 70,000 entries and exhausted the 10,000-entry limit. An exact root-relative exclusion is now recorded in the manifest. Other `.claude` files, nested lookalikes and ordinary `worktrees` directories remain admitted. Limits stay at 10,000 entries and depth 32; callers can explicitly include the excluded path.

## Publication fixture correction

The local bare-repository release fixture contradicted the production remote contract. Its default test now requires `PUBLISH_APPROVAL_REQUIRED @ DAEMON_INGRESS` and proves that a publisher tick produces no publication request, receipt, remote ref, published release SHA or PR subprocess call.

The original positive browser assertions remain available with an explicit admitted-remote opt-in. This is a declared coverage change, not new evidence of a successful PR journey. Details and exact opt-in variables are in [release browser coverage](../../tests/e2e/control-room/release-approval.md).

## Verification for workspace commit `d461c50a`

| Gate | Result |
|---|---|
| Workspace typecheck | Passed |
| Control Room | 231 files, 2,930 tests passed |
| Daemon | 628 files, 11,184 tests passed, 21 skipped |
| Root | 454 files passed, 10,610 tests passed, 50 skipped |
| Foundation | 35 files, 756 tests passed |
| Store | 54 files, 709 tests passed |
| Security | 12 files, 1,003 tests passed |
| Distribution and version surfaces | 6 files, 567 tests passed |
| Node runtime imports | Preview runner, dependency boundary and shared product model passed |
| Local publication refusal | One real-daemon journey passed, including downstream cutoff |
| Final browser checks | Desktop at 1,440px, phone at 390px and two production smoke checks passed |

The UI and preview lifecycle fixes received independent review. Focused tests established failure before each fix. Product-workspace screenshots showed no clipping or horizontal overflow; navigation, focus, history and fixture isolation checks passed. These screenshots did not cover the project manager's composed page. The last build left `apps/control-room/dist` in production mode.

## Manager front-door follow-up

Inspection of the actual source manager exposed a separate layout gap that was also present before `d461c50a`: the manager inherited the workspace's two-column sidebar grid without supplying a sidebar. Its brand occupied a full-height left column. At 390 by 600 pixels the pairing confirmation button was clipped, and the page could not scroll to reveal it. The manager now owns a top header and scrollable content region across pairing, connection notices and the project list. Refresh refusals remain in the same content flow as the retained list.

Existing projects appear before the folder setup form. A native Add project link moves keyboard focus to that form. Mobile header text aligns left, the two actions share a row, and reduced-motion preferences apply to the new link.

The first background source-manager launch also lacked a usable operator input. Pairing could issue a label even though no input consumer could approve it. The repaired local launcher owns an open private input pipe and uses the supported `projects --operator-stdin` mode. Restarting invalidated the earlier browser label; a fresh user-provided label is required. This operator-channel repair does not establish that the user's browser has claimed a session.

The manager now observes its operator stream until EOF or failure. An unavailable channel refuses new pairing requests and unapproved claims with `OPERATOR_CHANNEL_UNAVAILABLE @ PROJECT_MANAGER_HTTP`; the browser shows terminal-restart recovery instead of an unusable label. Existing approved claims and busy reservations retain their original behavior. Successful response bodies and bootstrap schemas are unchanged.

Follow-up gates passed: workspace typecheck; Control Room 232 files / 2,945 tests; daemon 628 files / 11,193 tests, 21 skipped; root 454 files / 10,610 tests, 50 skipped; foundation 756 tests; store 709 tests. The final six production-bundle browser cases passed, covering pairing, populated lists, refresh failure, unavailable input, short screens at 390px and 320px, keyboard navigation and reduced motion. The browser API responses for authenticated states are explicit fixtures; they do not establish a live paired session. Separate inspection of the running source manager at 1,440px and 390 by 600 pixels found no overflow, clipped confirmation button, failed asset request or browser error. All fixes received independent review. The final build remains production mode.

## Local application identity and remaining limits

The daemon observed starting at 13:19 was the installed PyCharm Moe plugin's bundled `daemon/index.js`. It is a separate runtime from this checkout's web Control Room. The new source bundle contains the Products workspace. An HTTP read from the source project manager at `http://127.0.0.2:39122` matched the built JavaScript byte-for-byte.

Interactive pairing requires the source manager's operator console. The supported source launch is `pnpm exec moe projects` from `D:\projexts\moe-next`; opening a project then displays Products. An HTTP bundle check alone does not establish a paired project session or a running worker.

The earlier full live-provider journey remains unproven after a real provider exited 1 without a module. No unchanged provider retry was used to turn that result into a pass. A positive remote publication journey was not run in this audit. Durable product/revision history, the full feedback workflow and external acceptance remain roadmap work.

Shutdown still waits for already-started preparation/capture work to reach its existing bounded deadlines before cleanup. Immediate cancellation would require an explicit cancellation/ownership contract across those stages. This audit does not claim a hermetic preview runtime or instantaneous cancellation.
