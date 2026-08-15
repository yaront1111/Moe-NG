# task-9fd52b41 (Thin JetBrains adapter) — DONE, in REVIEW

worker-a2c7f85f, 2026-08-10. Commit `e93b479`, 9 files, 1189 insertions, 0 deletions.
Gate: `pnpm --filter @moe/jetbrains-adapter typecheck && ... test && pnpm test:integration` EXIT 0
(2 files / 43 tests; integration 41 pass). Package `@moe/jetbrains-adapter` at `adapters/jetbrains/`.

## RUN THE INTEGRATION GATE FROM POWERSHELL, NOT GIT BASH
`pnpm test:integration` FAILS from Git Bash with
`{"code":"RELEASE_SUPPLY_CHAIN_REFUSED","reason":"SOURCE_ARCHIVE_FAILED"}`. The real error is
`tar: Cannot connect to C: resolve failed` — MSYS **GNU tar reads `C:\...` as a remote host:path**.
`scripts/release/supply-chain.mjs` extracts into `mkdtempSync(tmpdir())`, always a drive-letter path.
From PowerShell `tar` resolves to `C:\Windows\system32\tar.exe` (bsdtar) and it passes. Not a repo
defect and not diff-attributable — the script's only repo inputs are `git archive HEAD` /
`git rev-parse HEAD`. See `mem:gotcha-bash-tool-heredoc-on-windows` for the sibling shell trap.

## A DEFECT I LANDED AND COULD NOT FIX FROM OWNED PATHS
`npx vitest list --root .` now fails repo-wide:
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on
`adapters/jetbrains/node_modules/@moe/contracts/src/phase0-evidence-contract.ts`.
Proved mine by park/restore. Cause: root include glob `adapters/**/*.test.ts` reaches through this
package's node_modules symlink; **this is the first `adapters/*` package with any dependency**, so
it is a latent root-config gap rather than a package defect. `vitest run` is UNAFFECTED (its exclude
does cover `**/node_modules/**`) — measured 227→229 files, no duplicate collection.
**The obvious fix does NOT work**: adding `exclude: ["**/node_modules/**","**/dist/**"]` to
vitest.config.ts changes it to `ERR_MODULE_NOT_FOUND`. Needs a task owning vitest.config.ts.
Prior workers use `vitest list --filesOnly` as a measurement tool, so this will bite them.

## The design decision a reviewer will challenge
`verifyDistributionSet` (packages/contracts/src/distribution/distribution-verifier.ts) is the real
admission authority and is **NOT REACHABLE** from a workspace package — the root barrel publishes
only distribution-contract.ts's 7 values + 11 types. Measured: runtime probe from adapters/jetbrains
returns `{"reachable":[],"unreachable":["verifyDistributionSet","decodeDistributionContainerBytes",
"canonicalUnsignedManifestBytes","isCanonicalText"]}`. tools/packaging reaches it only by a
ROOT-RELATIVE path that bypasses the exports map.

So the gate was scoped to what the verifier structurally CANNOT answer, giving zero forked authority:
- `MANIFEST_VERSION_UNSUPPORTED` — verifier never checks manifestVersion (the parser does).
- `COMPONENT_SET_INCOMPLETE`/`COMPONENT_DUPLICATE` keyed by **componentKind**; the verifier keys on
  componentId against a host expectation map.
- `API_RANGE_MISMATCH` against the range **this adapter build** was compiled against — a different
  party's expectation than the host's, because an IDE plugin updates independently of the daemon.
Signature/digest/provenance are deliberately ABSENT. Every refusal calls the real
`distributionRefusal(...)`, always `refusedBy: "DISTRIBUTION_STARTUP"` (PACKAGER would be a lie).

## Three defects adversarial review found in my own code (all fixed + drilled)
1. **Concurrent double start** — two overlapping `openControlRoom()` both saw DAEMON_ABSENT and both
   started a daemon. Fixed with single-flight. Drill: "expected 2 to be 1".
2. **Teardown resurrection** — every state write is after an `await`, so an uninstall landing
   mid-flight was undone by `endpoint = ...`. Fixed with an era counter checked after each await.
3. **Vacuous range comparison** — the gate only checked `apiCompatibilityRange` was an object; two
   empty ranges compare EQUAL, admitting ANY distribution while the comparison still "passed". Now
   every field must be non-blank and an unusable expectation refuses `EXPECTATION_INVALID` first.
   See `mem:gotcha-vacuous-set-membership-clears-everyone`.

## Shape
- `src/jetbrains-distribution-gate.ts` (113) — `admitDistribution`,
  `JETBRAINS_REQUIRED_COMPONENT_KINDS` (CONTROL_ROOM, DAEMON), the expectation type.
- `src/index.ts` (176) — ports (`JetBrainsPorts extends IdeAdapterPorts` + a 4th
  `DistributionDiscoveryPort`), `createJetBrainsSession`, re-exports the gate so the root is the
  whole public surface. Split at 269 lines per the epic's 250 target; both bridges are LF.
- `JetBrainsResult = DistributionRefusal | IdeAdapterResult` — two vocabularies, neither re-coded
  into the other. Callers discriminate on `"ok" in result`.
- A throwing **distribution** port refuses `COMPONENT_SET_INCOMPLETE`: zero components obtained, so
  the required set is literally incomplete. The vocabulary has no discovery-port-failed reason and
  inventing one is barred.
- Endpoint is read from `IdeAdapterSuccess.detail` — the contract exposes no endpoint field. Coupling
  is documented and pinned by test.

## Foreign red to expect (identical with my package parked — settled by measurement)
`pnpm test` = 2 failed | 227 passed (229). j1 `incident:hot-claim-loop-on-gated-work` and j4
`incident:stale-assets-refuse-handshake`. j4 is task-2411ed9c's, still BLOCKED on a governance
authorisation. I re-settled authorship myself despite already knowing the story, because j4's
missingSurface names "IDE assets" — see `mem:gotcha-fault-schedule-ratchet-flips-when-a-probed-export-lands`.

Related: `mem:task-task-c2d92880989b4ed2bc76494ee6979d91-handoff` (the contract this consumes),
`mem:gotcha-package-root-ts-entry-needs-no-js-bridge`,
`mem:gotcha-undeclared-workspace-dep-has-no-escape-hatch`,
`mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`.
