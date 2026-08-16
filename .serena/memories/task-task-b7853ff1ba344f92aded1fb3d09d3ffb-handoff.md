# task-b7853ff1ba344f92aded1fb3d09d3ffb — DELIVERED + QA APPROVED

## What landed (worker)
`scripts/release/supply-chain.mjs` imports the zero-argument `collectDoctorVersionReport` from the
**bare** `@moe/daemon` root, installs it unchanged in frozen `SYSTEM_PORTS`, and calls it exactly
once after the tool-identity gate and before key generation / build roots / signal handlers /
publication. `observeDoctor` `structuredClone`s, admits only a canonicalisable v1 JSON-tree envelope
(exact top/observed/declared key sets, 4 pins, dense components, safe non-negative count ===
`components.length`), then deep-freezes. Nested known values, UNKNOWN codes and refusing layers are
carried verbatim. Throw / rejection / structured refusal / version drift / bad cardinality all map
to `RELEASE_SUPPLY_CHAIN_REFUSED` + `TOOLCHAIN_OBSERVATION_FAILED` + `RELEASE_SUPPLY_CHAIN` before
any durable effect. `RELEASE_COMPONENT_COUNT = RELEASE_COMPONENTS.length` (6), `releaseVerdict`
UNKNOWN, `publicationAuthorized` false untouched. Production 314 lines.

## Where the bytes are
Two foreign whole-tree completion commits ran over this work. `c970f10` (task-ff589abd) captured the
owned bytes; `1576a44` bears THIS task's id but contains only foreign files (.moe board, Rust broker,
`tests/fault/cross-host/*`, a peer `zzdrill.fault.ts`) — the known hook defect, not a reject reason.
Review by base-ref diff:
`git diff 4d0a49fb8791b458565863377d7002a48a1a9bd8..HEAD -- scripts/release/supply-chain.mjs tests/integration/release-supply-chain.test.mjs`
(+221/-11, exactly two files). HEAD bytes sha256 `48724142…` / `cc5185c3…` = the gated bytes.

## QA verification (qa-c7cedba3, 2026-08-16)
- Edge re-measured at HEAD: root `dependencies["@moe/daemon"]="workspace:*"`, lock importer `.`
  `version: link:apps/daemon`, `node_modules/@moe/daemon -> apps/daemon`, daemon `index.ts:182-183`
  exports the function + type. `grep` for a deep-relative daemon import: NONE. Manifest/lock/daemon
  untouched by this task's range.
- Gate re-run by QA on Windows PowerShell: `pnpm typecheck:release` exit 0; `pnpm test:integration`
  exit 0 with Vitest `Test Files 4 passed (4)` / `Tests 209 passed (209)` and Node
  `tests 66 / pass 66 / fail 0`. Nonzero executed counts on both legs.
- `expectReleaseRefusal` pins all three literals (code, reason, refusedBy); doctor-failure cases also
  assert `calls == [[]]`, and zero archive/buildSubject/publishEvidence calls.
- Cardinality pins present and executed: `doctorFailureCases.length === 3`,
  `refusalSites.length === 10` with `distinct reasons === 9`, `RELEASE_COMPONENTS.length === 6`,
  `evidence.componentCount === 6` vs doctor `componentCount === 2` (no substitution).
- Whole-file `"pnpm"` PATH-resolution guard exemption is narrow: it asserts the
  `DOCTOR_OBSERVED_KEYS` declaration verbatim, strips that single non-global match, then scans the
  rest of the file. Not a weakening.

## QA mutation drills (all restored byte-exact to `48724142…`)
- **Q1** strip `layer` from the snapshot via a JSON replacer → preservation test red on the exact
  missing `layer: 'DOCTOR_VERSION_HOST'` arms.
- **Q2** remap the doctor-site refusal to `EVIDENCE_WRITE_INTERRUPTED` → 4 executed, 4 red on the
  exact reason; success tests stayed green, so the failure tests are bound to the doctor site and
  not answered by an earlier layer.
- **A** restore the former `missingSymbol`/`DOCTOR_COMPATIBILITY_UNAVAILABLE` placeholder → 3 named
  production-surface tests red, including the real bare-root port test.

See [[gotcha-preservation-claim-needs-a-field-strip-drill]],
[[gotcha-whole-file-string-guard-collides-with-a-data-literal]],
[[gotcha-release-gate-runs-only-on-windows-in-this-checkout]].
