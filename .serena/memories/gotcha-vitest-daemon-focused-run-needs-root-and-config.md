# A focused daemon vitest run silently selects the WRONG config

`apps/daemon/package.json` has `"test": "vitest run --root . --config package.json src"`.
The repo-root `vitest.config.ts` has
`include: ["adapters/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"]`
— **`apps/**` is not in it.**

So this, the form task descriptions keep quoting:

```
pnpm --filter @moe/daemon exec vitest run src/recovery/recovery-incarnation.test.ts
```

exits **1** with `No test files found`, because `--filter` sets the cwd but
vitest still resolves the root config. The valid focused form is:

```
pnpm --filter @moe/daemon exec vitest run --root . --config package.json <paths>
```

Two failure modes this creates:

- A worker reads `No test files found` as "my test file is broken" and starts
  debugging a file that is fine.
- Worse, a worker "fixes" it by dropping the path filter and running the whole
  package, or reports the named command as failing when the code is green.

Note the opposite trap exists in the apps that need a jsdom environment — see
`mem:vitest-focused-run-config-path-doubles`. For `@moe/daemon` (node
environment) `--root . --config package.json` is correct and is exactly what the
package's own `test` script uses.

Also: every production module under `apps/daemon/src/**` has a sibling `.js`
bridge containing `export * from "./<name>.ts";`. A NEW module without its
bridge fails at runtime with `Cannot find module ./<name>.js` even though tsc is
green — the type checker resolves the `.ts`, the runtime resolves the bridge.
