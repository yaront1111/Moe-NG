# task-5dfc98fc QA handoff — APPROVE (2026-08-15)

QA independently reviewed the base-ref diff `git diff f0f62c0..HEAD -- <five owned paths>` and current committed bytes. The owned paths are clean at HEAD `cf272f67`; foreign shared-tree WIP remains untouched.

## Verification
Fresh foreground exact gate:
`pnpm --filter @moe/contracts test && pnpm --filter @moe/core test && pnpm --filter @moe/daemon test && pnpm typecheck`
EXIT 0: contracts 12 files / 416 tests, core 31 / 781, daemon 89 / 1823, and all 18 selected workspace typechecks Done.

QA mutation drill changed the production currentness comparison to `if (false)` using a byte-exact save/restore. The named stale-replay test exited 1 at the full expected `PROJECT_CONFIGURATION_STALE` / `PROJECT_CONFIGURATION_SELECTION` UNKNOWN assertion (received authoritative SELECTED instead), then the restored test exited 0. Final production SHA-256 is `656F10771BFEA39594FC9D416B2EA1EAB9D2AA23E3D1E22B6F7DAA5E957C675B`; owned paths have no HEAD diff.

## DoD/rails checked
- Manifest contract has closed project/settings/policy/approval/selection/limits/network/isolation/schema/orchestration-source fields; source identity is `sourceSha`; identity scans found no physical path key or `profileRevisionId` substitute.
- Core canonical codec and sensitivity sweeps remain present; the upstream approved mutation evidence is in `mem:task-task-bcea70569f714367b2e50c1734433631-handoff`.
- Daemon selection persists identical manifest event/result bytes, uses CAS/replay, bounded stable-tail current read, verifies event/decision/receipt/project/digest integrity, and returns frozen explicit UNKNOWN/NONE refusals with exact code/layer/upstream.
- Tests cover first selection, replay, replay after replacement, stale CAS, reopen byte equality, absence/stale/conflict/unreadable, moving tail, store throw, hostile inputs, unsupported schema, and a forged matrix pinned to exactly 17 nonzero rows. Every refusal uses `expectUnknown`, which asserts code, layer, upstream, no manifest, and frozen result. All four closed daemon codes appear.
- `@moe/daemon` root exports runtime/type closure; Windows-safe `execFile` bare-root consumer selects, closes, reopens, and reads exact current bytes.
- Production physical lines: selection module 249, bridge 1, shared index 374; all remain below the 400 hard cap. Bridge bytes are exact LF one-line export. No smoke/probe residue; diff checks clean.

Verdict: approve.