# Handoff: External effect supervisor — SPIDR shell (BLOCKED by design, 2026-08-08)

Parent task-312c1de3 is a decomposition shell, budget-core pattern (`mem:decision-budget-core-spidr`).
No plan was submitted; 4 children created (human-approved coarse split via REPL), all CRITICAL:

1. `task-2580a578` — Effect intent lifecycle and one-use activation gate
   (runner/supervisor pure; design 771-787/336/798; deps DONE → immediately plannable)
2. `task-4a3b5ec0` — Launch lock, process adoption, drain and restart reconciliation
   (needs 1; §786-787 table, adopt-or-exit, SUSPECT never auto-relaunch)
3. `task-ba3a45f9` — Daemon work services (needs 1-2; work.* handlers, atomic 4-leg claim;
   OWNERSHIP AMENDMENT human-approved: apps/daemon/package.json +@moe/runner + single lock hunk)
4. `task-49acb856` — Supervisor race and restart hardening gate (needs 1-3; carries the
   parent's full DoD + full regression; lease-core harness pattern with outcome-set equality)

## Facts the child architects should not re-derive

- **Governor's store assumption verified TRUE**: EffectIntent *binds* a predecessor cursor
  value (design 771); nothing follows a subscription feed; restart reconciliation is over
  effect/attempt records, not store rebuild. No dependency on store SPIDR steps 4/5.
- **Package constraints**: @moe/runner depends ONLY on @moe/contracts — scheduler lease
  shapes must be mirrored structurally with pinned version literals (claude-render
  precedent, `mem:task-task-5ff2b39df70c4451ae07a44c92935b42-handoff`). @moe/daemon has
  contracts+scheduler; child 3 adds @moe/runner via the approved ownership amendment.
- **Supervisor fence inherited from the adapter**: no child_process/spawn/kill/Date.now/
  Math.random; process death is a caller-supplied observation EXITED|SIGNALLED|UNOBSERVED;
  cancel-reconcile outcomes exist in claude-cancel-reconcile.ts.
- **Daemon gate quirk**: `vitest run --root . --config package.json src`
  (`mem:gotcha-vitest-app-root-config`); ingress precedent
  `mem:decision-daemon-graph-preview-ingress` (decode → envelope → compose; advisory
  labeling).
- **Design anchors**: §774-775 lifecycle arcs; §779 activation linearization (one-use grant,
  cancel-first vs activate-first); §786-787 reconciliation table; §798 launch lock /
  bootstrap credential / duplicate-delivery adopt-or-exit / SUSPECT; §427 slot ceiling 4;
  §992 work.* command family; §336 attempt lifecycle.
- Closing the shell: labeled REVIEW-transit two-step
  (`mem:moe-backlog-to-done-transition-blocked`, task-d5c4b086 precedent). Do NOT re-plan it.
