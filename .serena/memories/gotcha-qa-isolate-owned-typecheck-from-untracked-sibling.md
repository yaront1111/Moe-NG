# Gotcha: a sibling's untracked files turn a package gate RED — isolate, never stash

Hit during QA of `task-c9a9bf3cb2` (`@moe/mcp`). `pnpm --filter @moe/mcp typecheck` was RED
with 5 TS errors. All 5 were in `packages/mcp/src/http/http-server.test.ts` — a sibling
task's work-in-progress, **100% untracked** (`git ls-files packages/mcp/src/http` -> 0
files), mid-write while I reviewed. Zero errors in the reviewed surface.

Package `tsconfig.json` uses `"include": ["src/**/*.ts"]`, so any half-finished file a
sibling drops into `src/` fails the whole package gate. Same for `vitest run <pkg>/src`.

## Rule

Do NOT `git stash`, move, rename, or delete the sibling's files to get the gate green —
that is uncommitted foreign work with no recovery point, and the repo rails forbid it.
Attribute the failure, then prove the OWNED surface independently.

## Isolation recipe (throwaway tsconfig in `%TEMP%`, nothing lands in the repo)

```json
{
  "extends": "D:/projexts/moe-next/tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "D:/projexts/moe-next/packages/<pkg>/src",
    "skipLibCheck": true,
    "tsBuildInfoFile": "C:/Users/<u>/AppData/Local/Temp/<pkg>-owned.tsbuildinfo",
    "types": ["node"],
    "typeRoots": ["D:/projexts/moe-next/node_modules/@types"]
  },
  "include": ["<absolute paths to the owned files only>"]
}
```

`typeRoots` is MANDATORY and non-obvious: tsc resolves `types: ["node"]` by walking
`node_modules/@types` upward **from the tsconfig's own directory**, so a config parked in
`%TEMP%` fails with `TS2688: Cannot find type definition file for 'node'` before it reaches
a single source line. Point `typeRoots` at the repo's `@types` and it compiles.

Then `npx tsc --project <temp>/owned-tsconfig.json` and `npx vitest run <pkg>/src/<owned-dir>`.
Delete the temp files afterwards. Record BOTH results in the verdict: the raw package gate
and the isolated owned gate, with the foreign attribution proven by `git ls-files`.

Corollary: re-run the declared verification command once more at the end. The sibling
committed its missing module minutes later and the package gate went green unaided —
a RED you attribute correctly can resolve itself while you review.

See `mem:gotcha-dependency-gate-uncommitted-siblings`,
`mem:task-task-c9a9bf3cb2a046a68ee99efa5b296f8c-qa-verdict`.
