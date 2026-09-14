# Replanned repository recovery implementation plan

**Goal:** Release an executed repository reservation retired by an exact human REPLAN while preserving the reviewed work and all acceptance boundaries.

**Architecture:** Add `RELEASE_REPLANNED` to the existing repository recovery composition. The owner joins the durable human replan, failed host-prepared review, immutable compiled source, baseline and SeatStart; captures a clean committed descendant containing the exact reviewed tree; obtains positive native Job drain; repeats the joins under the project writer fence and performs audited repository CAS. No acceptance, landing receipt or continuation grant is created.

**Tech stack:** TypeScript, SQLite decision store, existing native Windows Job drain, read-only Git commands, Vitest.

## Owned changes

- New `apps/daemon/src/repository/repository-replan-recovery-{evidence,git,service,mutation}.ts` and physical `.js` bridges.
- New focused `repository-replan-recovery.test.ts` and fixture file.
- Extract shared failed-review evidence from `repository-review-resume-evidence.ts`; preserve the existing resume prohibition on replanned nodes.
- Extend repository recovery contracts, payload codec, service and replay reader with the single new action.
- Wire `recover-replan` through existing CLI argument, command and maintenance composition; add focused CLI regression coverage.
- Add automatic recovery before project start only when the old reservation has an exact admissible REPLAN. A live authority, dirty tree or unproven containment remains a refusal; no implicit checkpoint or process-identity guess.

## TDD sequence

1. Build on the existing approved compiled review/reservation fixture. Record three actual failed reviews, a paired-human HTTP REPLAN, closed worker authority, and a human Git commit containing the reviewed tree.
2. Assert `service.recover({...payload, action: "RELEASE_REPLANNED"})` returns `REPOSITORY_RECOVERY_RELEASED`; old reservation absent, reviewed files/index/HEAD unchanged, review still replanned/unaccepted, and a different node can acquire the repository. Run the new test and retain its initial input-invalid RED.
3. Implement the evidence, clean Git observation, positive drain, final writer lock and atomic CAS/receipt. Each release proof binds replan decision ID/digest, failed-review digest, snapshot digest and exact native drain.
4. Add negative cases: absent/foreign/malformed replan, wrong review version/digest, accepted/unresolved landing effects, missing/foreign SeatStart, live/missing worker authority, dirty or different tree, non-descendant commit, changed review/HEAD/index/controller during drain, invalid/nonempty native Job, and tampered replay proof. All must preserve reservation and downstream authority.
5. Assert byte-identical retry replays after another node acquired the repository, without a second drain; changed request bytes refuse.
6. Add CLI RED for `recover-replan`, preserved configuration and restart only after proved release. The normal start path may reuse the already-recorded human REPLAN and must never fabricate another approval or force unlock.

## Commands and expected evidence

```powershell
pnpm --filter @moe/daemon exec vitest run --root . --config package.json --maxWorkers 1 --testTimeout 30000 src/repository/repository-replan-recovery.test.ts src/repository/repository-review-resume.test.ts
pnpm --filter @moe/daemon exec vitest run --root . --config package.json --maxWorkers 1 --testTimeout 30000 src/cli/moe-cli-replan-recovery.test.ts src/cli/moe-cli-review-recovery.test.ts src/cli/moe-cli-argv.test.ts src/cli/moe-cli-main.test.ts
pnpm --filter @moe/daemon typecheck
```

Root owns full repository gates, native artifact validation, commits, installation and all live recovery. Implementation and tests only mutate private fixtures. Existing UnAI history and application files stay untouched.
