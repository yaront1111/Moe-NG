# QA handoff: control-room approval refusal vocabulary

Approved DONE on 2026-08-16.

Verified ddb4753..HEAD over the seven owned paths. The task bytes were captured by foreign whole-tree commits, which is not a defect under the completion-hook rail. Production now consumes the eight @moe/core approval-authority codes and canonical layers, renders code/layer plus truthful policy/gate/grant facts, rejects forged pairings, and offers no grant/force path. Manifest and lockfile carry the @moe/core edge; a temporary bare-specifier probe typechecked and was removed.

QA runs from an ext4 snapshot with local node_modules:
- focused approval-gating: 1 file / 23 tests, exit 0
- @moe/control-room typecheck, exit 0
- @moe/control-room test: 70 files / 860 tests, exit 0
- repo typecheck, exit 0
- verify:foundation: 32 / 661, exit 0
- verify:store: 42 / 501, exit 0
- mutation of APPROVAL_HUMAN_REVIEW_REQUIRED layer made the named literal mapping test red, then byte-exact restore matched SHA-256.

Foreign repo-wide red was disclosed: packages/runner/src/platform/windows/windows-boundary.test.ts:524 lacks the host broker in an archive snapshot; apps/daemon/src/goals/j1-command-path.test.ts:121,166 refuses with GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED. No owned path intersects either. Production lines: approval-gating.ts 240, approval-inbox.tsx 231.