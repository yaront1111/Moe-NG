# Control-Room Truth Kernel Implementation Plan

**Goal:** Add a framework-neutral `@moe/control-room-model` package that maps only daemon-supplied truth classes to exact, immutable presentation descriptors and fails closed for every other input.

**Architecture:** One pure package-root function accepts `unknown`, validates by primitive string equality, and returns a discriminated immutable result. Five module-owned descriptor/result singletons encode the UI specification exactly; one module-owned error singleton handles all invalid, missing, object, proxy, and revoked-proxy inputs without inspecting them. The package neither derives truth nor accepts aggregate inputs.

**Tech Stack:** TypeScript 7, Node.js 24.16 strip-types runtime, Vitest 4, pnpm 11 workspace.

---

## Authority and scope

- UI authority: `2026-08-05-moe-v1-control-room-spec.md` SHA-256 `C55AF8A9FC7386E6492FD57E34A4B8321ABAAE4E4E08FF38703544B58B0BEF1F`, especially §§1.1–1.4, 3.1–3.2, 11.1, and 12.
- Technical authority: `2026-08-05-moe-rebuild-design.md` SHA-256 `1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191`, especially §§5 and 18.1–18.4.
- Starting Git base: `e7f2b680fd830c25a4c66cae420bda825fff0792`.
- Delivered commit parent after concurrent main-folder integrations: `63e848269a6b15d4d28c6401df04719ee72bd485`.
- Delivery correction: work directly on the source checkout's `main`; do not create a worktree, branch, merge, or push.
- Owned paths only: this plan, `packages/control-room-model/**`, and the dependency-free `packages/control-room-model` importer in `pnpm-lock.yaml`.

## Public contract

`describeTruthClass(input: unknown): TruthPresentationResult` returns exactly one of:

```ts
type TruthPresentationResult =
  | { readonly ok: true; readonly descriptor: TruthPresentationDescriptor }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "TRUTH_CLASS_INVALID";
        readonly message: "Truth class must be a daemon-supplied supported value.";
      };
    };
```

A successful descriptor has `truthClass`, `glyph`, `shortLabel`, `semanticTone`, `meaning`, `borderStyle`, `provenanceAffordance`, `ariaLabel`, and `chipTestId`. No overload accepts facts, collections, or a default class.

## Exact mapping

| Truth class | Glyph | Label | Semantic tone | Border | Chip test ID |
|---|---|---|---|---|---|
| `OBSERVED` | `●` | `OBS` | `neutral slate` | `solid` | `cr.chip.observed` |
| `AGENT_REPORTED` | `💬` | `AGT` | `amber` | `solid` | `cr.chip.agent_reported` |
| `DAEMON_VERIFIED` | `▣` | `VER` | `green` | `solid` | `cr.chip.daemon_verified` |
| `HUMAN_APPROVED` | `◉` | `HUM` | `blue` | `solid` | `cr.chip.human_approved` |
| `UNKNOWN` | `◇` | `UNK` | `high-contrast magenta` | `dashed` | `cr.chip.unknown` |

Meaning and accessibility strings are copied byte-for-byte from §3.1. Each `ariaLabel` is the class, meaning line, and `press Enter for provenance.` affordance in that order.

## Task 1: Establish the package boundary with RED evidence

**Files:**

- Create: `packages/control-room-model/package.json`
- Create: `packages/control-room-model/tsconfig.json`
- Create: `packages/control-room-model/src/index.ts`
- Create: `packages/control-room-model/src/package-root.test.ts`
- Modify: `pnpm-lock.yaml`

1. Add dependency-free package metadata matching existing workspace packages, with root-only `exports` and local `typecheck`/`test` scripts.
2. Add an initially empty root module:

   ```ts
   export {};
   ```

3. Add a self-reference test that imports `@moe/control-room-model` as a namespace and expects the runtime export list to equal `['describeTruthClass']`.
4. Run `pnpm --filter @moe/control-room-model test -- package-root.test.ts`; record the expected assertion failure showing an empty export list.

## Task 2: Specify exact mappings and hostile behavior with RED tests

**Files:**

- Create: `packages/control-room-model/src/truth-presentation.test.ts`
- Create: `packages/control-room-model/src/hostile-input.test.ts`

1. Add one table-driven case per truth class asserting every descriptor field exactly, including tone, solid/dashed border, provenance text, accessible label, and chip test ID.
2. Assert deterministic JSON bytes and stable results for repeated equivalent inputs.
3. Assert `TRUTH_CLASS_INVALID` for missing values, invalid/case-shifted strings, boxed strings, objects, arrays, symbols, functions, proxies, and revoked proxies.
4. Use counting traps on object and callable proxies and assert that the trap count remains zero.
5. Assert the success envelope, descriptor, failure envelope, and error payload are frozen and reject mutation.
6. Assert `UNKNOWN` alone is dashed and that all classes remain distinguishable without color through glyph, label, and border.
7. Run the focused package tests and record failures caused only by the absent public implementation.

## Task 3: Implement the minimum kernel

**Files:**

- Modify: `packages/control-room-model/src/index.ts` (the complete kernel remains a focused single module; no separate barrel is needed yet)

1. Define narrow readonly unions and discriminated result types.
2. Freeze each descriptor before freezing its success envelope. Freeze the error payload before freezing the shared failure envelope.
3. Select results with a primitive-string `switch`:

   ```ts
   export function describeTruthClass(input: unknown): TruthPresentationResult {
     switch (input) {
       case "OBSERVED": return OBSERVED_RESULT;
       case "AGENT_REPORTED": return AGENT_REPORTED_RESULT;
       case "DAEMON_VERIFIED": return DAEMON_VERIFIED_RESULT;
       case "HUMAN_APPROVED": return HUMAN_APPROVED_RESULT;
       case "UNKNOWN": return UNKNOWN_RESULT;
       default: return INVALID_RESULT;
     }
   }
   ```

4. Export only the function and its public types from the package root.
5. Run the package tests and typecheck to GREEN.

## Task 4: Prove raw Node package-specifier execution

**Files:**

- Create: `packages/control-room-model/src/control-room-model-entrypoint-smoke-worker.mjs`
- Create: `packages/control-room-model/src/control-room-model-runtime-entrypoint.test.ts`

1. In a worker launched with `--experimental-strip-types`, import `describeTruthClass` from `@moe/control-room-model`.
2. Return one valid descriptor summary, one invalid reason code, and the deep-freeze checks.
3. Assert the exact worker payload in Vitest.
4. Also run the worker directly through raw Node 24.16 with a package-specifier `import()` command and require exit code zero.

## Task 5: Verify, review, and commit

**Files:**

- Modify: `docs/plans/2026-08-07-control-room-truth-kernel.md` only to append final execution evidence if it improves reproducibility.

1. Run the required focused and repository-wide typecheck/test commands.
2. Run `git diff --check`, a tracked-and-untracked owned-file NUL/trailing-whitespace scan, and a byte-size audit.
3. Ask two fresh read-only hostile reviewers to inspect the exact owned diff independently. Resolve every `BLOCKER` or `MAJOR` finding with a failing regression test before changing production code.
4. Repeat all verification after review changes.
5. Confirm the staged path set is exactly the owned path set, commit once with `feat: add control-room truth presentation kernel`, and do not push or merge.
