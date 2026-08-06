# Pre-Freeze Foundation Spike Implementation Plan

**Goal:** Create an independently testable, provisional Moe Next repository with deterministic evidence primitives and no disputed product behavior.

**Architecture:** A strict pnpm modular monolith keeps declarative contracts and test infrastructure separate from future production packages. This slice implements canonical byte generation and SHA-256 evidence identity because approvals, manifests, receipts, replay, and frozen inputs all depend on those primitives. Benchmark corpus content and production orchestration remain outside this slice.

**Tech Stack:** Node.js 24.16.0, TypeScript 7.0.2, pnpm 11.0.8, Vitest 4.1.10.

---

### Task 1: Bootstrap the independent workspace

**Files:**

- Create: `.gitattributes`
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `.node-version`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`

- [ ] Configure pnpm policy in `pnpm-workspace.yaml`; `.npmrc` is reserved for registry/authentication settings.
- [ ] Initialize Git with `git init -b main` after `.gitattributes` exists.
- [ ] Run `pnpm install`, expect exit 0 and a new exact `pnpm-lock.yaml`.
- [ ] Run `pnpm exec tsc --version`, expect `Version 7.0.2`.
- [ ] Stage only the listed root files and lockfile, inspect the staged diff, and commit `chore: bootstrap phase-one workspace`.

### Task 2: Specify canonical JSON bytes

**Files:**

- Create: `packages/testkit/package.json`
- Create: `packages/testkit/tsconfig.json`
- Create: `packages/testkit/src/canonical-json.test.ts`
- Create after the failing test: `packages/testkit/src/canonical-json.ts`
- Create after the failing test: `packages/testkit/src/index.ts`

- [ ] Write a test that requires recursively sorted object keys, preserved array order, JSON-compatible scalar encoding, and rejection of unsupported values.
- [ ] Run `pnpm test:meta`, expect a focused assertion failure because the canonicalizer is absent.
- [ ] Implement only the canonicalizer required by the test.
- [ ] Run `pnpm test:meta`, expect all canonical JSON tests to pass.
- [ ] Run `pnpm typecheck`, expect exit 0.

### Task 3: Specify content-addressed evidence identity

**Files:**

- Create: `packages/testkit/src/evidence-digest.test.ts`
- Create after the failing test: `packages/testkit/src/evidence-digest.ts`
- Modify: `packages/testkit/src/index.ts`

- [ ] Write a test requiring lowercase SHA-256 of exact bytes and the path `objects/sha256/{first-two-hex}/{full-digest}`.
- [ ] Run `pnpm test:meta`, expect a focused assertion failure because evidence hashing is absent.
- [ ] Implement byte hashing without filesystem writes.
- [ ] Run `pnpm verify:foundation`, expect typecheck and all meta tests to pass.
- [ ] Stage only `packages/testkit` and this plan, inspect the staged diff, and commit `test: add deterministic evidence primitives`.

### Task 4: Freeze-review integration boundary

**Files:**

- Create after Fable and Moe finish: `docs/evidence/phase-0/manifest.json`
- Create after Fable and Moe finish: `docs/evidence/phase-0/freeze-decision.json`

- [ ] Verify the final benchmark and design hashes rather than capturing an in-progress revision.
- [ ] Require the independent review artifact to end in `FREEZE_READY`.
- [ ] Capture the six source documents as exact content-addressed objects.
- [ ] Bind the manifest, review verdict, target path, and Yaron authorization digest in `freeze-decision.json`.
- [ ] Keep confirmatory benchmark fixtures absent from Phase 1 engineering fixtures.
