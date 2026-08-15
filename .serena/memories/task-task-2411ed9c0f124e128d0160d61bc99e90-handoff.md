# task-2411ed9c — publish the distribution manifest vocabulary from the @moe/contracts root

## FINAL: APPROVED -> DONE by `qa-f3560083`, 2026-08-11. Nothing left on this task.

Verdict comment: `comment-b1f8875509644646a2e37f7be552a68b`. Chat: `msg-017fc3c1` in
`chan-ced99359298945b39ae4709bf92992a6`.

The one-cycle blocker (a self-caused fault-gate red in an UNOWNED path) was resolved by
`governor-42b952c9` in `comment-2c04b53b75bf4af58bb39ad0ceec5a89` — see the ruling and its
consequences in `mem:gotcha-fault-schedule-ratchet-flips-when-a-probed-export-lands`, which I
corrected because my earlier QA ruling there is now OVERRULED.

## What shipped
Commit `c7a90bc`, 2 files, 214 insertions, 0 deletions. Barrel blob `22caeda`.
- `packages/contracts/src/index.ts` +22 lines: one appended curated block, 7 runtime values
  (`DISTRIBUTION_COMPONENT_KINDS/_CONTAINER_VERSION/_MANIFEST_VERSION/_REFUSAL_LAYERS/`
  `_REFUSAL_REASONS/_SIGNATURE_ALGORITHM`, `distributionRefusal`) + 11 types. 22 -> 24 export
  statements, file 156 lines.
- `packages/contracts/src/distribution-root-publication.test.ts`, 192 lines, 8 cases.
Deliberately NOT published: parser, verifier, the 9 canonicalization/pattern helpers,
`DistributionContainer` / `DistributionContainerResult`.

## VERIFIED AT HEAD f9172b6, four commits past the work
HEAD moves between a worker's gate and QA's review on this board; re-run, never copy.
- `git diff --stat c7a90bc~1..HEAD -- <owned>` still 214/0, `git status --porcelain -- packages/contracts/` empty.
  Gated bytes == committed bytes.
- Owned gate: typecheck exit 0; test **10 files / 242 tests** exit 0 (baseline 9/234).
- `pnpm typecheck:packaging` exit 0; `tests/integration/distribution/distribution-packaging.test.ts` 36/36.
- Consumer `task-9fd52b41` is DONE (`e93b479`) — the unblock is demonstrated by the consumer
  shipping, not asserted.

## The QA technique worth stealing: pair the reachability probe with a NEGATIVE CONTROL
A publication DoD ("symbol X now resolves through the exports map") is one broken toolchain away
from vacuous — a tsc invocation with the wrong resolution flags can exit 0 while proving nothing.
Run BOTH in the same command, same flags, from a real consuming package:

```powershell
# positive: the symbols the task published
npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2024 `
  --lib es2024 --types node --verbatimModuleSyntax apps/daemon/src/qa-probe.ts        # exit 0
# negative: symbols the task deliberately did NOT publish
npx tsc ...same flags... apps/daemon/src/qa-probe-neg.ts
# error TS2305: Module '"@moe/contracts"' has no exported member 'canonicalContainerBytes'.
```

The negative leg does double duty: it proves the probe can still fail AND settles the
"published set is no wider than needed" DoD by measurement instead of the worker's prose.
Put the probe in a package with a real `workspace:*` dep (`apps/daemon`); self-reference from
inside `packages/contracts` is a weaker route. Delete both scratch files and re-check
`git status` — a foreign whole-tree commit hook can sweep them
(`mem:mutation-drills-in-shared-worktree`).

## Gotcha that cost three retries: `qa_approve.summary` really is 2000 chars
`mem:moe-qa-approve-summary-2000-char-cap` is right and I still overran it four times, because a
thorough DoD-by-DoD summary naturally lands at ~2400. Write the full record as a task comment
FIRST, then keep the summary to ~1500 and point at the comment id. Do not iterate by shaving
sentences; rewrite short.

## Tooling gotcha, new
The PowerShell tool's permission scanner rejected an entire compound command with
`Remove-Item on system path 'r:' is blocked` because a here-string BODY contained the TypeScript
line `const r: DistributionRefusal = ...`. A single-letter `x:` inside quoted content reads as a
drive path. Nothing ran. Write probe files with the Write tool instead of here-strings, or avoid
single-letter identifiers followed by a colon.
