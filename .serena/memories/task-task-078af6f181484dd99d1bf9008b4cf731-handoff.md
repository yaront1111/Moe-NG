# Handoff: Claude runtime closure pin and re-observation (task-078af6f1)

Internal `@moe/runner` seam `prepareClaudeRuntimePin`. Consumer is the Windows Claude
launch wrapper, `task-acf73253a204435aba590894799814f2`. Deliberately NOT exported
from `packages/runner/src/index.ts` — the consumer imports the internal module.

## Where it lives (4 production modules, not 1)

The task description named ONE production file. It could not fit: the module was
458 physical lines with only the contract + path/source layer in it, and the epic
caps production files at 400 (target 250). Split along real seams, all in
`packages/runner/src/providers/claude/`, all previously unowned:

| file | lines | role |
|---|---|---|
| `claude-runtime-pin-fs.ts` | 122 | `ClaudeRuntimeFsPort` + `createNodeClaudeRuntimeFs` + `streamDigest` |
| `claude-runtime-pin-closure.ts` | 281 | refusal vocabulary, path/quote/source admissibility |
| `claude-runtime-pin-copy.ts` | 178 | stage / copy / verify / publish protocol |
| `claude-runtime-pin.ts` | 301 | facade, re-observation, immutable binding |

Each has an exact `.js` bridge (required by `runtime-entrypoint.test.ts`, which
DERIVES the requirement — no allowlist to edit).

## Design decisions a reviewer will ask about

- **`authorityDigest()`** = `observationDigestInput(obs)` minus `freshness`, hashed.
  One comparison covers closure paths+digests, version, capability schema, pinning
  method, platform and truthClass. That is how "ignores freshness ONLY" is enforced
  without enumerating fields at the call site.
- **Source paths in the source observation are the `realpath` result**, not the
  declared string. A quote whose casing differs from disk is an observation that
  CHANGED, and is refused. Build quotes from `realpathSync`-resolved paths.
- **The facts port is observed TWICE** — before the copy (compared to the quote via
  `authorityDigest`) and after (compared to the first via `factsDigest`, which omits
  the closure because pinned paths legitimately differ from source paths).
- **Re-observation runs BEFORE the publish rename.** So a runtime that changed
  mid-copy leaves the pin root empty rather than half-published. Tests rely on this.
- **An existing final root is never replaced** — verified per declared member AND
  swept for undeclared members, adopted only on exact match, else
  `CLAUDE_RUNTIME_PIN_COLLISION` with the existing bytes preserved.

## Verification

`pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test`
-> 40 files, 1260 tests, exit 0. Focused file: 45 tests.

## Commit state (epic-rail hazard, already disclosed)

Foreign whole-tree commit `7d9efc9` (task-5529a248) captured all five `.ts` files
mid-task. Committed bytes verified byte-identical to the gated bytes; not amended.
The four `.js` bridges are commit `2aa50d0` under this task id.
Review by base-ref diff:
`git diff 7d9efc9^..HEAD -- packages/runner/src/providers/claude/claude-runtime-pin*`

Related: `mem:gotcha-windows-path-identity-in-the-runner-pin`,
`mem:convention-commit-by-pathspec-in-a-shared-index`,
`mem:decision-runner-cannot-import-store-or-daemon`.
