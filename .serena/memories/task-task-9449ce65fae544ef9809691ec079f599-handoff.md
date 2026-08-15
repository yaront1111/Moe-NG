# task-9449ce65 — Release supply-chain gate — ALL 7 STEPS COMPLETE, gate green

Supersedes the earlier "BLOCKED at step 4" handoff. worker-97d6df26,
2026-08-09.

## Outcome

`pnpm verify:release` EXIT=0 at frozen SHA
`6daa942d2e547231d69b5eac0d00fa8bfb8b789c`. Evidence at
`dist/release/6daa942.../eb6b8258.../evidence.json` (git-ignored).

## Four commits, all ancestors of HEAD

| sha | what |
|---|---|
| `06abc8c` | step-4 fix: drop `buildIndex` from the buildSubject call |
| `1153ed3` | step-6 pass 1: four gap tests |
| `8946b02` | step-7: SBOM read-from-file + two normalizations |
| `d227f7b` | step-7: CycloneDX collection boundary guard |

`package.json`, `pnpm-lock.yaml` and `release-subject.mjs` were already
frozen by foreign sweep `71af97c` and are byte-identical throughout — my
commits touch only `scripts/release/supply-chain.mjs` and
`tests/integration/release-supply-chain.test.mjs`. QA should diff by base
ref over the owned paths, not by a single commit.

## Defects found, all by RUNNING the thing

The plan's step order put the only real end-to-end run last, so four
production defects sat behind a green suite until then. Details in
`mem:gotcha-real-process-ports-are-invisible-to-injected-port-suites`,
`mem:gotcha-cdxgen-dash-o-dash-is-not-stdout`,
`mem:gotcha-cyclonedx-bom-has-two-volatile-fields-and-a-host-path`.

1. `buildIndex` passed into an exact-key-set validator → real composition
   refused `RELEASE_INPUT_INVALID` always.
2. `cdxgen -o -` never wrote stdout → `SBOM_REPORT_INVALID` always.
3. BOM embeds the scanned root → `REPRODUCIBILITY_MISMATCH` always.
4. `/annotations/timestamp` is a second generation time →
   `REPRODUCIBILITY_MISMATCH` again.

## Drill matrix

12 mechanisms, all KILLED, all RESTORE_EXACT, each 1+/1-. Harness lived in
OS temp, mutated by a byte-exact Node mutator that ABORTS on a missing or
ambiguous anchor, verified `node --check` so a syntax error cannot fake a
kill, and restored via `git checkout HEAD --` + hash compare (safe only
because the files were committed first — see
`mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`
for the untracked case, which bit me on the FIRST harness attempt when `$0`
resolved to `/usr/bin` and two mutations were left on disk).

## Open items for the next agent

- `supply-chain.mjs` is **253 lines**, 3 over the <=250 target (400 is the
  split threshold). Deliberate: the alternative was splitting a cohesive
  6-line SBOM collector out of the orchestrator. Flagged to QA.
- `pnpm-lock.yaml` is foreign-dirty with an unrelated `@moe/mcp` workspace
  link. Neither committed nor reverted. Do not sweep it.
- Claim boundary: Windows-only, one source commit, `releaseVerdict UNKNOWN`,
  `publicationAuthorized false`. Linux `task-e87a7353` and macOS
  `task-e94b2055` remain the deferred OS rows; doctor stays UNKNOWN until
  `@moe/daemon.collectDoctorVersionReport` is exported on the package root.
