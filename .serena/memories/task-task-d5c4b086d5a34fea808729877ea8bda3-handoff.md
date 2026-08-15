# Conserved budget core planning handoff

- Parent task `task-d5c4b086d5a34fea808729877ea8bda3` was oversized: design 11.1-11.4 spans contracts, hierarchical double-entry ledger, protected reservation admission, measurement truth, settlement/reconciliation, and seeded concurrency/restart proof. Credible estimate was ~1.8-2.0k LOC; submitting one plan would violate the <=400 net-LOC, 1-3-file, and <=250-per-production/test-file rails.
- Pinned design hash was independently verified: `1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191`.
- Created bounded BACKLOG child tasks:
  1. `task-7dc2e4870d7d4096a1be7b5991e50e94` Budget contract vocabulary.
  2. `task-a5def097bcb7495e935204bd845160b4` Hierarchical budget ledger; depends on 1.
  3. `task-318c0732094c417f96932b5c83e7388b` Protected budget reservations; depends on 1-2.
  4. `task-5ee5b801127a4536a6e770abc6e83e9e` Usage measurement truth; depends on 1 and can land alongside 2/3 after the contract.
  5. `task-3602672fd0c74de6b6fc72f90e1745c8` Budget settlement reconciliation; depends on 2-4.
- Each child owns exactly one production TS, one one-line JS bridge, and one <=250-line test; each has a focused scheduler typecheck+single-test gate.
- The parent is BLOCKED, with Moe comment `comment-42ccbfa6a489420fb79aeae90e2143f8`. Once all five children are DONE, unblock it as the explicit final hardening slice. Its future plan should add only two <=250-line held-out tests: deterministic seeded conservation/restart schedules and enumerated concurrent-admission races, then run `pnpm --filter @moe/scheduler typecheck && pnpm --filter @moe/scheduler test`.
- Ownership constraint: scheduler has no dependencies and exports only its root; current budget/** ownership cannot import `@moe/core`, change package.json/lock/index, or publish budget APIs. Follow the existing internal scheduler convention: local closed string-identical vocabularies, local frozen issues, relative budget imports, and no package-root export. Emit only a structurally `PolicyFactInput`-compatible fact; direct policy composition is a later ownership-amended task.
- Scope exclusions remain provider/billing adapters, guessed cost, UI, fairness, fan-out materialization/integration, supersession funding, persistence, and runtime-error mapping.