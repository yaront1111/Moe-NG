# Worker handoff — task-b7853ff1ba344f92aded1fb3d09d3ffb (delivered)

## What landed
`scripts/release/supply-chain.mjs` now imports the zero-argument
`collectDoctorVersionReport` from the **bare** `@moe/daemon` root, installs it unchanged in the
frozen `SYSTEM_PORTS`, and calls it exactly once after the tool identity gate but before key
generation, build roots, signal handlers and publication. `observeDoctor` `structuredClone`s the
report, admits only a canonicalisable v1 JSON-tree envelope (exact top-level / observed / declared
key sets, four pins, dense components, safe non-negative count equal to `components.length`), then
deep-freezes it. Nested known values, UNKNOWN codes and refusing layers are carried verbatim.
Throw, rejection, structured refusal, version drift or bad cardinality all map to
`RELEASE_SUPPLY_CHAIN_REFUSED` / `TOOLCHAIN_OBSERVATION_FAILED` / `RELEASE_SUPPLY_CHAIN` before any
durable effect. `componentCount` still derives from the six-entry `RELEASE_COMPONENTS`;
`releaseVerdict` UNKNOWN and `publicationAuthorized` false are untouched. Production is 314 lines.

## Where the bytes are
A **foreign whole-tree completion commit** `c970f106736acd4755777f8e2699062fb6e02ce1`
(task-ff589abd) captured the working tree before my pathspec commit could run, so `git commit --
<owned paths>` said "nothing to commit". Not amended or reset (global rail). Committed bytes are
byte-identical to the gated bytes: supply-chain sha256 `48724142…`, test file `cc5185c3…`.
Review with
`git diff 4d0a49fb8791b458565863377d7002a48a1a9bd8..HEAD -- scripts/release/supply-chain.mjs tests/integration/release-supply-chain.test.mjs`
(+221/-11, exactly two files, no foreign hunk).

## Gate evidence
`pnpm typecheck:release && pnpm test:integration` exit 0 on Windows. Vitest `Test Files 4 passed
(4)`, `Tests 209 passed (209)`; Node `tests 66 / pass 66 / fail 0`. The real win32 leg published
evidence with `doctor.reportVersion moe-doctor-version-report/1`, `componentCount 18` = components
length, observed `{arch x64, node v24.16.0, platform win32, pnpm 11.0.8}`, four SATISFIED pins, no
`missingSymbol`, alongside release `componentCount 6` / `templateCount 3` / verdict UNKNOWN /
authorized false.

## Mutation drills (all restored byte-exact, SHA-256 compared)
- **A** former `missingSymbol`/`DOCTOR_COMPATIBILITY_UNAVAILABLE` placeholder → 7 executed, 7 red.
- **B** bypass the fail-closed guard → 4 red (`result.ok` true), success tests stayed green.
- **D** remap refusal to `EVIDENCE_WRITE_INTERRUPTED` → 4 red on the exact reason literal.
- **C** drop `structuredClone` → only the aliasing test red (`Object.isFrozen(retained)` true).
- **E** `command("pnpm", args)` → the Corepack guard test red.

See [[gotcha-whole-file-string-guard-collides-with-a-data-literal]] and
[[gotcha-release-gate-runs-only-on-windows-in-this-checkout]].
