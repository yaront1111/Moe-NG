# QA verdict: APPROVED — project configuration manifest contract (task-0c21ba2f07cc4f4a829e475bbd7f0562)

Worker handoff content preserved below the QA section; both are useful to the consumer chain.

## QA evidence (qa-50f0d628, 2026-08-14)

Gate re-run by QA, each leg STANDALONE so `&&` could not mask a later leg:
- `pnpm --filter @moe/contracts test` -> exit 0. 12 files / 416 tests.
- `pnpm --filter @moe/core test` -> exit 0. 28 files / 579 tests.
- `pnpm --filter @moe/daemon test` -> exit 0. 69 files / 1492 tests.
- `pnpm typecheck` -> EXIT 1, FOREIGN. `packages/contracts typecheck: Done`. Only red:
  `packages/runner typecheck: src/providers/claude/claude-launcher.ts(13,1): error TS6192:
  All imports in import declaration are unused.` and `(15,10): error TS6133:
  'verifyLaunchSelection' is declared but its value is never read.`
  Attribution proof: those runner files are UNCOMMITTED peer edits in `git status`, the
  symbol comes from the peer's UNTRACKED `claude-launch-verify.ts`, and
  `grep -rn "ProjectConfiguration|project-configuration" packages/runner/` -> ZERO hits.
  Failing-path set intersected with owned paths is EMPTY -> global rail 3 satisfied.

**QA-run mutation drills** (sha256 before, Edit-tool mutate, run, Edit-tool revert,
`sha256sum -c` proves byte-identical restore — never `git checkout`):
- D1 drop `\` and `:` from `isLogicalRef` -> exactly 3 red: windows drive backslash,
  windows drive relative, unc share. `C:/x` and `file:///x` stayed refused via the
  surviving `/` rule, and ALL 8 LEGITIMATE_REFS stayed green. The table tests the rule.
- D2 move the `schemaVersion` check ahead of `hasExactKeys` -> exactly 1 red:
  "checks the structure BEFORE the version". Refusal ORDER is genuinely pinned.
- D3 return the caller's limits array instead of the copy -> 2 red, both NAMED
  immutability assertions ("deep-freezes the snapshot at every depth", "shares no object
  identity with the input at any depth"), not a JSON comparison.

Other QA checks: all 8 owned paths `git rev-parse HEAD:<p>` == `git hash-object <p>`
(committed bytes == gated bytes); working tree clean; the carrying commit is the FOREIGN
whole-tree `c576110` (global rail 5 — never a rejection reason); zero `node:` in the two
new production sources AND in every transitive import (`distribution-contract.ts`,
`phase0-evidence-contract.ts` clean; `runtime-guards.ts` only the sanctioned
`getBuiltinModule` runtime lookup); no path key in the closed contract (only a comment
mentions the word); production files 229 and 227 physical lines, both under the 250 target;
consumer tasks task-5dfc98fc3e7f4035a8012bd9ba032de3 and the core codec prerequisite
task-bcea70569f714367b2e50c1734433631 both exist on the board.

QA note on DoD 2 wording: it asks for "exact Reflect.ownKeys snapshots". `isPlainRecord`
uses `getOwnPropertyNames` + `getOwnPropertySymbols` (symbols refused outright), which is
`Reflect.ownKeys` decomposed and strictly stronger. Not a gap; do not re-litigate.

---

# Worker handoff (preserved)

Landed the browser-safe, path-neutral V1 configuration contract in `@moe/contracts`.
Seam decision it implements: `mem:decision-project-configuration-manifest-seams`.

## What exists now (all root-exported from `@moe/contracts`)

`packages/contracts/src/configuration/`
- `project-configuration-contract.ts` (229 lines) + `.js` bridge — vocabularies, types,
  two frozen module-constant refusals, `isLogicalRef`, `isBoundedText`.
- `project-configuration-parser.ts` (227 lines) + `.js` bridge —
  `parseProjectConfigurationSettings`, `parseProjectConfigurationManifest`.
- `project-configuration.test.ts` 238, `project-configuration-hostile.test.ts` 283,
  `project-configuration.test-fixtures.ts` 121.

`PROJECT_CONFIGURATION_LIMIT_KEYS` has **30** keys in design order (2.1 gives 11, 11.2 gives 2,
19.1 gives 17). **Only the key vocabulary and its ORDER are frozen.** The design's numbers are
deliberately absent: task rail 2 forbids inventing defaults, so every value is required caller
input. QA confirmed no numeric default is present anywhere in the contract.

Five closed enums, each with >=2 representable members so a pinned value is a real decision:
gate modes (`MANUAL_HUMAN_APPROVAL` | `POLICY_AUTO_APPROVAL_OPT_IN`), egress (3), daemon
exposure (2), workspace isolation (2), host containment (`NOT_CLAIMED` | `SANDBOX_ENFORCED` —
design 19.3 says v1 does NOT claim containment, and the vocabulary must be able to say so).

## Contract facts a consumer must not get wrong

- **Refusal order is pinned and drilled**: structure (`isPlainRecord` + `hasExactKeys`) ->
  `INPUT_INVALID`; then `schemaVersion` equality -> `VERSION_UNSUPPORTED`; then fields ->
  `INPUT_INVALID`. Only one layer, `PROJECT_CONFIGURATION_MANIFEST`.
- **`settingsDigest` is on the Manifest ONLY**, never on Settings, and is never synthesized.
  Hashing belongs to the core codec task.
- **The limit table is positional**, not keyed: length must equal the vocabulary and entry `i`
  must already carry key `i`. Nothing sorts, back-fills, or rescues a reordered table.
- **Zero normalization**: every accepted string is `===` the input string.
- `isLogicalRef` is ONE rule (bounded 128, non-empty, well-formed, NFC-stable, control-free, no
  leading `.`, no `/` `\` `:`), not a blocklist. Schema-version strings use `isBoundedText`
  (256) instead, because they legitimately contain `/`.
- The gate/digest cross-rule binds both directions: an opt-in gate needs a hex64 digest, and
  fully manual gates must carry `null`.

## Traps the worker hit

- A foreign whole-tree completion commit (`c576110`, task-f6cf8d16) swept all 8 owned paths
  mid-task. See `mem:gotcha-foreign-whole-tree-commit-preempts-your-pathspec-commit`.
- `Object.hasOwn` density guard survived every ordinary sparse test — see
  `mem:gotcha-density-guard-unreachable-through-a-plain-hole`.
- `grep -c $'\x00' file` is useless in bash: the NUL collapses to an empty pattern and matches
  every line. Use a node byte scan.

## Deviations from the approved plan (both disclosed, both accepted by QA)

1. Plan named 1 test file; landed 3 (test + hostile + fixtures) because one honest file is
   ~470 lines. `.test-fixtures.ts` with a `./x.test-fixtures.js` specifier and NO `.js` bridge
   copies the existing `document-work-proposal.test-fixtures.ts` precedent in this package.
2. Plan named 6 owned paths; 8 were touched. Still under the 10-file threshold, and per global
   rail 2 task-level LOC is never a rejection reason.
