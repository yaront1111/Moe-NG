# Convention: materialize workspace deps as node_modules junctions, never touch pnpm-lock.yaml

Found 2026-08-08 on `task-f837ce45` while scaffolding `packages/coordination`, whose owned
paths were `packages/coordination/**` — so `pnpm-lock.yaml` was OUT of scope, while the package
genuinely needed `@moe/contracts` and `@moe/store` to resolve.

## How this repo actually links workspace packages

There is **no root `node_modules/@moe/`**. Each consumer gets its own directory with NTFS
**junctions** to sibling package roots:

```
packages/core/node_modules/@moe/contracts -> D:\projexts\moe-next\packages\contracts   (Junction)
```

Packages with no cross-package imports (`@moe/store`, `@moe/scheduler`, `@moe/contracts`) have
no `node_modules` at all.

## The move

Declare the deps in your own `package.json` (owned), then create the junctions by hand. No
install, no lockfile write, nothing outside your owned paths:

```powershell
$base = "D:\projexts\moe-next\packages\<pkg>\node_modules\@moe"
New-Item -ItemType Directory -Force -Path $base | Out-Null
foreach ($p in @("contracts","core","store")) {
  $link = Join-Path $base $p
  if (-not (Test-Path $link)) {
    New-Item -ItemType Junction -Path $link -Target "D:\projexts\moe-next\packages\$p" | Out-Null
  }
}
```

`node_modules/` is gitignored, so nothing enters the commit. Verify with
`git status --porcelain -- pnpm-lock.yaml` returning empty before you commit.

Both `tsc --project` (NodeNext) and vitest resolve `@moe/<pkg>` through the junction to the
package's `exports: { ".": "./src/index.ts" }`. No build step exists; packages are consumed as
source.

## Why not `pnpm install`

`pnpm install --lockfile=false --ignore-scripts` is the sanctioned fallback, but on a shared
working directory with concurrent agents it rewrites `node_modules` tree-wide and can disturb
siblings mid-run. The junctions are surgical and reversible.

## New-package checklist (mirror `packages/store`)

- `package.json`: `"type": "module"`, `exports: { ".": "./src/index.ts" }`,
  `typecheck: "tsc --project tsconfig.json"`,
  `test: "vitest run --root ../.. packages/<pkg>/src"`.
- `tsconfig.json`: extends `../../tsconfig.base.json`, `rootDir: "src"`, own
  `tsBuildInfoFile`, `types: ["node"]`, `include: ["src/**/*.ts"]`.
- **A one-line `.js` bridge for every non-test, non-entrypoint `.ts`** —
  `export * from "./<name>.ts";`. See `mem:gotcha-vitest-hides-missing-js-bridge`.
- A plain-Node Worker smoke test importing `./index.ts` under `--experimental-strip-types`, and
  prove it is not vacuous by deleting one bridge and confirming that test — and only that
  test — goes red.

Related: `mem:task-task-f837ce45bd344b868ad84e72ffc549f2-handoff`,
`mem:gotcha-missing-runtime-bridge-invisible-to-vitest`.
