# Release approval browser coverage

`release-approval.spec.ts` has two distinct cases. The default case builds and verifies a real contract goal, then submits a local bare-repository path for publication. The daemon must return `PUBLISH_APPROVAL_REQUIRED` at `DAEMON_INGRESS`. After a publisher tick, the test requires no publication request or receipt, no remote ref, no published release SHA, and no PR subprocess call.

The original positive browser assertions remain in the opt-in case: published evidence, covered versus unknown criteria, the two-step release approval, the returned PR link, and the production PR arguments. It requires both `MOE_E2E_RELEASE_REMOTE_TEST=1` and `MOE_E2E_RELEASE_REMOTE_URL` naming a reachable HTTPS, SSH, or scp-style test remote admitted by the daemon. A URL alone does not enable it. This case pushes a real `moe-release-browser-<projectId>` branch and leaves that branch for inspection. It does not push the remote's base branch. The `gh pr create` subprocess remains injected; Git publication and the remote-head recheck remain real.

Without that opt-in, the positive case is reported as skipped. Passing the default refusal case does **not** recover evidence for the positive browser release journey and must not be reported as such. The separately gated `release-approval-live.spec.ts` exercises real GitHub PR creation.
