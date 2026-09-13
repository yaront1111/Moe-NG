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

## Fresh verification

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

The UI and preview lifecycle fixes received independent review. Focused tests established failure before each fix. Final screenshots showed no clipping or horizontal overflow; navigation, focus, history and fixture isolation checks passed. The last build left `apps/control-room/dist` in production mode.

## Local application identity and remaining limits

The daemon observed starting at 13:19 was the installed PyCharm Moe plugin's bundled `daemon/index.js`. It is a separate runtime from this checkout's web Control Room. The new source bundle contains the Products workspace. An HTTP read from the source project manager at `http://127.0.0.2:39122` matched the built JavaScript byte-for-byte.

Interactive pairing requires the source manager's operator console. The supported source launch is `pnpm exec moe projects` from `D:\projexts\moe-next`; opening a project then displays Products. An HTTP bundle check alone does not establish a paired project session or a running worker.

The earlier full live-provider journey remains unproven after a real provider exited 1 without a module. No unchanged provider retry was used to turn that result into a pass. A positive remote publication journey was not run in this audit. Durable product/revision history, the full feedback workflow and external acceptance remain roadmap work.

Shutdown still waits for already-started preparation/capture work to reach its existing bounded deadlines before cleanup. Immediate cancellation would require an explicit cancellation/ownership contract across those stages. This audit does not claim a hermetic preview runtime or instantaneous cancellation.
