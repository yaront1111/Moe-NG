# tests/instruction-contract

The lane that keeps the repository's own instructions honest. Two durable files carry
project policy — root `AGENTS.md` (canonical) and root `CLAUDE.md` (bridge) — and nothing
else in the repo enforces that they stay small, stay tool-neutral, and never absorb
generated prompts or live `.moe/` identifiers. This folder is that enforcement, plus a
second, unrelated fence: that `.mcp.json` launches `moe` and Serena through host-native
resolvers instead of one machine's absolute paths.

## Seams

- `checker.ts` exports `checkInstructionContract(input)`, `loadInstructionFiles(rootDir)`,
  `INSTRUCTION_FILE_LIMITS`, `FORBIDDEN_INSTRUCTION_PATTERNS`, and the types
  `InstructionFile`, `ViolationCode`, `Violation`, `InstructionContractInput`.
  **Its only importer is `checker.test.ts`.** No package, no app, no script reaches in
  here; it is a specification executed by its own test, not a library.
- `mcp-host.test.ts` reaches *out*, across the single relative specifier
  `../../scripts/mcp-host.mjs`, for `findJetbrainsProxy(env)` and `findSerena(home)`. Those
  two functions have real production callers: `scripts/mcp-moe.mjs` and
  `scripts/mcp-serena.mjs`, the exact commands `.mcp.json` names for servers `moe` and
  `serena`. This test file is the only automated coverage those launchers have.
- `checker.ts` imports only `node:fs` and `node:path`. It never enters the workspace
  dependency graph, so it has no `@moe/*` imports and needs none.

## The model

- **Two HTML-comment markers are the whole handshake.** `AGENTS.md` must contain
  `<!-- instruction-contract: canonical -->` and `CLAUDE.md` must contain
  `<!-- instruction-contract: bridge -->` *and* the literal string `AGENTS.md`. Both
  marker strings are written out twice — once in `checker.ts`, once at the top of
  `checker.test.ts` — so changing a marker means editing both.
- **Eight stable codes, in a fixed order.** `AGENTS_MISSING`, `CLAUDE_MISSING`,
  `CANONICAL_MARKER_MISSING`, `BRIDGE_MARKER_MISSING`, `BRIDGE_REFERENCE_MISSING`,
  `FILE_OVERSIZED`, `GENERATED_MARKER_PRESENT`, `LIVE_STATE_MARKER_PRESENT`. AGENTS is
  graded before CLAUDE, and within a file the order is marker → size → forbidden. Every
  assertion uses `toEqual` on the whole array, so *order is part of the contract*.
- **A null file short-circuits.** `checkAgents`/`checkClaude` return immediately after the
  `*_MISSING` violation — an unreadable file is never also reported as oversized.
- **`checkSize` is an OR, spelled as an AND.** `if (lines <= maxLines && bytes <= maxBytes)
  return;` — exceeding *either* bound emits one `FILE_OVERSIZED` whose `detail` prints both
  measured numbers. Lines come from `content.split(/\r?\n/u).length` (CRLF-safe, and a
  trailing newline counts as a line: the 85-line `AGENTS.md` measures 86); bytes come from
  `Buffer.byteLength(content, "utf8")`, which is why the byte-cap test arms use `"😀"`
  repeats rather than ASCII.
- **Caps:** `AGENTS.md` 120 lines / 8192 bytes, `CLAUDE.md` 40 lines / 2048 bytes. The test
  mirrors those four numbers by hand and asserts the frozen object deep-equals them.
- **Four forbidden patterns**, pinned by `expect(FORBIDDEN_INSTRUCTION_PATTERNS)
  .toHaveLength(4)`: `moe-generated`; `(task|epic|chan)-<32 hex>`;
  `(worker|architect|qa|governor)-<8 hex>`; the literal `Approval mode:`. Policy prose that
  merely *mentions* `.moe/` is explicitly allowed and has its own arm.
- **Deterministic and frozen.** `checkInstructionContract` touches no filesystem and no
  clock; each `Violation` is frozen in `addViolation` and the array is frozen before
  return, and a test asserts both plus run-to-run equality. `loadInstructionFiles` is the
  only disk access, and it fails closed — every `readFileSync` throw becomes `null`, i.e. a
  `*_MISSING` violation rather than a crash.
- **The two root arms grade one real file against a synthetic partner.** `REPO_ROOT` is
  `fileURLToPath(new URL("../..", import.meta.url))`; "accepts the real root AGENTS.md"
  passes `claude: VALID_CLAUDE` and vice versa, so a breach in one durable file cannot be
  masked by, or attributed to, the other.
- **`mcp-host.test.ts` proves host-nativeness three ways.** It greps the real `.mcp.json`
  for the absence of `/mnt/` and `/home/sysadmin` and the presence of both script paths;
  it exercises `findJetbrainsProxy` preferring `MOE_JETBRAINS_PROXY` (only when that file
  exists) over a scan of `%APPDATA%/JetBrains/*/plugins/moe-jetbrains/proxy/index.js`; and
  it pins `findSerena` preferring `~/.local/bin/serena.exe` over the extensionless
  `serena`. Both refusals are **thrown** `Error`s matched by regex —
  `MOE_MCP_PROXY_NOT_FOUND` and `SERENA_NOT_FOUND` — not codes on a returned result.

## Gotchas

- **This lane is red on the enriched root `CLAUDE.md`, by design.** The committed HEAD
  bridge is 20 lines / 763 bytes; the working-tree version that carries the command table
  and architecture notes is 119 lines / 6570 bytes, so `root instruction contract >
  accepts the real root CLAUDE.md` fails with `FILE_OVERSIZED`. That single failure sinks
  the whole root `pnpm test` gate. Growing the bridge requires moving `maxLines`/`maxBytes`
  in `checker.ts` **and** the hand-mirrored numbers in `checker.test.ts` — not widening a
  matcher. `AGENTS.md` has real headroom by comparison (85 lines / 3801 bytes of 120 /
  8192).
- **Nothing typechecks this folder.** There is no `tests/instruction-contract/tsconfig.json`
  and no root `tsconfig.json`; `pnpm typecheck` is `pnpm --recursive typecheck`, which only
  visits workspace members, and `tests/` has no `package.json`. `scripts/mcp-host.mjs` is
  equally unchecked — `typecheck:release` lists only `scripts/release/*`. Adding a
  tsconfig here needs `composite: false`; see the Serena memory
  `gotcha-package-filter-cannot-reach-tests-dir` for the working recipe and why.
- **`pnpm --filter <pkg> test` can never reach this folder.** Package test scripts are
  positional path filters, so a filtered run exits 0 having executed nothing here. The
  original instruction-contract task gated on an unfiltered
  `pnpm exec vitest run tests/instruction-contract` precisely for this reason.
- **No `.js` bridge is needed.** `checker.test.ts` imports `./checker.js` and no
  `checker.js` exists on disk — that is the NodeNext spelling vitest rewrites. The repo's
  bridge rule covers modules the daemon's runtime graph loads; nothing loads this folder.
- **The file you are reading is not under the contract.** `loadInstructionFiles` joins
  `rootDir` only, so the 17 nested `CLAUDE.md` folder docs (and this one) are invisible to
  the checker and uncapped.
- **Documenting a real identifier reds the lane.** Pasting an actual
  `task-<32 hex>` into root `AGENTS.md` or `CLAUDE.md` as an example is exactly the
  `LIVE_STATE_MARKER_PRESENT` case; use a placeholder shape instead.
- `mcp-host.test.ts` builds every fixture with `mkdtempSync(join(tmpdir(), …))` and
  `rmSync`s it; `findSerena` defaults to `homedir()`, so always pass an explicit home or
  the test reads the developer's real machine.

## Testing

- One file, from the repo root: `pnpm vitest run tests/instruction-contract/checker.test.ts`.
- Whole folder: `pnpm exec vitest run tests/instruction-contract` (30 tests total: 24 in
  `checker.test.ts` after `it.each` expansion, 6 in `mcp-host.test.ts`). No lane config or
  setup file is involved;
  this folder rides the root `vitest.config.ts` (`environment: "node"`, `forks` pool, an
  include list carrying `tests/**/*.test.ts`).
- Both files run inside the root `pnpm test` gate, and only there: this folder is not in
  `test:security`, `test:fault` or `test:migration`, each of which has its own vitest
  config and tsconfig.
- CI runs `pnpm test` twice in `.github/workflows/cross-host.yml` — the ubuntu `gate` job
  and the `windows-latest` mirror — and additionally greps the summary for non-zero passed
  counts, so a failure here blocks both host arms.
- No outside suite imports `checker.ts`; the only cross-folder dependency runs the other
  way, into `scripts/mcp-host.mjs` and the root `.mcp.json`.
